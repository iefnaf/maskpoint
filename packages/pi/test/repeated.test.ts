import { beforeAll, describe, expect, it } from 'vitest'
import { planCompaction, toPiResult } from '../src/compact.js'
import { firstTurn, native } from './support/scenario.js'
import {
  assistant,
  beforeCompact,
  bulky,
  compaction,
  type Entry,
  fakeContext,
  text,
  toolCall,
  toolResult,
  user,
} from './support/session.js'

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

/** What Pi does with our result: appends a compaction entry that keeps everything from `firstKeptEntryId`. */
async function afterCompacting(entries: Entry[], keepFrom: string) {
  const result = toPiResult(native(await planCompaction(beforeCompact(entries, keepFrom), fakeContext()))).compaction
  return { entry: compaction('c1', result.summary, result.firstKeptEntryId, result.details), summary: result.summary }
}

/** The session after the first compaction (which kept u2 and a3): two more bulky turns, then u4. */
const laterTurns = (): Entry[] => [
  assistant('b1', [text('Reading the component.'), toolCall('call-3', 'read', { path: '/workspace/app/panel.tsx' })]),
  toolResult('rb1', 'call-3', 'read', bulky('BODY-3')),
  assistant('b2', [text('Panel is updated.')]),
  user('u3', 'Now the docs.'),
  assistant('b3', [toolCall('call-5', 'read', { path: '/workspace/docs/panel.md' })]),
  toolResult('rb3', 'call-5', 'read', bulky('BODY-5')),
  assistant('b4', [text('Docs read.')]),
  user('u4', 'Ship it.'),
  assistant('b5', [text('Shipping.')]),
]

describe('planCompaction — a second compaction', () => {
  let first: Awaited<ReturnType<typeof afterCompacting>>
  let second: ReturnType<typeof native>
  beforeAll(async () => {
    const entries = firstTurn()
    first = await afterCompacting(entries, 'u2')
    second = native(await planCompaction(beforeCompact([...entries, first.entry, ...laterTurns()], 'u4'), fakeContext()))
  })

  it("carries the previous compaction's summary forward verbatim, ahead of the new history", async () => {
    expect(second.summary.startsWith(first.summary)).toBe(true)
    expect(second.summary.length).toBeGreaterThan(first.summary.length)
  })

  it('appends only what was evicted since: earlier history appears once, not again', async () => {
    expect(occurrences(second.summary, 'Rename the Widget component to Panel and update the docs.')).toBe(1)
    // u2 and a3 were retained by the first compaction; this one evicts them.
    expect(occurrences(second.summary, 'Go ahead with the rename.')).toBe(1)
    expect(occurrences(second.summary, 'Starting on the rename now.')).toBe(1)
    expect(second.summary).toContain('Now the docs.')
    expect(second.summary).toContain('/workspace/docs/panel.md')
  })

  it('never lets a full observation into the accumulated state', async () => {
    for (const body of ['BODY-1', 'BODY-3', 'BODY-5']) expect(second.summary).not.toContain(body)
  })

  it("does not repeat anything from the host's retained region", async () => {
    expect(second.summary).not.toContain('Ship it.')
    expect(second.summary).not.toContain('Shipping.')
  })

  it('counts only the newly evicted observations in its statistics', async () => {
    expect(second.detail.stats.observationsMasked).toBe(2)
    expect(second.detail.stats.charsOmitted).toBe(bulky('BODY-3').length + bulky('BODY-5').length)
  })

  it("records where it left off, and the cut point is still the host's own", async () => {
    expect(second.boundary).toEqual({ id: 'u4' })
    expect(second.detail.cursor).toEqual({ boundaryId: 'u4#0', evictedThroughId: 'b4#0' })
  })
})

describe('planCompaction — building on a compaction Pi made itself', () => {
  const piSummary = '## Goal\nRename Widget to Panel.\n\n## Progress\n- [x] Found the usages.'

  it("appends to the host's own summary, the way it would to ours", async () => {
    const session = [...firstTurn(), compaction('c1', piSummary, 'u2', { readFiles: [], modifiedFiles: [] }), ...laterTurns()]
    const effect = native(await planCompaction(beforeCompact(session, 'u4'), fakeContext()))
    expect(effect.summary.startsWith(piSummary)).toBe(true)
    expect(effect.summary).toContain('Now the docs.')
    expect(effect.summary).toContain('Go ahead with the rename.')
    expect(occurrences(effect.summary, 'Rename the Widget component')).toBe(0)
  })

  it('resumes just after the compaction when the entry it kept is gone from the branch', async () => {
    const session = [...firstTurn(), compaction('c1', piSummary, 'entry-that-is-gone'), ...laterTurns()]
    const effect = native(await planCompaction(beforeCompact(session, 'u4'), fakeContext()))
    expect(effect.summary.startsWith(piSummary)).toBe(true)
    expect(effect.summary).toContain('Panel is updated.')
    expect(effect.summary).not.toContain('Go ahead with the rename.')
  })

  it("declines when Pi's previous summary is not the one on the branch", async () => {
    const session = [...firstTurn(), compaction('c1', piSummary, 'u2'), ...laterTurns()]
    const event = beforeCompact(session, 'u4')
    const damaged = { ...event, preparation: { ...event.preparation, previousSummary: 'something else' } }
    expect(await planCompaction(damaged, fakeContext())).toMatchObject({ kind: 'decline', reason: 'unreadable-snapshot' })
  })

  it('declines when the previous compaction has no summary to build on', async () => {
    const session = [...firstTurn(), compaction('c1', '', 'u2'), ...laterTurns()]
    expect(await planCompaction(beforeCompact(session, 'u4'), fakeContext())).toMatchObject({
      kind: 'decline',
      reason: 'inconsistent-cursor',
    })
  })

  it('declines when there is nothing new to add, so nothing would shrink', async () => {
    const session = [...firstTurn(), compaction('c1', piSummary, 'u2'), assistant('b1', [text('Ok.')])]
    expect(await planCompaction(beforeCompact(session, 'u2'), fakeContext())).toEqual({ kind: 'decline', reason: 'no-size-reduction' })
  })
})
