import { budgetOf, DEFAULT_ENGINE_CONFIG, type ConversationSnapshot, type Stats } from '@maskpoint/core'
import { planCompaction, type PiContext } from '@maskpoint/pi'
import MaskpointCompactionEngine from '@maskpoint/dsh'
import { buildDshMessages } from '../../src/dsh-encoding.js'
import { buildPiEvent } from './pi-encoding.js'

/**
 * A minimal `PiContext`: no model configured, so a checkpoint call (issue #7) always falls back to
 * masked history rather than actually calling a provider — this harness compares the zero-LLM
 * masking path, the same one DSH's `summarize()` call below never leaves either.
 */
function fakePiContext(): PiContext {
  return {
    hasUI: false,
    ui: { notify: () => {} },
    model: undefined,
    modelRegistry: { complete: () => Promise.reject(new Error('host-runs: no checkpoint call is expected in this harness')) },
  }
}

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
export async function runPi(snapshot: ConversationSnapshot): Promise<HostRun> {
  const effect = await planCompaction(buildPiEvent(snapshot), fakePiContext())
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
 * The config `resolveConfig()` (unexported, so restated) would produce from no plugin config at
 * all: every `CompactionPolicyConfig` default from `@deepseek-ai/dsh-compaction-basic`'s own
 * doc-comments. An empty `summarizationProvider`/`summarizationModel` means "inherit the
 * conversation's own route" (`resolveSummarizer`), which the fake agent below leaves unset — the
 * same "no model configured, so a checkpoint always falls back to masked history" choice as
 * `fakePiContext` above.
 */
const FAKE_RESOLVED_CONFIG = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 8192,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  modelPolicies: [],
  auto: true,
}

/**
 * Drives the DSH adapter's real, exported `summarize()` over a synthetic region, the same method
 * the host's compaction transaction calls. It reads `this.ctx.logger`, `this.ctx.llm`, `this.budget`,
 * `this.config` (the host's own `ResolvedConfig`), (issue #8) `this.maskpointConfig`, and calls
 * `this.infoLog` (a private instance method, restated on the fake since nothing here goes through
 * `new`), plus `agent.session.requestHeader()` and `agent.options` — so it is called unbound against
 * a minimal fake engine carrying all of those and a minimal fake `Agent`, instead of a full cordis
 * host (dsh's own conformance suite, `packages/dsh/test/`, is what exercises the surrounding
 * transaction). No route is ever configured on the fake agent, so `resolveSummarizer` always yields
 * no route and a checkpoint call is never actually made — the same zero-LLM masking path
 * `fakePiContext` targets.
 */
export async function runDsh(snapshot: ConversationSnapshot): Promise<HostRun> {
  const input = buildDshMessages(snapshot)
  const info: string[] = []
  const fakeEngine = {
    ctx: {
      logger: { info: (message: string) => info.push(message), warn: () => {} },
      llm: { stream: () => Promise.reject(new Error('host-runs: no checkpoint call is expected in this harness')) },
    },
    maskpointConfig: DEFAULT_ENGINE_CONFIG,
    budget: budgetOf(DEFAULT_ENGINE_CONFIG),
    config: FAKE_RESOLVED_CONFIG,
    // `summarize()` calls `this.infoLog` (issue #8's notification-level gate), a private instance
    // method that only exists on a real `MaskpointCompactionEngine` — restated here since this
    // harness calls `summarize` unbound against a plain object, never through `new`.
    infoLog(message: string) {
      if (this.maskpointConfig.notificationLevel !== 'silent') this.ctx.logger.info(message)
    },
  }
  const fakeAgent = { session: { requestHeader: () => undefined }, options: {} }
  const summarize = (MaskpointCompactionEngine.prototype as unknown as { summarize: (...args: unknown[]) => Promise<{ summary: { type: string; text?: string }[] }> }).summarize

  try {
    const result = await summarize.call(fakeEngine, input, fakeAgent, new AbortController().signal)
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
