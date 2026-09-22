import { DEFAULT_ENGINE_CONFIG, type ConversationSnapshot, type Stats } from '@maskpoint/core'
import { planCompaction } from '@maskpoint/pi'
import MaskpointCompactionEngine from '@maskpoint/dsh'
import { buildDshMessages } from './dsh-encoding.js'
import { buildPiEvent } from './pi-encoding.js'

/**
 * What both adapters reduce to, so the same assertions can run over either. `outcome` uses the
 * engine's own vocabulary (`Outcome['kind']`, docs/design.md "Interfaces"): `'masked-history'` or
 * `'decline'`. Neither adapter can reach `'checkpoint'` yet (issues #7, #11), so it is not a
 * member here.
 */
export interface HostRun {
  host: 'pi' | 'dsh'
  outcome: 'masked-history' | 'decline'
  /** Set when declined: the reason, in whichever adapter's own `DeclineReason` vocabulary. */
  reason?: string
  /** Set when masked: the rendered masked-history text, in each adapter's own renderer. */
  text?: string
  stats?: Stats
}

/** Drives the Pi adapter's real, exported `planCompaction` over a synthetic recording. */
export function runPi(snapshot: ConversationSnapshot): HostRun {
  const effect = planCompaction(buildPiEvent(snapshot))
  if (effect.kind === 'decline') return { host: 'pi', outcome: 'decline', reason: effect.reason }
  return { host: 'pi', outcome: 'masked-history', text: effect.summary, stats: effect.detail.stats }
}

// The statistics `MaskpointCompactionEngine.summarize()` logs (packages/dsh/src/engine.ts). Reading
// them back from the log, rather than duplicating `normalizeMessages` + `decide` here, keeps this
// harness driving the adapter's real code path instead of a second copy of its logic.
const STRATEGY_LINE =
  /^maskpoint \(explicit\): strategy mask, (\d+) observations masked, (\d+) chars omitted, candidate ~(\d+) tokens, no checkpoint$/
const DECLINE_ERROR = /^maskpoint: cannot mask this region \((.+)\)$/

/**
 * Drives the DSH adapter's real, exported `summarize()` over a synthetic region, the same method
 * the host's compaction transaction calls. It reads `this.ctx.logger`, `this.budget` and (issue #8)
 * `this.maskpointConfig`, so it is called unbound against a minimal fake context carrying those
 * three, instead of a full cordis host (dsh's own conformance suite, `packages/dsh/test/`, is what
 * exercises the surrounding transaction).
 */
export async function runDsh(snapshot: ConversationSnapshot): Promise<HostRun> {
  const input = buildDshMessages(snapshot)
  const info: string[] = []
  const fakeEngine = {
    ctx: { logger: { info: (message: string) => info.push(message), warn: () => {} } },
    maskpointConfig: DEFAULT_ENGINE_CONFIG,
    budget: { checkpointTriggerTokens: DEFAULT_ENGINE_CONFIG.checkpointTriggerTokens },
  }
  const summarize = (MaskpointCompactionEngine.prototype as unknown as { summarize: (...args: unknown[]) => Promise<{ summary: { type: string; text?: string }[] }> }).summarize

  try {
    const result = await summarize.call(fakeEngine, input, undefined, new AbortController().signal)
    const line = info.find((each) => STRATEGY_LINE.test(each))
    const match = line === undefined ? null : STRATEGY_LINE.exec(line)
    if (match === null) throw new Error(`dsh-run: no statistics line in the log (${JSON.stringify(info)})`)
    const [, observationsMasked, charsOmitted, candidateTokens] = match as unknown as [string, string, string, string]
    const text = result.summary.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
    return {
      host: 'dsh',
      outcome: 'masked-history',
      text,
      stats: {
        observationsMasked: Number(observationsMasked),
        charsOmitted: Number(charsOmitted),
        candidateTokens: Number(candidateTokens),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = DECLINE_ERROR.exec(message)
    if (match === null) throw error
    return { host: 'dsh', outcome: 'decline', reason: match[1]! }
  }
}
