import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ManualCompactionError, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { accounting, agentFor, appendClosedTurn, conversation, expectedAfter, harness, sequence, surfaceText } from './harness.js'

const signal = new AbortController().signal

/** Whether the model-visible tool result for `seq` is still its original body. */
function isVerbatim(session: ReturnType<typeof conversation>['session'], seq: number): boolean {
  const event = session.events[seq]
  if (event?.type !== 'tool/result') throw new Error('not a tool result')
  return JSON.stringify(event.data.message).includes('line of build output')
}

/** The latest version of one observation: the replacement that cites it, else the original. */
function currentResult(session: ReturnType<typeof conversation>['session'], originalSeq: number): string {
  const replacement = session.events.findLast((e) => e.type === 'tool/result' && e.sourceEventSeqs?.includes(originalSeq))
  return JSON.stringify((replacement ?? session.events[originalSeq])!.data)
}

describe('automatic compaction (compactIfNeeded, pressure)', () => {
  it('does nothing below the host threshold', async () => {
    const ctx = await harness(1_000_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    const from = session.events.length

    const result = await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(result).toBeNull()
    expect(session.events).toHaveLength(from)
  })

  it("masks observations outside the host's retained window, in place, by the host's prune protocol", async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session, observationSeqs } = conversation(ctx, { openTurn: true })
    const before = accounting(ctx, session)
    const generation = session.surface.replaceGeneration
    const pairingBefore = session.surface.nodes.map((seq) => [toolPairingBalancedBefore(session, seq), toolPairingBalancedAfter(session, seq)])
    const messagesBefore: Message[] = session.deriveMessages()
    const shadowed = ctx.tokenMeter.measure(session).nodes.find((node) => node.seq === observationSeqs[0])!.tokens
    const from = session.events.length

    const result = await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    // No summary ran, so the documented return is null.
    expect(result).toBeNull()
    // Exactly the host's model-free protocol: one shadow price then one content-only replacement per
    // masked observation; no bracket, no lock, no summary event, no envelope.
    expect(sequence(session, from)).toEqual(['compaction/prune', 'tool/result(replace)'])
    const prune = session.events[from]!
    expect(prune.type === 'compaction/prune' && prune.data.shadowedSeqs).toEqual([observationSeqs[0]])
    const replacement = session.events[from + 1]!
    if (replacement.type !== 'tool/result') throw new Error('expected tool/result')
    expect(replacement.sourceEventSeqs).toEqual([observationSeqs[0]])

    // The oldest observation is masked; the one inside the retained window is verbatim.
    expect(JSON.stringify(replacement.data.message)).toMatch(/\[tool result omitted: bash, ok, 200 lines, \d+ chars\]/)
    expect(JSON.stringify(replacement.data.message)).not.toContain('line of build output')
    expect(isVerbatim(session, observationSeqs[2]!)).toBe(true)

    // Accounting: all readers agree; the total fell by exactly shadowed minus replacement.
    const priced = ctx.tokenMeter.measure(session).nodes.find((node) => node.seq === replacement.seq)!.tokens
    expect(accounting(ctx, session)).toEqual(expectedAfter(before, shadowed, priced))
    expect(accounting(ctx, session).total).toBeLessThan(before.total)
    // Durable proof of progress for the host's overflow-retry loop.
    expect(session.surface.replaceGeneration).toBeGreaterThan(generation)

    // Pairing untouched: same nodes, same answer at every cut. Everything but the observation is equal.
    expect(session.surface.nodes.map((seq) => [toolPairingBalancedBefore(session, seq), toolPairingBalancedAfter(session, seq)])).toEqual(pairingBefore)
    const messagesAfter = session.deriveMessages()
    expect(messagesAfter).toHaveLength(messagesBefore.length)
    messagesAfter.forEach((message, index) => {
      if (JSON.stringify(message) !== JSON.stringify(messagesBefore[index])) expect(message.content[0]?.type).toBe('tool-result')
    })
  })

  it('is idempotent: a forced pass masks what is left, and a further pass finds nothing', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)
    const after = accounting(ctx, session)
    const from = session.events.length

    // Retain nothing so that every observation is in reach, and run twice more.
    const again = await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)
    const generation = session.surface.replaceGeneration
    const third = await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    expect([again, third]).toEqual([null, null])
    expect(session.surface.replaceGeneration).toBe(generation)
    // The second pass masked the rest; the third found nothing left, and added no events.
    const tail = sequence(session, from)
    expect(tail.every((type, index) => type === (index % 2 === 0 ? 'compaction/prune' : 'tool/result(replace)'))).toBe(true)
    expect(accounting(ctx, session).total).toBeLessThan(after.total)
    const events = session.events.length
    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)
    expect(session.events).toHaveLength(events)
  })

  it('leaves an observation alone when its placeholder would not be smaller', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true, body: () => 'ok' })
    const from = session.events.length

    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    expect(session.events).toHaveLength(from)
  })

  it('makes no model call: the route it is given throws if streamed', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const stream = vi.spyOn(ctx.llm, 'stream')
    const { session } = conversation(ctx, { openTurn: true })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(stream).not.toHaveBeenCalled()
  })
})

describe('automatic compaction (compactIfNeeded, context overflow)', () => {
  it('masks past the retained window even below the pressure threshold, and advances the surface', async () => {
    const ctx = await harness(1_000_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session, observationSeqs } = conversation(ctx, { openTurn: true })
    const generation = session.surface.replaceGeneration

    const result = await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    expect(result).toBeNull()
    expect(session.surface.replaceGeneration).toBeGreaterThan(generation)
    const text = surfaceText(session)
    expect(text).not.toContain('line of build output')
    expect(text.match(/\[tool result omitted: bash/g)).toHaveLength(observationSeqs.length)
  })
})

describe('automatic compaction observability', () => {
  it('logs each pass with its strategy and counts, and says once when masking leaves the session above the threshold', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const info = vi.spyOn(ctx.logger, 'info')
    const warn = vi.spyOn(ctx.logger, 'warn')
    // Tiny observations: nothing to mask, yet the provider-anchored total is over the threshold.
    const stuck = conversation(ctx, { openTurn: true, body: () => 'ok' }).session

    await ctx.compaction.compactIfNeeded(agentFor(stuck), 'pressure', signal)
    await ctx.compaction.compactIfNeeded(agentFor(stuck), 'pressure', signal)

    expect(info).not.toHaveBeenCalled()
    expect(warn.mock.calls.filter(([message]) => String(message).includes('still above'))).toHaveLength(1)

    const masking = await harness(10_000)
    await masking.plugin(MaskpointCompactionEngine, { auto: false })
    const log = vi.spyOn(masking.logger, 'info')
    await masking.compaction.compactIfNeeded(agentFor(conversation(masking, { openTurn: true }).session), 'pressure', signal)
    expect(String(log.mock.calls[0]?.[0])).toMatch(/strategy mask, 1 observations masked, \d+ chars omitted, ~\d+ tokens now, no checkpoint/)
  })
})

describe('automatic compaction cancellation', () => {
  it('lands nothing when the turn was cancelled', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    const from = session.events.length

    await expect(ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', AbortSignal.abort('turn cancelled'))).rejects.toBe('turn cancelled')
    await expect(ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', AbortSignal.abort('turn cancelled'))).rejects.toBe('turn cancelled')

    expect(session.events).toHaveLength(from)
  })
})

describe('automatic compaction failure paths', () => {
  it('does nothing when the session has no routed model yet', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const session = ctx.sessions.create('unrouted' as never)
    session.append('turn/start', { turn: 1 })

    await expect(ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)).resolves.toBeNull()
  })

  it('refuses outside an open turn, as the host backend does', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    await expect(ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)).rejects.toThrow(/no open turn/)
  })

  it('is busy while another compaction holds the session lock', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    session.append('compaction/start', { compactionId: 'held' as never, turn: 4 })

    const failure = await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ManualCompactionError)
    expect((failure as ManualCompactionError).code).toBe('busy')
  })

  it('warns once and does nothing when the routed model reports no context capacity', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({ provider, id: model, name: model }))
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { session } = conversation(ctx, { openTurn: true })
    const from = session.events.length

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)
    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(session.events).toHaveLength(from)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('image observations', () => {
  it('lose their payload and keep a text note, with the host accounting still exact', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })
    const screenshot: ContentBlock[] = [{
      type: 'image',
      attachment: { attachmentId: AttachmentId('shot-1'), mediaType: 'image/png', bytes: 90_000, width: 1024, height: 768 },
    }]
    const imageSeq = appendClosedTurn(session, 4, screenshot, { inputTokens: 9_500, outputTokens: 10 }, { name: 'screenshot' })
    session.append('turn/start', { turn: 5 })
    const before = accounting(ctx, session)

    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    const event = session.events.find((e) => e.type === 'tool/result' && e.sourceEventSeqs?.includes(imageSeq))
    if (event?.type !== 'tool/result') throw new Error('the image observation was not replaced')
    const body = JSON.stringify(event.data.message)
    expect(body).not.toContain('"type":"image"')
    expect(body).toContain('[tool result omitted: screenshot, ok, 1 image]')
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.total).toBeLessThan(before.total)
  })
})

describe('the newest observation stays verbatim across turns', () => {
  it('masks a stale observation once the window has moved past it', async () => {
    const ctx = await harness(10_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session, observationSeqs } = conversation(ctx, { openTurn: false })
    appendClosedTurn(session, 4, 'fresh output\n'.repeat(200), { inputTokens: 9_500, outputTokens: 10 })
    session.append('turn/start', { turn: 5 })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(currentResult(session, observationSeqs[1]!)).toContain('tool result omitted')
    expect(surfaceText(session)).toContain('fresh output')
  })
})
