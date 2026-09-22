import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { planCompaction } from '../src/compact.js'
import maskpoint from '../src/extension.js'
import type { PiBeforeCompactEvent, PiCompactionResult, PiContext } from '../src/host.js'
import { buildSnapshot, isDecline } from '../src/snapshot.js'
import { native } from './support/scenario.js'
import { fakeContext, modelReply } from './support/session.js'

/**
 * Seam 2: the adapter over payloads recorded from a real Pi session (see recorded/README.md).
 * The two payloads are one session's first and second manual compactions, taken with this
 * extension installed, so the second carries the summary this adapter wrote for the first.
 */
const HOST = 'pi-0.86.1'

type Recorded = Omit<PiBeforeCompactEvent, 'signal'>
type Entry = Record<string, any>

const load = (name: string): PiBeforeCompactEvent => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'recorded', HOST, name), 'utf8')) as Recorded
  return { ...recorded, signal: new AbortController().signal }
}

const first = load('manual-first.json')
const repeat = load('manual-repeat.json')
const automatic = load('threshold-first.json')

const entriesOf = (event: PiBeforeCompactEvent) => event.branchEntries as Entry[]

/** The observation bodies Pi's own preparation was about to summarize: the text a mask must remove. */
function observationBodies(event: PiBeforeCompactEvent): string[] {
  const entries = entriesOf(event)
  const kept = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId)
  return entries
    .slice(0, kept)
    .filter((entry) => entry.message?.role === 'toolResult')
    .map((entry) => (entry.message.content as { text?: string }[]).map((block) => block.text ?? '').join('\n'))
}

/**
 * Bodies long enough that a fragment of one cannot turn up in the summary by coincidence. A short
 * output such as a bare number may legitimately reappear in what the assistant said about it.
 */
const identifying = (bodies: string[]) => bodies.filter((body) => body.length > 200)

describe('a real first compaction', () => {
  let effect: ReturnType<typeof native>
  beforeAll(async () => {
    effect = native(await planCompaction(first, fakeContext()))
  })

  it("returns Pi's own cut point and token count", async () => {
    expect(effect.boundary).toEqual({ id: first.preparation.firstKeptEntryId })
    expect(effect.tokensBefore).toBe(first.preparation.tokensBefore)
  })

  it('masks every observation Pi was about to summarize, and leaves no fragment of any body', async () => {
    const bodies = observationBodies(first)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of identifying(bodies)) {
      for (const start of [0, Math.floor(body.length / 2), body.length - 80]) {
        expect(effect.summary).not.toContain(body.slice(start, start + 80))
      }
    }
    expect(effect.detail.stats.observationsMasked).toBe(bodies.length)
    expect(effect.detail.stats.charsOmitted).toBe(bodies.reduce((total, body) => total + [...body].length, 0))
  })

  it('shrinks context', async () => {
    expect(effect.detail.stats.candidateTokens).toBeLessThan(first.preparation.tokensBefore)
  })

  it('keeps what the user asked, in order', async () => {
    const asked = entriesOf(first)
      .filter((entry) => entry.message?.role === 'user' && entry.id !== first.preparation.firstKeptEntryId)
      .slice(0, 3)
      .map((entry) => (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content[0].text))
    const positions = asked.map((request) => effect.summary.indexOf(request))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('a real repeated compaction', () => {
  let effect: ReturnType<typeof native>
  beforeAll(async () => {
    effect = native(await planCompaction(repeat, fakeContext()))
  })

  it("builds on the summary Pi holds from the earlier compaction, verbatim and first", async () => {
    expect(repeat.preparation.previousSummary).toBeTruthy()
    expect(effect.summary.startsWith(repeat.preparation.previousSummary!)).toBe(true)
  })

  it("still returns Pi's own cut point", async () => {
    expect(effect.boundary).toEqual({ id: repeat.preparation.firstKeptEntryId })
  })

  it('agrees with the cursor this adapter persisted in the real compaction entry', async () => {
    const persisted = entriesOf(repeat).findLast((entry) => entry.type === 'compaction')?.details
    expect(persisted).toMatchObject({ v: 1, engine: 'maskpoint', strategy: 'mask' })
    // Derived independently: the persisted cursor came from the first compaction, this one from Pi's entries.
    const snapshot = buildSnapshot(repeat)
    if (isDecline(snapshot)) throw new Error(`declined: ${snapshot.note}`)
    expect(snapshot.evictedThrough).toBe(persisted.cursor.evictedThroughId)
  })

  it('masks only what was evicted since, and no body reaches the accumulated summary', async () => {
    const entries = entriesOf(repeat)
    const previous = entries.findLastIndex((entry) => entry.type === 'compaction')
    const since = observationBodies({ ...repeat, branchEntries: entries.slice(previous + 1) })
    expect(identifying(since).length).toBeGreaterThan(0)
    for (const body of identifying([...observationBodies(repeat), ...since])) {
      expect(effect.summary).not.toContain(body.slice(0, 80))
    }
    expect(effect.detail.stats.observationsMasked).toBeGreaterThan(0)
    expect(effect.detail.stats.observationsMasked).toBeLessThan(observationBodies(repeat).length)
  })

  it('shrinks context', async () => {
    expect(effect.detail.stats.candidateTokens).toBeLessThan(repeat.preparation.tokensBefore)
  })
})

describe('a real compaction on top of a summary Pi itself wrote', () => {
  const afterPi = load('after-pi-summary.json')
  const previous = entriesOf(afterPi).findLast((entry) => entry.type === 'compaction')!

  it("is the case it claims: Pi's own LLM summary, in Pi's own details shape", async () => {
    expect(previous.fromHook).toBeFalsy()
    expect(previous.details).toHaveProperty('readFiles')
    expect(previous.details).not.toHaveProperty('engine')
    expect(afterPi.preparation.previousSummary).toBe(previous.summary)
  })

  it("carries Pi's summary forward verbatim and adds only what was evicted since", async () => {
    const effect = native(await planCompaction(afterPi, fakeContext()))
    expect(effect.summary.startsWith(previous.summary)).toBe(true)
    expect(effect.summary.length).toBeGreaterThan(previous.summary.length)
    expect(effect.boundary).toEqual({ id: afterPi.preparation.firstKeptEntryId })
    const entries = entriesOf(afterPi)
    const since = observationBodies({ ...afterPi, branchEntries: entries.slice(entries.indexOf(previous) + 1) })
    expect(identifying(since).length).toBeGreaterThan(0)
    for (const body of identifying(since)) expect(effect.summary).not.toContain(body.slice(0, 80))
    expect(effect.detail.stats.observationsMasked).toBeGreaterThan(0)
  })
})

describe('a real threshold compaction', () => {
  it('is what Pi sends for automatic compaction: the reason and no retry', async () => {
    expect(automatic.reason).toBe('threshold')
    expect(automatic.willRetry).toBe(false)
  })

  it('masks the bulky observation and returns the cut point Pi prepared', async () => {
    const effect = native(await planCompaction(automatic, fakeContext()))
    expect(effect.boundary).toEqual({ id: automatic.preparation.firstKeptEntryId })
    const bodies = identifying(observationBodies(automatic))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(effect.summary).not.toContain(body.slice(0, 80))
    expect(effect.detail.stats.candidateTokens).toBeLessThan(automatic.preparation.tokensBefore)
  })
})

describe('real payloads through the extension', () => {
  const run = async (
    event: PiBeforeCompactEvent,
    ctx: ReturnType<typeof fakeContext> = fakeContext(),
  ): Promise<{ result: PiCompactionResult | undefined; ctx: ReturnType<typeof fakeContext> }> => {
    let handler: ((event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>) | undefined
    maskpoint({ on: (_name, fn) => void (handler = fn) })
    return { result: (await handler?.(event, ctx)) as PiCompactionResult | undefined, ctx }
  }

  it.each(['threshold', 'manual', 'overflow'] as const)('handles a %s trigger the same way', async (reason) => {
    const { result } = await run({ ...first, reason, willRetry: reason === 'overflow' })
    expect(result?.compaction.firstKeptEntryId).toBe(first.preparation.firstKeptEntryId)
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
  })

  it('a focus request forces a checkpoint, and the focus reaches the prompt', async () => {
    let sent: { systemPrompt?: string } | undefined
    const ctx = fakeContext()
    ctx.modelRegistry = {
      complete: (_model, context) => {
        sent = context
        return Promise.resolve(modelReply('## Goal\nFinish the docs pass.'))
      },
    }
    const { result } = await run({ ...first, customInstructions: 'focus on the docs' }, ctx)
    expect(result?.compaction.details).toMatchObject({ strategy: 'checkpoint' })
    expect(result?.compaction.summary).toContain('Finish the docs pass.')
    expect(sent?.systemPrompt).toContain('focus on the docs')
  })

  it('falls back to masked history, not a decline, when the checkpoint call for a focus request fails', async () => {
    const { result, ctx } = await run({ ...first, customInstructions: 'focus on the docs' })
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
    expect(ctx.notes[0]?.message).toMatch(/not accepted/)
  })

  it('steps aside when the recorded history no longer looks the way this adapter expects', async () => {
    const drifted = structuredClone(first) as PiBeforeCompactEvent
    const reply = (drifted.branchEntries as Entry[]).find((entry) => entry.message?.role === 'assistant')!
    reply.message.content.push({ type: 'hologram', data: 'x' })
    expect((await run(drifted)).result).toBeUndefined()
  })
})
