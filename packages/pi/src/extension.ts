import { budgetOf, type NotificationLevel } from '@maskpoint/core'
import { planCompaction, type PiEffect, toPiResult } from './compact.js'
import { flagSpecs, loadConfig, readFlags } from './config.js'
import type { PiBeforeCompactEvent, PiCompactionResult, PiContext, PiExtensionApi } from './host.js'

/** One line saying what happened, in the statistics' own words. Structure and counts only, never content. */
function announcement(effect: PiEffect): string {
  if (effect.kind === 'decline') {
    const why = effect.note === undefined ? effect.reason : `${effect.reason}: ${effect.note}`
    return `Maskpoint declined (${why}); Pi's own compactor will run.`
  }
  const { observationsMasked, charsOmitted, candidateTokens } = effect.detail.stats
  const noun = observationsMasked === 1 ? 'observation' : 'observations'
  const masked = `Maskpoint masked ${observationsMasked} ${noun} (${charsOmitted} chars omitted), ~${candidateTokens} tokens kept`
  if (effect.detail.strategy === 'checkpoint') return `${masked}, condensed into a checkpoint with one model call.`
  if (effect.checkpointRejection !== undefined) {
    return `${masked}, no model call. A checkpoint was attempted (${effect.checkpointRejection}) and not accepted; masked history was kept instead.`
  }
  return `${masked}, no model call.`
}

/** A decline always surfaces (it is the "something didn't happen" case); routine results respect `notificationLevel`. */
function report(ctx: PiContext, effect: PiEffect, notificationLevel: NotificationLevel): void {
  if (!ctx.hasUI) return
  if (effect.kind !== 'decline' && notificationLevel === 'silent') return
  try {
    ctx.ui.notify(announcement(effect), effect.kind === 'decline' ? 'warning' : 'info')
  } catch {
    // Telling the user is a courtesy; it can never cost the session its compaction.
  }
}

/**
 * Maskpoint's Pi extension. Pi's pre-compaction event fires for manual, threshold and overflow
 * compaction alike, and a returned result replaces the summarize step, so masked history lands with
 * no model call. Returning nothing leaves Pi's own compactor in charge, which is what every failure
 * path here does: a session is never left without a compaction result.
 */
export default function maskpoint(pi: PiExtensionApi): void {
  // Pi hands an extension no settings of its own (issue #39), so every setting also has a CLI flag:
  // registering them is what puts them in `pi --help` and in this run's parsed command line.
  for (const flag of flagSpecs()) pi.registerFlag(flag.name, { description: flag.description, type: 'string' })

  pi.on('session_before_compact', async (event: PiBeforeCompactEvent, ctx: PiContext): Promise<PiCompactionResult | undefined> => {
    // A compaction that was cancelled before it reached us has nothing to gain from our work.
    if (event.signal?.aborted) return undefined
    // Both operator channels are read here rather than when the extension loads: Pi parses its
    // command line after this factory returns, so `getFlag` answers `undefined` to a flag read at
    // load time (measured against a real release — the value is there by the time a handler runs).
    const config = loadConfig({ env: process.env, flags: readFlags((name) => pi.getFlag(name)), host: ctx.config }, (message) => {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`Maskpoint ${message}`, 'warning')
        } catch {
          // A courtesy, never a reason to fail the compaction.
        }
      }
    })
    // Disabled: return nothing, exactly the documented fallback, so Pi's own compactor runs with no
    // trace of Maskpoint in the result (docs/spec.md, Configuration — "disable Maskpoint...").
    if (!config.enabled) return undefined

    const budget = budgetOf(config)
    const effect = await planCompaction(event, ctx, { budget })
    report(ctx, effect, config.notificationLevel)
    return effect.kind === 'native' ? toPiResult(effect) : undefined
  })
}
