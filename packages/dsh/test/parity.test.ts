import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { describe, expect, it } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { agentFor, conversation, harness, MODEL } from './harness.js'

const signal = new AbortController().signal

/** The host backend with a stub summarizer: the oracle for when it triggers and what it selects. */
class HostOracle extends BasicCompactionEngine {
  protected override summarize(): ReturnType<BasicCompactionEngine['summarize' & keyof BasicCompactionEngine]> {
    throw new Error('replaced below')
  }
}
Object.defineProperty(HostOracle.prototype, 'summarize', {
  value: () => Promise.resolve({ summary: [{ type: 'text', text: 'oracle summary' }], provider: 'oracle', model: 'oracle' }),
})

const CASES: ReadonlyArray<readonly [string, BasicCompactionConfig, 'pressure' | 'context-overflow']> = [
  ['defaults', {}, 'pressure'],
  ['no retained tail', { retainTokens: 0 }, 'pressure'],
  ['a tail of about one observation', { retainTokens: 1_300 }, 'pressure'],
  ['a tail of half the window', { retainRatio: 0.5 }, 'pressure'],
  ['a threshold just under the current pressure (9,054 of 10,000)', { thresholdRatio: 0.9 }, 'pressure'],
  ['a threshold just over the current pressure', { thresholdRatio: 0.91 }, 'pressure'],
  ['a threshold above the current pressure', { thresholdRatio: 0.95 }, 'pressure'],
  ['a lower threshold and a small ratio tail', { thresholdRatio: 0.7, retainRatio: 0.05 }, 'pressure'],
  ['an exact-model override that lowers the threshold', { modelPolicies: [{ provider: MODEL, model: MODEL, thresholdRatio: 0.6, retainTokens: 0 }] }, 'pressure'],
  ['an exact-model override that raises it', { modelPolicies: [{ provider: MODEL, model: MODEL, thresholdRatio: 0.95 }] }, 'pressure'],
  ['an override for another model, which must not apply', { modelPolicies: [{ provider: 'other', model: 'other', thresholdRatio: 0.95 }] }, 'pressure'],
  ['overflow, defaults', {}, 'context-overflow'],
]

describe('trigger and retention parity with the host backend (drift guard)', () => {
  it.each(CASES)('%s', async (_label, config, trigger) => {
    const host = await harness(10_000)
    await host.plugin(HostOracle, { ...config, auto: false })
    const hosted = conversation(host, { openTurn: true })
    const outcome = await host.compaction.compactIfNeeded(agentFor(hosted.session), trigger, signal)
    const hostRegion = new Set(outcome?.shadowedSeqs ?? [])

    const ours = await harness(10_000)
    await ours.plugin(MaskpointCompactionEngine, { ...config, auto: false })
    const masked = conversation(ours, { openTurn: true })
    await ours.compaction.compactIfNeeded(agentFor(masked.session), trigger, signal)
    const maskedSeqs = masked.session.events.flatMap((event) => (event.type === 'compaction/prune' ? event.data.shadowedSeqs : []))

    // Same trigger, same retained window: we mask exactly the observations the host would have compacted.
    expect(new Set(maskedSeqs)).toEqual(new Set(hosted.observationSeqs.filter((seq) => hostRegion.has(seq))))
  })

  it('agrees when the retained tail lands exactly on the budget', async () => {
    const probe = await harness(10_000)
    const priced = probe.tokenMeter.measure(conversation(probe, { openTurn: true }).session).nodes
    // Exactly the last two nodes (the open turn's prompt and the closing message before it): a tail
    // that is met, not exceeded, by them. Whether the next node up is retained decides if the newest
    // observation is masked.
    const retainTokens = priced.at(-1)!.tokens + priced.at(-2)!.tokens

    const host = await harness(10_000)
    await host.plugin(HostOracle, { retainTokens, auto: false })
    const hosted = conversation(host, { openTurn: true })
    const outcome = await host.compaction.compactIfNeeded(agentFor(hosted.session), 'pressure', signal)

    const ours = await harness(10_000)
    await ours.plugin(MaskpointCompactionEngine, { retainTokens, auto: false })
    const masked = conversation(ours, { openTurn: true })
    await ours.compaction.compactIfNeeded(agentFor(masked.session), 'pressure', signal)
    const maskedSeqs = masked.session.events.flatMap((event) => (event.type === 'compaction/prune' ? event.data.shadowedSeqs : []))

    expect(hosted.observationSeqs.every((seq) => outcome!.shadowedSeqs.includes(seq))).toBe(true)
    expect(new Set(maskedSeqs)).toEqual(new Set(hosted.observationSeqs))
  })

  it('exercises both outcomes, so the guard is not vacuous', async () => {
    const triggered = new Set<boolean>()
    for (const [, config, trigger] of CASES) {
      const host = await harness(10_000)
      await host.plugin(HostOracle, { ...config, auto: false })
      const { session } = conversation(host, { openTurn: true })
      triggered.add((await host.compaction.compactIfNeeded(agentFor(session), trigger, signal)) !== null)
    }
    expect(triggered).toEqual(new Set([true, false]))
  })
})
