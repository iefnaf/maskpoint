import { candidateTokens, type ConversationSnapshot, type Item } from '@maskpoint/core'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { CorpusFixture } from './corpus.js'
import { featuresOf, type Feature } from './coverage.js'
import { buildDshMessages } from './dsh-encoding.js'
import { boundaryIndex, representedThroughIndex } from './items.js'

/**
 * DSH's own token meter (docs/design.md, Open issues #5: "compare estimates against host-provided
 * meters"). `estimateMessage` prices one message under DSH's fixed heuristic and, unlike
 * `measure()`, touches no session state -- `this` never appears in its body (confirmed against
 * `@deepseek-ai/dsh-token-meter`'s compiled source: the instance method is a bare delegate to a
 * module-scope pure function) -- so it is called unbound rather than through a full
 * `ctx.plugin(TokenMeter)` registration. No cordis host is available here, the same reason
 * `test/support/host-runs.ts` calls DSH's `summarize` unbound against a minimal fake.
 */
const priceMessage = TokenMeter.prototype.estimateMessage

/** DSH's own heuristic total for the raw region a compaction would hand `summarize()`. */
function hostMeterTokens(snapshot: ConversationSnapshot): number {
  const { messages } = buildDshMessages(snapshot)
  return messages.reduce((total, message) => total + priceMessage(message), 0)
}

/**
 * The raw items a compaction would evict, before masking: previous checkpoint excluded (carried
 * separately), boundary excluded, over the identical span `buildDshMessages` walks so both sides of
 * the comparison price the same content.
 */
function evictedRawItems(snapshot: ConversationSnapshot): Item[] {
  const represented = representedThroughIndex(snapshot)
  const boundary = boundaryIndex(snapshot)
  return snapshot.items.slice(represented + 1, boundary).filter((item) => item.kind !== 'checkpoint')
}

/**
 * The internal estimator's reading of the same raw region, via `candidateTokens` -- the exact
 * function `decide`'s budget gate calls (docs/design.md, "Budget") -- but applied to the raw
 * evicted items rather than their masked replacements. Comparing post-mask candidate size against
 * DSH's pre-mask meter reading would conflate two different questions: how much masking shrinks the
 * region (already reported by `charsOmitted`/`observationsMasked`) versus whether `estimateTokens`'s
 * own per-character weighting agrees with DSH's. Pricing the same raw region on both sides isolates
 * the second question, which is what this open issue asks about.
 */
export function rawRegionTokens(snapshot: ConversationSnapshot): number | undefined {
  const previous = snapshot.previousCheckpoint === '' ? undefined : snapshot.previousCheckpoint
  const items = evictedRawItems(snapshot)
  if (previous === undefined && items.length === 0) return undefined
  return candidateTokens(previous, items)
}

export interface CalibrationResult {
  fixture: string
  features: readonly Feature[]
  /** The internal estimator's candidate-token total for the raw region. */
  estimator: number
  /** DSH's own token-meter total for the identical raw region. */
  hostMeter: number
  /** `hostMeter - estimator`: positive means the internal estimator reads lower than DSH's own heuristic. */
  divergence: number
  /** `divergence` as a fraction of `hostMeter`; `undefined` when `hostMeter` is 0. */
  relativeDivergence: number | undefined
}

/** Compare the internal estimator against DSH's host meter for one fixture's raw region, or `undefined` if it has nothing to compact. */
export function calibrate(fixture: Pick<CorpusFixture, 'name' | 'snapshot'>): CalibrationResult | undefined {
  const estimator = rawRegionTokens(fixture.snapshot)
  if (estimator === undefined) return undefined
  const hostMeter = hostMeterTokens(fixture.snapshot)
  const divergence = hostMeter - estimator
  return {
    fixture: fixture.name,
    features: [...featuresOf(fixture.snapshot)],
    estimator,
    hostMeter,
    divergence,
    relativeDivergence: hostMeter === 0 ? undefined : divergence / hostMeter,
  }
}

/** `calibrate` over every fixture in the corpus, skipping any with nothing to compact. */
export function calibrateCorpus(corpus: readonly CorpusFixture[]): CalibrationResult[] {
  return corpus.map(calibrate).filter((result): result is CalibrationResult => result !== undefined)
}
