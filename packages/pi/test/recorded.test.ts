import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCompaction } from '../src/compact.js'
import maskpoint from '../src/extension.js'
import type { PiBeforeCompactEvent, PiCompactionResult, PiContext } from '../src/host.js'
import { buildSnapshot, isDecline } from '../src/snapshot.js'
import { native } from './support/scenario.js'
import { fakeContext } from './support/session.js'

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
  const effect = native(planCompaction(first))

  it("returns Pi's own cut point and token count", () => {
    expect(effect.boundary).toEqual({ id: first.preparation.firstKeptEntryId })
    expect(effect.tokensBefore).toBe(first.preparation.tokensBefore)
  })

  it('masks every observation Pi was about to summarize, and leaves no fragment of any body', () => {
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

  it('shrinks context', () => {
    expect(effect.detail.stats.candidateTokens).toBeLessThan(first.preparation.tokensBefore)
  })

  it('keeps what the user asked, in order', () => {
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
  const effect = native(planCompaction(repeat))

  it("builds on the summary Pi holds from the earlier compaction, verbatim and first", () => {
    expect(repeat.preparation.previousSummary).toBeTruthy()
    expect(effect.summary.startsWith(repeat.preparation.previousSummary!)).toBe(true)
  })

  it("still returns Pi's own cut point", () => {
    expect(effect.boundary).toEqual({ id: repeat.preparation.firstKeptEntryId })
  })

  it('agrees with the cursor this adapter persisted in the real compaction entry', () => {
    const persisted = entriesOf(repeat).findLast((entry) => entry.type === 'compaction')?.details
    expect(persisted).toMatchObject({ v: 1, engine: 'maskpoint', strategy: 'mask' })
    // Derived independently: the persisted cursor came from the first compaction, this one from Pi's entries.
    const snapshot = buildSnapshot(repeat)
    if (isDecline(snapshot)) throw new Error(`declined: ${snapshot.note}`)
    expect(snapshot.evictedThrough).toBe(persisted.cursor.evictedThroughId)
  })

  it('masks only what was evicted since, and no body reaches the accumulated summary', () => {
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

  it('shrinks context', () => {
    expect(effect.detail.stats.candidateTokens).toBeLessThan(repeat.preparation.tokensBefore)
  })
})

describe('a real threshold compaction', () => {
  it('is what Pi sends for automatic compaction: the reason and no retry', () => {
    expect(automatic.reason).toBe('threshold')
    expect(automatic.willRetry).toBe(false)
  })

  it('masks the bulky observation and returns the cut point Pi prepared', () => {
    const effect = native(planCompaction(automatic))
    expect(effect.boundary).toEqual({ id: automatic.preparation.firstKeptEntryId })
    const bodies = identifying(observationBodies(automatic))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(effect.summary).not.toContain(body.slice(0, 80))
    expect(effect.detail.stats.candidateTokens).toBeLessThan(automatic.preparation.tokensBefore)
  })
})

describe('real payloads through the extension', () => {
  const run = (event: PiBeforeCompactEvent): { result: PiCompactionResult | undefined; ctx: ReturnType<typeof fakeContext> } => {
    let handler: ((event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>) | undefined
    maskpoint({ on: (_name, fn) => void (handler = fn) })
    const ctx = fakeContext()
    return { result: handler?.(event, ctx) as PiCompactionResult | undefined, ctx }
  }

  it.each(['threshold', 'manual', 'overflow'] as const)('handles a %s trigger the same way', (reason) => {
    const { result } = run({ ...first, reason, willRetry: reason === 'overflow' })
    expect(result?.compaction.firstKeptEntryId).toBe(first.preparation.firstKeptEntryId)
    expect(result?.compaction.details).toMatchObject({ strategy: 'mask' })
  })

  it('steps aside for a focus request, leaving Pi to honour it', () => {
    const { result, ctx } = run({ ...first, customInstructions: 'focus on the docs' })
    expect(result).toBeUndefined()
    expect(ctx.notes[0]?.message).toMatch(/checkpoint-unavailable/)
  })

  it('steps aside when the recorded history no longer looks the way this adapter expects', () => {
    const drifted = structuredClone(first) as PiBeforeCompactEvent
    const reply = (drifted.branchEntries as Entry[]).find((entry) => entry.message?.role === 'assistant')!
    reply.message.content.push({ type: 'hologram', data: 'x' })
    expect(run(drifted).result).toBeUndefined()
  })
})
