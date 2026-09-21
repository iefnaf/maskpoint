import { describe, expect, it } from 'vitest'
import { planCompaction } from '../src/compact.js'
import { firstTurn } from './support/scenario.js'
import { assistant, beforeCompact, modelChange } from './support/session.js'

/** Hand the adapter something Pi's types would not allow, as a damaged or newer session file can. */
const plan = (event: unknown) => planCompaction(event as Parameters<typeof planCompaction>[0])

const message = (id: string, body: Record<string, unknown>) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: 't',
  message: body,
})

describe('planCompaction — custom instructions', () => {
  it('declines so that Pi honours the focus with its own compactor', () => {
    const effect = planCompaction(
      beforeCompact(firstTurn(), 'u2', { reason: 'manual', customInstructions: 'focus on the docs' }),
    )
    expect(effect).toMatchObject({ kind: 'decline', reason: 'checkpoint-unavailable' })
  })

  it('treats blank instructions as none', () => {
    const effect = planCompaction(beforeCompact(firstTurn(), 'u2', { reason: 'manual', customInstructions: '   ' }))
    expect(effect.kind).toBe('native')
  })
})

describe('planCompaction — shapes it does not understand', () => {
  it('declines on a message with an unknown role in the compacted span', () => {
    const entries = firstTurn()
    entries.splice(3, 0, message('x1', { role: 'hologram', content: 'hi' }))
    expect(planCompaction(beforeCompact(entries, 'u2'))).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('declines on an unknown content block in the compacted span', () => {
    const entries = firstTurn()
    entries[1] = assistant('a1', [{ type: 'hologram', data: 'x' }])
    expect(planCompaction(beforeCompact(entries, 'u2'))).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('does not mind an unfamiliar shape in the region Pi retains', () => {
    const entries = firstTurn()
    entries.push(message('x1', { role: 'hologram', content: 'hi' }))
    expect(planCompaction(beforeCompact(entries, 'u2')).kind).toBe('native')
  })

  it('declines when the first kept entry is not on the branch', () => {
    const event = beforeCompact(firstTurn(), 'u2')
    const damaged = { ...event, preparation: { ...event.preparation, firstKeptEntryId: 'nowhere' } }
    expect(plan(damaged)).toMatchObject({ kind: 'decline', reason: 'unreadable-snapshot' })
  })

  it('declines when Pi prepared a different number of messages than the branch holds', () => {
    const event = beforeCompact(firstTurn(), 'u2')
    const fewer = event.preparation.messagesToSummarize.slice(1)
    const damaged = { ...event, preparation: { ...event.preparation, messagesToSummarize: fewer } }
    expect(plan(damaged)).toMatchObject({ kind: 'decline', reason: 'unreadable-snapshot' })
  })

  it('declines on a new kind of entry that Pi counts as conversation but this adapter does not know', () => {
    const entries = firstTurn()
    const event = beforeCompact(entries, 'u2')
    entries.splice(2, 0, { type: 'hologram', id: 'x1', parentId: null, timestamp: 't' })
    // A newer Pi counts the unknown entry as one more message to summarize.
    const preparation = {
      ...event.preparation,
      messagesToSummarize: [...event.preparation.messagesToSummarize, {}],
    }
    expect(plan({ ...event, branchEntries: entries, preparation })).toMatchObject({
      kind: 'decline',
      reason: 'unreadable-snapshot',
    })
  })

  it('ignores entries that carry no conversation', () => {
    const entries = firstTurn()
    entries.splice(1, 0, modelChange('m1'))
    expect(planCompaction(beforeCompact(entries, 'u2')).kind).toBe('native')
  })

  it.each([
    ['no branch entries', { branchEntries: undefined }],
    ['no preparation', { preparation: undefined }],
    ['entries that are not objects', { branchEntries: [null, 3, 'x'] }],
    ['entries without ids', { branchEntries: [{ type: 'message' }] }],
  ])('declines rather than throwing on %s', (_name, damage) => {
    expect(plan({ ...beforeCompact(firstTurn(), 'u2'), ...damage }).kind).toBe('decline')
  })

  it('never throws, whatever the event is', () => {
    for (const event of [undefined, null, 42, 'x', {}, { preparation: {}, branchEntries: [] }]) {
      expect(plan(event).kind).toBe('decline')
    }
  })
})
