import { HISTORY_FRAMING } from '@maskpoint/core'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ManualCompactionError, isCompactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { accounting, agentFor, appendClosedTurn, closedRegion, conversation, harness, MODEL, sequence, surfaceText } from './harness.js'

const signal = new AbortController().signal

describe('explicit idle-session compaction (compactNow)', () => {
  it('lands a model-free masked-history replacement between turns and keeps the host accounting exact', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const before = accounting(ctx, session)
    const from = session.events.length

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    expect(result).not.toBeNull()
    // The summary path: a bracketed start/summary/replace/end, opened with no owning turn.
    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])
    const start = session.events[result!.startSeq]!
    expect(start.type === 'compaction/start' && start.data.turn === null).toBe(true)

    // Honest authorship: a Maskpoint envelope, no summarization-call marker, no usage.
    const summary = session.events[result!.summarySeq]!
    if (summary.type !== 'compaction/summary') throw new Error('expected compaction/summary')
    expect({ provider: summary.data.provider, model: summary.data.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    expect(summary.data.llmStreamCall).toBeUndefined()
    expect(summary.data.usage).toBeUndefined()

    // Recognizable to host consumers as a compaction checkpoint.
    const replacement = session.events.findLast((event) => event.type === 'user/message')!
    expect(replacement.type === 'user/message' && isCompactCheckpointSource(replacement.data.source)).toBe(true)

    // Only observation bodies left; what the user asked and what was run is still readable.
    const text = surfaceText(session)
    expect(text).not.toContain('line of build output')
    expect(text).toContain('please run step 1 and report')
    expect(text).toContain('please run step 3 and report')
    expect(text).toContain('{"cmd":"make"}')
    expect(text).toMatch(/\[tool result omitted: bash, ok, 200 lines, \d+ chars\]/)

    // Host accounting: the priced surface, the meter total and both replay projections agree, and the
    // total fell by exactly the priced delta.
    const priced = ctx.tokenMeter.measure(session).nodes.find((node) => node.seq === replacement.seq)!.tokens
    const delta = priced - result!.shadowedTokenCount
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.surface).toBe(before.surface + delta)
    expect(after.total).toBe(before.total + delta)
    expect(after.projected).toBe(before.projected! + delta)
    expect(after.total).toBeLessThan(before.total)
  })
})

describe('explicit region compaction (compactRegion)', () => {
  it('lands inside the open turn, and shadows exactly the requested balanced span', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    const { start, end, seqs } = closedRegion(session)
    const from = session.events.length

    const result = await ctx.compaction.compactRegion(start, end, agentFor(session))

    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])
    expect(result.shadowedSeqs).toEqual(seqs)
    const opened = session.events[result.startSeq]!
    expect(opened.type === 'compaction/start' && opened.data.turn === 4).toBe(true)
    // The retained tail (the open turn's prompt) is untouched.
    expect(surfaceText(session)).toContain('now compact and continue')
  })

  it("refuses an edge that would split a tool call from its result, using the host's pairing predicates", async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session, observationSeqs } = conversation(ctx, { openTurn: true })
    const { start, end } = closedRegion(session)
    const nodes = session.surface.nodes
    // The turn-2 assistant message that issued a call: the cut after it has a call in flight.
    const call = nodes[nodes.indexOf(observationSeqs[1]!) - 1]!
    expect(toolPairingBalancedAfter(session, call)).toBe(false)
    expect(toolPairingBalancedBefore(session, observationSeqs[1]!)).toBe(false)
    const generation = session.surface.replaceGeneration
    const events = session.events.length

    await expect(ctx.compaction.compactRegion(start, call, agentFor(session))).rejects.toThrow(/not a balanced boundary/)
    await expect(ctx.compaction.compactRegion(observationSeqs[1]!, end, agentFor(session))).rejects.toThrow(/not a balanced boundary/)

    // Nothing landed and no lock was taken.
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(session.events).toHaveLength(events)
  })
})

describe('expected failures use the manual-compaction error vocabulary', () => {
  it('is busy when the session has an open turn', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })

    const failure = await ctx.compaction.compactNow(agentFor(session), signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('busy')
  })

  it('is a summary failure, with the conversation untouched and the lock released, when nothing would shrink', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    // Observations too small to be worth masking: a masked-history replacement could only grow.
    const { session } = conversation(ctx, { openTurn: false, body: () => 'ok' })
    const nodes = [...session.surface.nodes]
    const generation = session.surface.replaceGeneration
    const from = session.events.length

    const failure = await ctx.compaction.compactNow(agentFor(session), signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('summary')
    expect(session.surface.nodes).toEqual(nodes)
    expect(session.surface.replaceGeneration).toBe(generation)
    // The attempt is on the record, and closed.
    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/end'])
    const end = session.events.at(-1)!
    expect(end.type === 'compaction/end' && end.data.error !== undefined).toBe(true)
  })
})

describe('cancellation', () => {
  it("preserves the caller's abort reason and lands nothing", async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const from = session.events.length

    // The host throws on an already-aborted request before it returns a promise.
    const attempt = async () => ctx.compaction.compactNow(agentFor(session), AbortSignal.abort('user cancelled'))
    await expect(attempt()).rejects.toBe('user cancelled')

    expect(session.events).toHaveLength(from)
  })

  it("is the host's cancelled failure when the agent itself is cancelled", async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const from = session.events.length

    const failure = await ctx.compaction.compactNow(agentFor(session, AbortSignal.abort('agent cancelled')), signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('cancelled')
    expect(session.events).toHaveLength(from)
  })
})

describe('explicit compaction observability', () => {
  it('logs the strategy and counts of each compaction, never a body', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const info = vi.spyOn(ctx.logger, 'info')
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    const lines = info.mock.calls.map(([message]) => String(message))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^maskpoint \(explicit\): strategy mask, 3 observations masked, \d+ chars omitted, candidate ~\d+ tokens, no checkpoint$/)
  })
})

describe('what masked history keeps besides prompts and calls', () => {
  it('keeps reasoning and host context readable under explicit roles, and notes an image the user attached', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'see the attached screenshot' },
        { type: 'image', attachment: { attachmentId: AttachmentId('user-shot'), mediaType: 'image/png', bytes: 5_000, width: 100, height: 100 } },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Project instructions: prefer small diffs.' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 4, step: 1 })
    session.append('assistant/message', {
      turn: 4,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'the screenshot shows a failing layout' }, { type: 'text', text: 'I will fix the layout.' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 4, step: 1 })
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    // Compaction keeps the newest balanced node verbatim; a later turn puts turn 4 inside the region.
    appendClosedTurn(session, 5, 'trailing output\n'.repeat(100))

    await ctx.compaction.compactNow(agentFor(session), signal)

    const text = surfaceText(session)
    expect(text).toContain('Recorded assistant reasoning\nthe screenshot shows a failing layout')
    expect(text).toContain('Recorded assistant message\nI will fix the layout.')
    expect(text).toContain('Recorded host context: agent-instructions\nProject instructions: prefer small diffs.')
    expect(text).toContain('Recorded user message\nsee the attached screenshot\n[image attachment omitted]')
  })
})

describe('repeated compaction', () => {
  it('carries the earlier masked history forward verbatim instead of masking or framing it again', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const first = await ctx.compaction.compactNow(agentFor(session), signal)
    const firstSummary = session.events[first!.summarySeq]!
    if (firstSummary.type !== 'compaction/summary') throw new Error('expected compaction/summary')
    const carried = (firstSummary.data.summary[0] as { text: string }).text

    appendClosedTurn(session, 4, 'another large observation\n'.repeat(200))
    appendClosedTurn(session, 5, 'and one more large observation\n'.repeat(200))
    const second = await ctx.compaction.compactNow(agentFor(session), signal)

    const secondSummary = session.events[second!.summarySeq]!
    if (secondSummary.type !== 'compaction/summary') throw new Error('expected compaction/summary')
    const text = (secondSummary.data.summary[0] as { text: string }).text
    // The earlier state leads, byte for byte, and only the newly evicted history is framed after it.
    expect(text.startsWith(carried)).toBe(true)
    expect(text).not.toContain('Earlier checkpoint')
    expect(text.split(HISTORY_FRAMING)).toHaveLength(3)
    expect(text).toContain('please run step 4 and report')
    expect(text).not.toContain('another large observation')
    expect(surfaceText(session)).not.toContain('line of build output')
  })
})
