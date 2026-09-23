import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import maskpoint from '../src/extension.js'
import type { PiBeforeCompactEvent, PiCompactionResult, PiContext, PiExtensionApi } from '../src/host.js'
import { firstTurn } from './support/scenario.js'
import { assistant, beforeCompact, bulky, fakeContext, modelReply, text, thinking, toolCall, toolResult, usageOf, user } from './support/session.js'

type Handler = (event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>

/**
 * Load the extension into a stand-in for Pi and hand back what it subscribed to. `flags` seeds the
 * command line Pi parsed, and the values only become readable once the factory has returned — which
 * is what a real Pi does, having parsed its command line after the extension loaded.
 */
function load(flags: Record<string, string> = {}) {
  const handlers = new Map<string, Handler>()
  const registered: string[] = []
  const commands = new Map<string, (args: string, ctx: PiContext) => unknown | Promise<unknown>>()
  const values = new Map(Object.entries(flags))
  let loaded = false
  const pi: PiExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    registerFlag: (name) => {
      registered.push(name)
    },
    registerCommand: (name, options) => {
      commands.set(name, options.handler)
    },
    getFlag: (name) => (loaded ? values.get(name) : undefined),
  }
  maskpoint(pi)
  loaded = true
  return { handlers, registered, commands }
}

const handler = (flags?: Record<string, string>) => {
  const found = load(flags).handlers.get('session_before_compact')
  if (found === undefined) throw new Error('the extension did not subscribe to session_before_compact')
  return found
}

describe('the extension', () => {
  it('subscribes to the pre-compaction event and nothing else', () => {
    expect([...load().handlers.keys()]).toEqual(['session_before_compact'])
  })

  it('registers its settings as CLI flags, so `pi --help` can list them', () => {
    expect(load().registered).toEqual([
      'maskpoint-enabled',
      'maskpoint-compact-budget-tokens',
      'maskpoint-checkpoint-model',
      'maskpoint-mask-reasoning',
      'maskpoint-notification-level',
      'maskpoint-checkpoint-trigger-tokens',
    ])
  })

  it('registers one /maskpoint command, and a stored setting it writes applies to the very next compaction', async () => {
    vi.stubEnv('MASKPOINT_CONFIG', join(tmpdir(), `maskpoint-cmd-${process.pid}-${Date.now()}.json`))
    const { commands, handlers } = load()
    const command = commands.get('maskpoint')
    expect(command).toBeDefined()

    const ctx = fakeContext(true)
    await command!('reasoning on', ctx)
    expect(ctx.notes[0]?.message).toMatch(/stored, applies to the next compaction/)

    // The same process, the next compaction: the stored file is read at compaction time, so the
    // reasoning blocks in the fixture below are masked with no restart and no environment.
    vi.unstubAllEnvs()
    const entries = [
      user('u1', 'Go.'),
      assistant('a1', [thinking('I should read the file first, then edit it carefully.'), toolCall('c1', 'read', { path: '/w/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY')),
      user('u2', 'Thanks.'),
      assistant('a2', [text('Done.')]),
    ]
    const result = await handlers.get('session_before_compact')!(beforeCompact(entries, 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask', stats: { reasoningsMasked: 1 } })
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
    // An explicit small budget, so the fixture's ~19k-token candidate is over it whatever the
    // default is (issue #46 made the default 24k, which would keep this fixture mask-only).
    vi.stubEnv('MASKPOINT_COMPACT_BUDGET_TOKENS', '12000')
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

describe('configuration (issues #8 and #39)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns nothing and touches nothing else when ctx.config disables Maskpoint', async () => {
    const ctx = fakeContext(true, { enabled: false })
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result).toBeUndefined()
    expect(ctx.notes).toEqual([])
  })

  it('lowering the checkpoint budget in ctx.config turns a masked-history result into a checkpoint', async () => {
    const ctx = fakeContext(true, { compactBudgetTokens: 1 })
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
    const ctx = fakeContext(true, { compactBudgetTokens: -1 })
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result).toBeDefined()
    expect(ctx.notes[0]).toMatchObject({ level: 'warning' })
    expect(ctx.notes[0]?.message).toMatch(/compactBudgetTokens/)
  })

  it('reads a setting from the environment, since Pi itself supplies none', async () => {
    vi.stubEnv('MASKPOINT_COMPACT_BUDGET_TOKENS', '1')
    const ctx = fakeContext()
    ctx.modelRegistry = { complete: () => Promise.resolve(modelReply('a checkpoint')) }
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'checkpoint' })
  })

  it('reads a setting from its own CLI flag', async () => {
    const ctx = fakeContext()
    ctx.modelRegistry = { complete: () => Promise.resolve(modelReply('a checkpoint')) }
    const result = await handler({ 'maskpoint-compact-budget-tokens': '1' })(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'checkpoint' })
  })

  it('lets a flag typed for this run win over the environment, field by field', async () => {
    vi.stubEnv('MASKPOINT_COMPACT_BUDGET_TOKENS', '1')
    const result = await handler({ 'maskpoint-compact-budget-tokens': '20000' })(beforeCompact(firstTurn(), 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
  })

  it('lets the environment win over whatever the host passes in ctx.config', async () => {
    vi.stubEnv('MASKPOINT_COMPACT_BUDGET_TOKENS', '20000')
    const ctx = fakeContext(true, { compactBudgetTokens: 1 })
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
  })

  it('names the channel in the warning when a value from it is invalid', async () => {
    vi.stubEnv('MASKPOINT_COMPACT_BUDGET_TOKENS', 'lots')
    const ctx = fakeContext()
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
    expect(ctx.notes[0]).toMatchObject({ level: 'warning' })
    expect(ctx.notes[0]?.message).toMatch(/invalid environment value for "compactBudgetTokens"/)
  })

  it('can be disabled from a flag, exactly as ctx.config can disable it', async () => {
    const result = await handler({ 'maskpoint-enabled': 'false' })(beforeCompact(firstTurn(), 'u2'), fakeContext())
    expect(result).toBeUndefined()
  })
})

describe('masking assistant reasoning (issue #43)', () => {
  const long = 'The parser is the likely culprit here. '.repeat(30)
  const chat = () => [
    user('u1', 'Fix the failing test.'),
    assistant('a1', [thinking(long), text('Looking at the parser first.'), toolCall('call-1', 'read', { path: 'src/parser.ts' })]),
    toolResult('r1', 'call-1', 'read', bulky('BODY-1')),
    user('u2', 'Go on.'),
    assistant('a2', [text('Continuing.')]),
  ]

  it('keeps reasoning verbatim by default, and records no reasoning count', async () => {
    const result = await handler()(beforeCompact(chat(), 'u2'), fakeContext())
    expect(result?.compaction.summary).toContain('The parser is the likely culprit here.')
    expect((result?.compaction.details as { stats: Record<string, unknown> }).stats.reasoningsMasked).toBeUndefined()
  })

  it('replaces it with a placeholder when the flag asks, and counts it in the statistics', async () => {
    const result = await handler({ 'maskpoint-mask-reasoning': 'true' })(beforeCompact(chat(), 'u2'), fakeContext())
    expect(result?.compaction.summary).toContain('[reasoning omitted:')
    expect(result?.compaction.summary).not.toContain('The parser is the likely culprit here.')
    expect(result?.compaction.summary).toContain('Recorded assistant reasoning')
    // The decisions themselves stay: assistant text and the tool call are untouched.
    expect(result?.compaction.summary).toContain('Looking at the parser first.')
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask', stats: { reasoningsMasked: 1, observationsMasked: 1 } })
  })

  it('says reasoning was masked in the notice, and stays quiet about it when it was not', async () => {
    const on = fakeContext()
    await handler({ 'maskpoint-mask-reasoning': 'true' })(beforeCompact(chat(), 'u2'), on)
    expect(on.notes[0]?.message).toMatch(/masked 1 observation and 1 reasoning block \(/)
    const off = fakeContext()
    await handler()(beforeCompact(chat(), 'u2'), off)
    expect(off.notes[0]?.message).toMatch(/masked 1 observation \(/)
  })

  it('can be turned on from the environment as well, since both channels feed one resolve', async () => {
    vi.stubEnv('MASKPOINT_MASK_REASONING', '1')
    const result = await handler()(beforeCompact(chat(), 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({ stats: { reasoningsMasked: 1 } })
  })
})

describe('the checkpoint usage Pi records (issue #40)', () => {
  it('hands Pi the provider\'s own usage object, cost included', async () => {
    const usage = usageOf(321, 65, { cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } })
    const ctx = fakeContext(true, { compactBudgetTokens: 1 })
    ctx.modelRegistry = { complete: () => Promise.resolve(modelReply('a checkpoint', { usage })) }
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), ctx)
    expect(result?.compaction.usage).toBe(usage)
  })

  it('hands Pi no usage for a compaction that made no model call', async () => {
    const result = await handler()(beforeCompact(firstTurn(), 'u2'), fakeContext())
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
    expect(result?.compaction.usage).toBeUndefined()
  })
})
