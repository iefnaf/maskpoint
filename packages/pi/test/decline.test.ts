import { describe, expect, it } from 'vitest'
import { planCompaction } from '../src/compact.js'
import { firstTurn } from './support/scenario.js'
import { assistant, beforeCompact, fakeContext, modelChange } from './support/session.js'

/** Hand the adapter something Pi's types would not allow, as a damaged or newer session file can. */
const plan = (event: unknown) => planCompaction(event as Parameters<typeof planCompaction>[0], fakeContext())

const message = (id: string, body: Record<string, unknown>) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: 't',
  message: body,
})

// Custom-instructions behaviour (forcing a checkpoint, blank instructions counting as none) moved to
// checkpoint.test.ts once the checkpoint path landed (issue #7): declining is no longer what happens.

describe('planCompaction — shapes it does not understand', () => {
  it('declines on a message with an unknown role in the compacted span', async () => {
    const entries = firstTurn()
    entries.splice(3, 0, message('x1', { role: 'hologram', content: 'hi' }))
    expect(await planCompaction(beforeCompact(entries, 'u2'), fakeContext())).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('declines on an unknown content block in the compacted span', async () => {
    const entries = firstTurn()
    entries[1] = assistant('a1', [{ type: 'hologram', data: 'x' }])
    expect(await planCompaction(beforeCompact(entries, 'u2'), fakeContext())).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('does not mind an unfamiliar shape in the region Pi retains', async () => {
    const entries = firstTurn()
    entries.push(message('x1', { role: 'hologram', content: 'hi' }))
    expect((await planCompaction(beforeCompact(entries, 'u2'), fakeContext())).kind).toBe('native')
  })

  it('declines when the first kept entry is not on the branch', async () => {
    const event = beforeCompact(firstTurn(), 'u2')
    const damaged = { ...event, preparation: { ...event.preparation, firstKeptEntryId: 'nowhere' } }
    expect(await plan(damaged)).toMatchObject({ kind: 'decline', reason: 'unreadable-snapshot' })
  })

  it('declines when Pi prepared a different number of messages than the branch holds', async () => {
    const event = beforeCompact(firstTurn(), 'u2')
    const fewer = event.preparation.messagesToSummarize.slice(1)
    const damaged = { ...event, preparation: { ...event.preparation, messagesToSummarize: fewer } }
    expect(await plan(damaged)).toMatchObject({ kind: 'decline', reason: 'unreadable-snapshot' })
  })

  it('declines on a new kind of entry that Pi counts as conversation but this adapter does not know', async () => {
    const entries = firstTurn()
    const event = beforeCompact(entries, 'u2')
    entries.splice(2, 0, { type: 'hologram', id: 'x1', parentId: null, timestamp: 't' })
    // A newer Pi counts the unknown entry as one more message to summarize.
    const preparation = {
      ...event.preparation,
      messagesToSummarize: [...event.preparation.messagesToSummarize, {}],
    }
    expect(await plan({ ...event, branchEntries: entries, preparation })).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('ignores entries that carry no conversation', async () => {
    const entries = firstTurn()
    entries.splice(1, 0, modelChange('m1'))
    expect((await planCompaction(beforeCompact(entries, 'u2'), fakeContext())).kind).toBe('native')
  })

  it.each([
    ['no branch entries', { branchEntries: undefined }],
    ['no preparation', { preparation: undefined }],
    ['entries that are not objects', { branchEntries: [null, 3, 'x'] }],
    ['entries without ids', { branchEntries: [{ type: 'message' }] }],
  ])('declines rather than throwing on %s', async (_name, damage) => {
    expect((await plan({ ...beforeCompact(firstTurn(), 'u2'), ...damage })).kind).toBe('decline')
  })

  it('never throws, whatever the event is', async () => {
    for (const event of [undefined, null, 42, 'x', {}, { preparation: {}, branchEntries: [] }]) {
      expect((await plan(event)).kind).toBe('decline')
    }
  })
})
