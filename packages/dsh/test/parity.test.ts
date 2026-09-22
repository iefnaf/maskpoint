import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { describe, expect, it } from 'vitest'
import type { SummaryResult } from '../src/host-types.js'
import MaskpointCompactionEngine from '../src/index.js'
import { agentFor, conversation, harness, maskedSeqsOf, MODEL, replies, scriptedHarness, TightBudget } from './harness.js'

const signal = new AbortController().signal

/** The host backend with a stub summarizer: the oracle for when it triggers and what it selects. */
class HostOracle extends BasicCompactionEngine {
  protected override summarize(): Promise<SummaryResult> {
    return Promise.resolve({ summary: [{ type: 'text', text: 'oracle summary' }], provider: 'oracle', model: 'oracle' })
  }
}

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

    // Same trigger, same retained window: we mask exactly the observations the host would have compacted.
    expect(new Set(maskedSeqsOf(masked.session))).toEqual(new Set(hosted.observationSeqs.filter((seq) => hostRegion.has(seq))))
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

    expect(hosted.observationSeqs.every((seq) => outcome!.shadowedSeqs.includes(seq))).toBe(true)
    expect(new Set(maskedSeqsOf(masked.session))).toEqual(new Set(hosted.observationSeqs))
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

const SUMMARIZER_CASES: ReadonlyArray<readonly [string, BasicCompactionConfig]> = [
  ['defaults: the session route, the default generation cap', {}],
  ['a configured summarization provider and model', { summarizationProvider: 'other-provider', summarizationModel: 'other-model' }],
  ['a configured generation cap', { maxTokens: 500 }],
  [
    'an exact-model override for the session route',
    { modelPolicies: [{ provider: MODEL, model: MODEL, summarizationProvider: 'override-provider', summarizationModel: 'override-model', maxTokens: 250 }] },
  ],
  [
    'an override for another model, which must not apply',
    { modelPolicies: [{ provider: 'other', model: 'other', summarizationProvider: 'wrong-provider', summarizationModel: 'wrong-model' }] },
  ],
]

describe('checkpoint summarizer-target parity with the host backend (drift guard)', () => {
  it.each(SUMMARIZER_CASES)('%s', async (_label, config) => {
    const providers = ['other-provider', 'override-provider', 'wrong-provider']

    const { ctx: host, calls: hostCalls } = await scriptedHarness(() => replies.text('host summary'), { providers })
    await host.plugin(BasicCompactionEngine, { ...config, auto: false })
    await host.compaction.compactNow(agentFor(conversation(host, { openTurn: false }).session), signal)

    const { ctx: ours, calls: oursCalls } = await scriptedHarness(() => replies.text('our checkpoint'), { providers })
    await ours.plugin(TightBudget, { ...config, auto: false })
    await ours.compaction.compactNow(agentFor(conversation(ours, { openTurn: false }).session), signal)

    // The host always calls its summarizer on /compact; ours only does over budget (TightBudget
    // forces that here). Once each calls, they must resolve the exact same provider, model, and cap.
    expect(hostCalls).toHaveLength(1)
    expect(oursCalls).toHaveLength(1)
    expect({ provider: oursCalls[0]!.provider, model: oursCalls[0]!.model, maxTokens: oursCalls[0]!.maxTokens }).toEqual({
      provider: hostCalls[0]!.provider,
      model: hostCalls[0]!.model,
      maxTokens: hostCalls[0]!.maxTokens,
    })
  })
})
