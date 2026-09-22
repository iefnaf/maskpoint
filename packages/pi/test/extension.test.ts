import { describe, expect, it, vi } from 'vitest'
import maskpoint from '../src/extension.js'
import type { PiBeforeCompactEvent, PiCompactionResult, PiContext, PiExtensionApi } from '../src/host.js'
import { firstTurn } from './support/scenario.js'
import { assistant, beforeCompact, bulky, fakeContext, modelReply, text, toolCall, toolResult, user } from './support/session.js'

type Handler = (event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>

/** Load the extension into a stand-in for Pi and hand back what it subscribed to. */
function load() {
  const handlers = new Map<string, Handler>()
  const pi: PiExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
    },
  }
  maskpoint(pi)
  return handlers
}

const handler = () => {
  const found = load().get('session_before_compact')
  if (found === undefined) throw new Error('the extension did not subscribe to session_before_compact')
  return found
}

describe('the extension', () => {
  it('subscribes to the pre-compaction event and nothing else', () => {
    expect([...load().keys()]).toEqual(['session_before_compact'])
  })

  it('returns a compaction whose cut point and token count are exactly the ones Pi prepared', async () => {
    const event = beforeCompact(firstTurn(), 'u2', { tokensBefore: 31_337 })
    const result = await handler()(event, fakeContext())
    expect(result?.compaction.firstKeptEntryId).toBe(event.preparation.firstKeptEntryId)
    expect(result?.compaction.tokensBefore).toBe(31_337)
    expect(result?.compaction.summary).toContain('Rename the Widget component')
  })

  it('stores strategy and statistics in the compaction entry details', async () => {
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({
      v: 1,
      engine: 'maskpoint',
      strategy: 'mask',
      stats: { observationsMasked: 1, charsOmitted: expect.any(Number), candidateTokens: expect.any(Number) },
    })
  })

  it.each(['threshold', 'manual', 'overflow'] as const)('makes no model call on %s compaction', async (reason) => {
    const complete = vi.fn()
    const ctx = { ...fakeContext(), modelRegistry: { complete, find: complete } }
    const result = await handler()(beforeCompact(firstTurn(), 'u2', { reason }), ctx)
    expect(result).toBeDefined()
    expect(complete).not.toHaveBeenCalled()
  })

  it('returns nothing when it declines, so Pi compacts as if it were not installed', async () => {
    const chat = [user('u1', 'Hi.'), assistant('a1', [text('Hello.')]), user('u2', 'Bye.'), assistant('a2', [text('Goodbye.')])]
    expect(await handler()(beforeCompact(chat, 'u2'), fakeContext())).toBeUndefined()
  })

  it('returns nothing, without throwing, for an event it cannot read', async () => {
    const broken = { ...beforeCompact(firstTurn(), 'u2'), branchEntries: 'not a list' } as unknown as PiBeforeCompactEvent
    expect(await handler()(broken, fakeContext())).toBeUndefined()
  })

  it('returns nothing when the compaction was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const event = { ...beforeCompact(firstTurn(), 'u2'), signal: controller.signal }
    expect(await handler()(event, fakeContext())).toBeUndefined()
  })
})

describe('what the user is told', () => {
  it('says masking ran, what it removed, and that no model was called', async () => {
    const ctx = fakeContext()
    await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(ctx.notes).toHaveLength(1)
    expect(ctx.notes[0]?.message).toMatch(/masked 1 observation/i)
    expect(ctx.notes[0]?.message).toMatch(/no model call/i)
    expect(ctx.notes[0]?.level).toBe('info')
  })

  it('says a checkpoint was attempted and not accepted, when over budget and the call fails', async () => {
    const long = 'a long, careful explanation. '.repeat(2500)
    const entries = [
      user('u1', 'Explain everything.'),
      assistant('a1', [text(long), toolCall('c1', 'read', { path: '/workspace/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY-A')),
      user('u2', 'Thanks.'),
      assistant('a2', [text('Welcome.')]),
    ]
    const ctx = fakeContext()
    const result = await handler()(beforeCompact(entries, 'u2'), ctx)
    expect(result).toBeDefined()
    expect(ctx.notes[0]?.message).toMatch(/checkpoint/i)
    expect(ctx.notes[0]?.message).toMatch(/not accepted/i)
  })

  it('says a checkpoint ran with one model call, when a focus forces one and it succeeds', async () => {
    const ctx = fakeContext()
    ctx.modelRegistry = { complete: () => Promise.resolve(modelReply('a checkpoint')) }
    await handler()(beforeCompact(firstTurn(), 'u2', { reason: 'manual', customInstructions: 'focus on the docs' }), ctx)
    expect(ctx.notes[0]?.message).toMatch(/condensed into a checkpoint/i)
  })

  it('does not mention a checkpoint when none was attempted', async () => {
    const ctx = fakeContext()
    await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(ctx.notes[0]?.message).not.toMatch(/checkpoint/i)
  })

  it("says why it stepped aside, so a session running Pi's compactor is never a mystery", async () => {
    const ctx = fakeContext()
    const broken = { ...beforeCompact(firstTurn(), 'u2'), branchEntries: 'not a list' } as unknown as PiBeforeCompactEvent
    await handler()(broken, ctx)
    expect(ctx.notes).toHaveLength(1)
    expect(ctx.notes[0]?.message).toMatch(/unreadable-snapshot/)
    expect(ctx.notes[0]?.message).toMatch(/Pi/)
  })

  it('stays quiet when there is no UI to tell', async () => {
    const ctx = fakeContext(false)
    await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(ctx.notes).toEqual([])
  })

  it('never puts observation content in what it says', async () => {
    const ctx = fakeContext()
    await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(JSON.stringify(ctx.notes)).not.toContain('BODY-1')
  })
})

describe('configuration (issue #8)', () => {
  it('returns nothing and touches nothing else when ctx.config disables Maskpoint', async () => {
    const ctx = fakeContext(true, { enabled: false })
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result).toBeUndefined()
    expect(ctx.notes).toEqual([])
  })

  it('lowering the checkpoint budget in ctx.config turns a masked-history result into a checkpoint', async () => {
    const ctx = fakeContext(true, { checkpointTriggerTokens: 1 })
    ctx.modelRegistry = { complete: () => Promise.resolve(modelReply('a checkpoint')) }
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'checkpoint' })
  })

  it('keeps the default budget (masked history, no model call) when ctx.config sets nothing', async () => {
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
  })

  it('suppresses the routine notification at notificationLevel "silent", but not a decline', async () => {
    const ctx = fakeContext(true, { notificationLevel: 'silent' })
    await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(ctx.notes).toEqual([])

    const declineCtx = fakeContext(true, { notificationLevel: 'silent' })
    const broken = { ...beforeCompact(firstTurn(), 'u2'), branchEntries: 'not a list' } as unknown as PiBeforeCompactEvent
    await handler()(broken, declineCtx)
    expect(declineCtx.notes).toHaveLength(1)
  })

  it('warns through the UI and falls back to the default when ctx.config is invalid, instead of throwing', async () => {
    const ctx = fakeContext(true, { checkpointTriggerTokens: -1 })
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result).toBeDefined()
    expect(ctx.notes[0]).toMatchObject({ level: 'warning' })
    expect(ctx.notes[0]?.message).toMatch(/checkpointTriggerTokens/)
  })
})
