import { HISTORY_FRAMING } from '@maskpoint/core'
import { ManualCompactionError, isCompactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { accounting, agentFor, appendClosedTurn, conversation, harness, sequence, surfaceText } from './harness.js'

const signal = new AbortController().signal

/** The balanced span from the first surface node through the last node of the last closed turn. */
function closedRegion(session: Session): { start: number; end: number; seqs: number[] } {
  const open = session.events.findLast((event) => event.type === 'turn/start' && event.data.turn === 4)
  const limit = open?.seq ?? session.events.length
  const seqs = session.surface.nodes.filter((seq) => seq < limit)
  return { start: seqs[0]!, end: seqs.at(-1)!, seqs }
}

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
