import ToolResultPruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { describe, expect, it } from 'vitest'
import MaskpointCompactionEngine, { HOST_PRUNE_MARKER } from '../src/index.js'
import { accounting, agentFor, conversation, harness, sequence, surfaceText } from './harness.js'

const signal = new AbortController().signal
const PRUNER = { thresholdChars: 2_000, headChars: 500, tailChars: 200 }
const OMITTED = /\[tool result omitted: bash/g

/** The model-visible text of each observation on the surface, oldest first. */
function observations(session: ReturnType<typeof conversation>['session']): string[] {
  return session.deriveMessages()
    .filter((message) => message.content[0]?.type === 'tool-result')
    .map((message) => JSON.stringify(message))
}

describe('composition with the host tool-result pruner', () => {
  it("pins its idea of the host's pruned-result marker to the host's own constant", () => {
    expect(PRUNE_MARKER).toBe(HOST_PRUNE_MARKER)
  })

  it('still masks an observation that merely quotes the marker phrase', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    // A log that mentions the phrase inline, as a build tool quoting the host's own output might.
    const { session } = conversation(ctx, {
      openTurn: true,
      body: (n) => `step ${n}: the tool said [... tool result middle pruned ...] and carried on\n`.repeat(150),
    })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    expect(surfaceText(session)).not.toContain('the tool said')
    expect(surfaceText(session).match(OMITTED)).toHaveLength(3)
  })

  it('is correct with the pruner mounted: it masks first, and the pruner then finds nothing left to wrap', async () => {
    const ctx = await harness()
    await ctx.plugin(ToolResultPruner, PRUNER)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    const before = accounting(ctx, session)
    const from = session.events.length

    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    // One prune pair per observation, all ours: a masked observation is under the pruner's threshold.
    expect(sequence(session, from)).toEqual(Array.from({ length: 3 }, () => ['compaction/prune', 'tool/result(replace)']).flat())
    for (const text of observations(session)) {
      expect(text).toContain('tool result omitted')
      expect(text).not.toContain('middle pruned')
    }
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.total).toBeLessThan(before.total)
  })

  it("keeps the host's safety net: the retained window is still pruned by the host, not masked by us", async () => {
    const ctx = await harness()
    await ctx.plugin(ToolResultPruner, PRUNER)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    const [oldest, middle, newest] = observations(session)
    expect(oldest).toContain('tool result omitted')
    expect(oldest).not.toContain('middle pruned')
    for (const retained of [middle, newest]) {
      expect(retained).toContain('middle pruned')
      expect(retained).not.toContain('tool result omitted')
    }
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
  })

  it('is idempotent over results the host pruner already reduced: nothing is re-wrapped', async () => {
    const ctx = await harness()
    await ctx.plugin(ToolResultPruner, PRUNER)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })
    ctx.get('toolResultPruner')!.pruneSession(session)
    const pruned = observations(session)
    expect(pruned.every((text) => text.includes('middle pruned'))).toBe(true)
    const from = session.events.length

    await ctx.compaction.compactIfNeeded(agentFor(session), 'context-overflow', signal)

    expect(session.events).toHaveLength(from)
    expect(observations(session)).toEqual(pruned)
  })

  it('carries pruned results into masked history as they are, never wrapping the host placeholder in ours', async () => {
    const ctx = await harness()
    await ctx.plugin(ToolResultPruner, { thresholdChars: 4_000, headChars: 1_500, tailChars: 500 })
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    // Two observations under the pruner's threshold and one far over it.
    const { session } = conversation(ctx, {
      openTurn: false,
      body: (n) => `line of build output ${n}\n`.repeat(n === 2 ? 500 : 130),
    })
    // The pruner ran during a later turn; the session is now idle and the user compacts.
    session.append('turn/start', { turn: 4 })
    ctx.get('toolResultPruner')!.pruneSession(session)
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

    await ctx.compaction.compactNow(agentFor(session), signal)

    const text = surfaceText(session)
    // The pruned result travels as the host left it; the untouched ones are masked by us.
    expect(text).toContain('middle pruned')
    expect(text).toContain('line of build output 2')
    expect(text.match(OMITTED)).toHaveLength(2)
    expect(text).not.toContain('line of build output 1')
    expect(text).not.toContain('tool result omitted: tool result omitted')
  })
})
