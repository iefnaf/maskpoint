import { planCompaction, type PiEffect, toPiResult } from './compact.js'
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

function report(ctx: PiContext, effect: PiEffect): void {
  if (!ctx.hasUI) return
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
  pi.on('session_before_compact', async (event: PiBeforeCompactEvent, ctx: PiContext): Promise<PiCompactionResult | undefined> => {
    // A compaction that was cancelled before it reached us has nothing to gain from our work.
    if (event.signal?.aborted) return undefined
    const effect = await planCompaction(event, ctx)
    report(ctx, effect)
    return effect.kind === 'native' ? toPiResult(effect) : undefined
  })
}
