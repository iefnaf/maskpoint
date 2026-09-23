import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  accounting,
  agentFor,
  appendClosedTurn,
  closedRegion,
  conversation,
  DEFAULT_USAGE,
  MODEL,
  observationBody,
  replies,
  scriptedHarness,
  sequence,
  surfaceText,
  TightBudget,
} from './harness.js'

const signal = new AbortController().signal

const CHECKPOINT = '## User context and constraints\n- run the steps and report\n\n## Next steps\n- none'

function summaryOf(session: Session, result: CompactionResult) {
  const event = session.events[result.summarySeq]!
  if (event.type !== 'compaction/summary') throw new Error('expected compaction/summary')
  return event.data
}

describe('the checkpoint path, explicit idle-session compaction', () => {
  it('makes one call through the host LLM seam when the candidate is over budget, and records its envelope durably', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const before = accounting(ctx, session)
    const from = session.events.length

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    expect(result).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])

    // The envelope of the call that wrote the checkpoint: who, how much was allowed, what it cost.
    const summary = summaryOf(session, result!)
    expect({ provider: summary.provider, model: summary.model, maxTokens: summary.maxTokens }).toEqual({
      provider: MODEL,
      model: MODEL,
      maxTokens: 8192,
    })
    expect(summary.usage).toEqual(DEFAULT_USAGE)
    // Marked as a call through the host's LLM seam, with the model's exact output kept.
    expect(summary.llmStreamCall).toBe(true)
    expect(summary.rawOutput).toEqual([{ type: 'text', text: CHECKPOINT }])
    expect(summary.summary).toEqual([{ type: 'text', text: CHECKPOINT }])

    // Recognized by host consumers as a compaction checkpoint, and what the model now sees.
    const replacement = session.events.findLast((event) => event.type === 'user/message')!
    expect(replacement.type === 'user/message' && isCompactCheckpointSource(replacement.data.source)).toBe(true)
    const text = surfaceText(session)
    expect(text).toContain(CHECKPOINT)
    expect(text).not.toContain('line of build output')
    expect(text).not.toContain('please run step 1 and report')

    // The host's accounting agrees and the total fell by exactly the priced delta.
    const priced = ctx.tokenMeter.measure(session).nodes.find((node) => node.seq === replacement.seq)!.tokens
    const after = accounting(ctx, session)
    expect(after.total).toBe(before.total + priced - result!.shadowedTokenCount)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.total).toBeLessThan(before.total)
  })
})

describe('the checkpoint path, explicit region compaction', () => {
  it('makes the checkpoint call for compactRegion too, inside the open turn', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    const { start, end } = closedRegion(session)

    const result = await ctx.compaction.compactRegion(start, end, agentFor(session))

    expect(calls).toHaveLength(1)
    const summary = summaryOf(session, result)
    expect({ provider: summary.provider, model: summary.model }).toEqual({ provider: MODEL, model: MODEL })
    expect(summary.llmStreamCall).toBe(true)
    const text = surfaceText(session)
    expect(text).toContain(CHECKPOINT)
    // The retained tail (the open turn's prompt) is untouched.
    expect(text).toContain('now compact and continue')
  })
})

describe('checkpoint routing', () => {
  it('uses a configured summarization model instead of the session model, and its configured generation cap', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT), { providers: ['other-provider'] })
    await ctx.plugin(TightBudget, {
      auto: false,
      summarizationProvider: 'other-provider',
      summarizationModel: 'other-model',
      maxTokens: 500,
    })
    const { session } = conversation(ctx, { openTurn: false })

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'other-provider', model: 'other-model', maxTokens: 500 })
    const summary = summaryOf(session, result!)
    expect({ provider: summary.provider, model: summary.model, maxTokens: summary.maxTokens }).toEqual({
      provider: 'other-provider',
      model: 'other-model',
      maxTokens: 500,
    })
  })

  it('exposes no agent tools and disables the checkpoint call from acting', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([])
  })

  it('sends a fresh routing identity per call, not the session id', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBeDefined()
    expect(calls[0]!.sessionId).not.toBe(session.id)
  })

  it("carries the host's own cancellation signal into the call, live, not a snapshot", async () => {
    const controller = new AbortController()
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), controller.signal)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal?.aborted).toBe(false)
    // The exact signal handed to the call still reflects the host's own controller afterward: it
    // is the live signal forwarded through, not a copy taken at call time.
    controller.abort()
    expect(calls[0]!.signal?.aborted).toBe(true)
  })
})

describe('checkpoint rejection falls back to masked history', () => {
  const PARTIAL = '## User context and constraints\n- cut off mid-sente'

  it.each([
    ['a provider error', () => replies.providerError('rate limited')],
    ['an abort', () => replies.aborted()],
    ['a length-cap truncation', () => replies.lengthStop(PARTIAL)],
    ['a tool call', () => replies.toolCall()],
    ['empty text', () => replies.empty()],
  ] as const)('lands the model-free masked-history summary when the checkpoint call ends in %s', async (_label, reply) => {
    const { ctx, calls } = await scriptedHarness(reply)
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const from = session.events.length

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    // The call was attempted exactly once; its rejection did not stop the compaction.
    expect(result).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])

    // Honest fallback: the masked-history envelope, not the rejected call's.
    const summary = summaryOf(session, result!)
    expect({ provider: summary.provider, model: summary.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    expect(summary.llmStreamCall).toBeUndefined()
    expect(summary.usage).toBeUndefined()

    // Never partial: whatever text the rejected call produced never reaches the surface.
    const text = surfaceText(session)
    expect(text).not.toContain('cut off mid-sente')
    expect(text).not.toContain('User context and constraints')
    // Never empty: the observations are still there, as placeholders.
    expect(text).toMatch(/\[tool result omitted: bash, ok, 200 lines, \d+ chars \(recall id:\S+\)\]/)
  })
})

describe('checkpoint observability', () => {
  it('logs the checkpoint strategy, the model that wrote it, and its usage', async () => {
    const { ctx } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    const info = vi.spyOn(ctx.logger, 'info')
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    const lines = info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      new RegExp(`^maskpoint \\(explicit\\): strategy checkpoint, candidate ~\\d+ tokens, checkpoint via ${MODEL}/${MODEL}, usage 900 in / 120 out$`),
    )
  })

  it('warns why the checkpoint was rejected, then logs the masked-history fallback', async () => {
    const { ctx } = await scriptedHarness(() => replies.providerError('rate limited'))
    await ctx.plugin(TightBudget, { auto: false })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const info = vi.spyOn(ctx.logger, 'info')
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'maskpoint (explicit): checkpoint provider-error; falling back to masked history',
    ])
    const lines = info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^maskpoint \(explicit\): strategy mask, 3 observations masked, \d+ chars omitted, candidate ~\d+ tokens, no checkpoint$/)
  })
})

describe('further checkpoint rejections', () => {
  it('degrades to masked history without a network call when no summarizer and no routed model are available', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text(CHECKPOINT))
    await ctx.plugin(TightBudget, { auto: false })
    // No `request/header` and no agent-options fallback: nothing to route the checkpoint call to.
    const session = ctx.sessions.create('unrouted' as never)
    appendClosedTurn(session, 1, observationBody(1), undefined, { unrouted: true })
    appendClosedTurn(session, 2, observationBody(2))
    appendClosedTurn(session, 3, observationBody(3))

    const result = await ctx.compaction.compactNow(agentFor(session, undefined, {}), signal)

    expect(result).not.toBeNull()
    expect(calls).toHaveLength(0)
    const summary = summaryOf(session, result!)
    expect({ provider: summary.provider, model: summary.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    expect(surfaceText(session)).toMatch(/\[tool result omitted: bash, ok, 200 lines, \d+ chars \(recall id:\S+\)\]/)
  })

  it('rejects an image checkpoint response, the same as the host itself, and falls back to masked history', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.image())
    await ctx.plugin(TightBudget, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    expect(calls).toHaveLength(1)
    const summary = summaryOf(session, result!)
    expect({ provider: summary.provider, model: summary.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    expect(summary.llmStreamCall).toBeUndefined()
  })
})
