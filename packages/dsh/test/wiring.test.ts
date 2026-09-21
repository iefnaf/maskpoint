import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { accounting, agentFor, conversation, harness, sequence, surfaceText } from './harness.js'

const signal = new AbortController().signal

/** The host's own pre-step event, which the inherited automatic listener answers. */
function preStep(ctx: Context, owner: Agent) {
  return agentEvents(ctx, owner).waterfall(
    'agent/pre-step',
    { messages: [], turn: 4, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/** A provider context-overflow, and whether the host's recovery loop decided to retry the request. */
async function overflow(ctx: Context, owner: Agent): Promise<boolean> {
  const failure = { message: 'provider overflow', code: CONTEXT_WINDOW_EXCEEDED_CODE }
  const next = (): Promise<RequestErrorAction> => Promise.resolve(undefined)
  const action = await agentEvents(ctx, owner).waterfall(
    'agent/request-error',
    { turn: 4, step: 1, provider: 'test', failure, retryPolicy: undefined, signal },
    next,
  )
  return action?.kind === 'retry'
}

describe('the host automatic listeners drive the masking landing', () => {
  it('masks before a step that is over the threshold, and leaves the step alone below it', async () => {
    const over = await harness(10_000)
    await over.plugin(MaskpointCompactionEngine)
    const pressured = conversation(over, { openTurn: true }).session
    const before = accounting(over, pressured)
    const from = pressured.events.length

    await expect(preStep(over, agentFor(pressured))).resolves.toEqual({ kind: 'enter', messages: [] })

    expect(sequence(pressured, from)).toEqual(['compaction/prune', 'tool/result(replace)'])
    expect(accounting(over, pressured).total).toBeLessThan(before.total)

    const under = await harness(1_000_000)
    await under.plugin(MaskpointCompactionEngine)
    const idle = conversation(under, { openTurn: true }).session
    const events = idle.events.length
    await preStep(under, agentFor(idle))
    expect(idle.events).toHaveLength(events)
  })

  it('turns an overflow into a retry when masking shrank the surface', async () => {
    const ctx = await harness(1_000_000)
    await ctx.plugin(MaskpointCompactionEngine)
    const { session } = conversation(ctx, { openTurn: true })

    await expect(overflow(ctx, agentFor(session))).resolves.toBe(true)
    expect(surfaceText(session)).not.toContain('line of build output')
  })

  it('does not retry an overflow when nothing was left to mask', async () => {
    // Observations already tiny: no progress, so the host surfaces the original request error
    // instead of looping on a request that cannot shrink.
    const ctx = await harness(1_000_000)
    await ctx.plugin(MaskpointCompactionEngine)
    const { session } = conversation(ctx, { openTurn: true, body: () => 'ok' })
    const generation = session.surface.replaceGeneration

    await expect(overflow(ctx, agentFor(session))).resolves.toBe(false)
    expect(session.surface.replaceGeneration).toBe(generation)
  })
})
