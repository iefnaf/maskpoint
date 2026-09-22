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

/** What Pi does with our result: appends a compaction entry that keeps everything from `firstKeptEntryId`. */
async function compacted(entries: Entry[], keepFrom: string, options: Parameters<typeof beforeCompact>[2] = {}) {
  const result = toPiResult(native(await planCompaction(beforeCompact(entries, keepFrom, options), fakeContext()))).compaction
  // A session file is JSON: what comes back after a reload is the parsed text, not our objects.
  const details = JSON.parse(JSON.stringify(result.details))
  return { entry: compaction('c1', result.summary, result.firstKeptEntryId, details), details }
}

/** More work after the first compaction (which kept u2 and a3), ending in u4. */
const laterTurns = (): Entry[] => [
  assistant('b1', [text('Reading the component.'), toolCall('call-3', 'read', { path: '/workspace/app/panel.tsx' })]),
  toolResult('rb1', 'call-3', 'read', bulky('BODY-3')),
  assistant('b2', [text('Panel is updated.')]),
  user('u3', 'Now the docs.'),
  assistant('b3', [text('Docs read.')]),
  user('u4', 'Ship it.'),
  assistant('b5', [text('Shipping.')]),
]

describe('file operations — a first compaction', () => {
  it('records the paths Pi tracked, and only paths', async () => {
    const effect = native(
      await planCompaction(
        beforeCompact(firstTurn(), 'u2', {
          fileOps: { read: ['src/widget.ts', 'docs/widget.md'], written: ['src/panel.ts'], edited: ['README.md'] },
        }),
        fakeContext(),
      ),
    )
    expect(effect.detail.files).toEqual({
      read: ['src/widget.ts', 'docs/widget.md'],
      written: ['src/panel.ts'],
      edited: ['README.md'],
    })
    expect(JSON.stringify(effect.detail)).not.toContain('BODY-1')
  })

  it('records no file lists when Pi tracked none', async () => {
    const effect = native(await planCompaction(beforeCompact(firstTurn(), 'u2'), fakeContext()))
    expect(effect.detail).not.toHaveProperty('files')
  })
})

describe('file operations — across compactions', () => {
  it('merges what earlier compactions recorded with what Pi tracked since, in first-seen order, without repeats', async () => {
    const entries = firstTurn()
    const first = await compacted(entries, 'u2', {
      fileOps: { read: ['src/widget.ts', 'docs/widget.md'], written: ['src/panel.ts'] },
    })
    const session = [...entries, first.entry, ...laterTurns()]
    const second = native(
      await planCompaction(
        beforeCompact(session, 'u4', {
          // Pi does not fold a hook-written compaction's details into what it tracks, so this is only the new span.
          fileOps: { read: ['docs/widget.md', 'app/panel.tsx'], edited: ['src/panel.ts'] },
        }),
        fakeContext(),
      ),
    )
    expect(second.detail.files).toEqual({
      read: ['src/widget.ts', 'docs/widget.md', 'app/panel.tsx'],
      written: ['src/panel.ts'],
      edited: ['src/panel.ts'],
    })
  })

  it('keeps the earlier lists when Pi tracked nothing new', async () => {
    const entries = firstTurn()
    const first = await compacted(entries, 'u2', { fileOps: { read: ['src/widget.ts'] } })
    const second = native(await planCompaction(beforeCompact([...entries, first.entry, ...laterTurns()], 'u4'), fakeContext()))
    expect(second.detail.files).toEqual({ read: ['src/widget.ts'], written: [], edited: [] })
  })

  it('restores state from the session file alone: the details that were persisted are all it needs', async () => {
    const entries = firstTurn()
    const first = await compacted(entries, 'u2', { fileOps: { read: ['src/widget.ts'] } })
    // The compaction entry as a fresh process reads it back from disk, with nothing else carried over.
    const reloaded = JSON.parse(JSON.stringify([...entries, first.entry, ...laterTurns()])) as Entry[]
    const second = native(await planCompaction(beforeCompact(reloaded, 'u4', { fileOps: { written: ['src/panel.ts'] } }), fakeContext()))
    expect(second.detail.files).toEqual({ read: ['src/widget.ts'], written: ['src/panel.ts'], edited: [] })
  })

  it('carries the checkpoint count forward on a compaction that ran none', async () => {
    const entries = firstTurn()
    const first = await compacted(entries, 'u2')
    const earlier = { ...first.details, strategy: 'checkpoint', checkpoints: 4 }
    const session = [...entries, compaction('c1', 'a checkpoint', 'u2', earlier), ...laterTurns()]
    expect(native(await planCompaction(beforeCompact(session, 'u4'), fakeContext())).detail.checkpoints).toBe(4)
  })
})

describe('file operations — when Pi made the previous compaction', () => {
  const piSummary = '## Goal\nRename Widget to Panel.\n\n## Progress\n- [x] Found the usages.'

  it("relies on Pi's own tracking, which already folds in its earlier compaction, and does not parse Pi's details", async () => {
    // Pi's details shape is not ours. `stale.ts` is only in there, so seeing it would mean it was parsed.
    const piDetails = { readFiles: ['src/widget.ts', 'stale.ts'], modifiedFiles: [] }
    const session = [...firstTurn(), compaction('c1', piSummary, 'u2', piDetails), ...laterTurns()]
    const effect = native(
      await planCompaction(beforeCompact(session, 'u4', { fileOps: { read: ['src/widget.ts', 'app/panel.tsx'] } }), fakeContext()),
    )
    expect(effect.detail.files).toEqual({ read: ['src/widget.ts', 'app/panel.tsx'], written: [], edited: [] })
    expect(effect.detail.checkpoints).toBe(0)
  })

  it("reaches past Pi's compaction to the latest Maskpoint details on the branch", async () => {
    const entries = firstTurn()
    const first = await compacted(entries, 'u2', { fileOps: { read: ['src/widget.ts'] } })
    // Pi's compactor ran next and, as it does for a hook-written compaction, dropped the paths recorded in ours.
    const piEntry = compaction('c2', piSummary, 'u3', { readFiles: ['app/panel.tsx'], modifiedFiles: [] })
    const moreReading = [
      assistant('b4', [toolCall('call-6', 'read', { path: '/workspace/app/panel.tsx' })]),
      toolResult('rb4', 'call-6', 'read', bulky('BODY-6')),
    ]
    const session = [...entries, first.entry, ...laterTurns().slice(0, 4), piEntry, ...moreReading, ...laterTurns().slice(4)]
    const effect = native(await planCompaction(beforeCompact(session, 'u4', { fileOps: { read: ['app/panel.tsx'] } }), fakeContext()))
    expect(effect.detail.files).toEqual({ read: ['src/widget.ts', 'app/panel.tsx'], written: [], edited: [] })
  })
})

describe('compaction details that cannot be trusted', () => {
  const trusted = {
    v: 1,
    engine: 'maskpoint',
    strategy: 'checkpoint',
    checkpoints: 3,
    stats: { observationsMasked: 2, charsOmitted: 900, candidateTokens: 400 },
    files: { read: ['old.ts'], written: [], edited: [] },
    cursor: { boundaryId: 'u2#0', evictedThroughId: 'a2#0' },
  }
  const flawed: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['text', 'checkpoints: 3'],
    ['an empty object', {}],
    ["Pi's own shape", { readFiles: ['old.ts'], modifiedFiles: [] }],
    ['an older version', { ...trusted, v: 0 }],
    ['a newer version', { ...trusted, v: 2 }],
    ['another engine', { ...trusted, engine: 'other' }],
    ['an unknown strategy', { ...trusted, strategy: 'guess' }],
    ['a checkpoint count that is not a count', { ...trusted, checkpoints: -1 }],
    ['a checkpoint count that is text', { ...trusted, checkpoints: '3' }],
    ['statistics that are missing', { ...trusted, stats: undefined }],
    ['statistics that are not numbers', { ...trusted, stats: { ...trusted.stats, charsOmitted: 'many' } }],
    ['file lists that are not lists', { ...trusted, files: { read: 'old.ts', written: [], edited: [] } }],
    ['file lists holding something other than paths', { ...trusted, files: { read: ['old.ts', 7], written: [], edited: [] } }],
    ['a file list that is missing', { ...trusted, files: { read: ['old.ts'], written: [] } }],
    ['a cursor that is malformed', { ...trusted, cursor: { boundaryId: 'u2#0' } }],
  ]

  it.each(flawed)('treats details that are %s as absent: nothing is carried from them', async (_name, details) => {
    const session = [...firstTurn(), compaction('c1', 'an earlier summary', 'u2', details), ...laterTurns()]
    const effect = native(await planCompaction(beforeCompact(session, 'u4', { fileOps: { read: ['new.ts'] } }), fakeContext()))
    expect(effect.detail.checkpoints).toBe(0)
    expect(effect.detail.files).toEqual({ read: ['new.ts'], written: [], edited: [] })
  })

  it('still compacts, and carries the earlier summary, when its details are unusable', async () => {
    const session = [...firstTurn(), compaction('c1', 'an earlier summary', 'u2', { v: 9 }), ...laterTurns()]
    const effect = native(await planCompaction(beforeCompact(session, 'u4'), fakeContext()))
    expect(effect.summary.startsWith('an earlier summary')).toBe(true)
    expect(effect.detail).not.toHaveProperty('files')
  })

  it('trusts details that are whole', async () => {
    const session = [...firstTurn(), compaction('c1', 'an earlier summary', 'u2', trusted), ...laterTurns()]
    const effect = native(await planCompaction(beforeCompact(session, 'u4', { fileOps: { read: ['new.ts'] } }), fakeContext()))
    expect(effect.detail.checkpoints).toBe(3)
    expect(effect.detail.files).toEqual({ read: ['old.ts', 'new.ts'], written: [], edited: [] })
  })

  it('drops what it does not know: an unknown field in the details is not carried into the next', async () => {
    const session = [
      ...firstTurn(),
      compaction('c1', 'an earlier summary', 'u2', { ...trusted, bodies: 'BODY-SMUGGLED' }),
      ...laterTurns(),
    ]
    const effect = native(await planCompaction(beforeCompact(session, 'u4'), fakeContext()))
    expect(JSON.stringify(effect.detail)).not.toContain('BODY-SMUGGLED')
  })
})
