import { describe, expect, it } from 'vitest'
import type { Artifact, ConversationSnapshot, Decision, EngineDetail, Item, MaskedHistoryOutcome } from '../src/index.js'
import { decide, estimateTokens, roleLabel } from '../src/index.js'

const HUGE = { compactBudgetTokens: 1_000_000 }

const bulky = (mark: string, lines = 40): string =>
  Array.from({ length: lines }, (_, i) => `${mark} line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n')

/** A user turn, a tool call and its bulky result: three items, one observation. */
const turn = (n: number, body = bulky(`BODY-${n}`)): Item[] => [
  { id: `u${n}`, kind: 'user', text: `Request number ${n}.` },
  { id: `c${n}`, kind: 'tool-call', name: 'read', callId: `call-${n}`, args: `{"path":"/workspace/f${n}.ts"}` },
  { id: `t${n}`, kind: 'tool-result', name: 'read', callId: `call-${n}`, status: 'ok', text: body, media: 0 },
]

const snap = (items: Item[], boundaryId: string, extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  items,
  boundary: { id: boundaryId },
  reason: 'threshold',
  ...extra,
})

type Masked = MaskedHistoryOutcome

const asMasked = (outcome: Decision): Masked => {
  if (outcome.kind !== 'masked-history') throw new Error(`expected masked-history, got ${outcome.kind}`)
  return outcome
}

/** Stands in for an adapter's renderer: the text a host keeps as the previous compaction's state. */
const render = (artifact: Artifact): string =>
  artifact.sections
    .map((section) =>
      section.kind === 'checkpoint'
        ? section.text
        : section.items.map((item) => `[${item.id}] ${roleLabel(item)}: ${item.kind === 'tool-result' ? item.text : ''}`).join('\n'),
    )
    .join('\n\n')

/** The next snapshot, the way an adapter builds it from the previous outcome and the host's transcript. */
const next = (previous: Masked, items: Item[], boundaryId: string, extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot =>
  snap(items, boundaryId, {
    previousCheckpoint: render(previous.artifact),
    ...(previous.detail.cursor === undefined ? {} : { evictedThrough: previous.detail.cursor.evictedThroughId }),
    ...extra,
  })

describe('decide — a first compaction within budget', () => {
  const items = [...turn(1), ...turn(2), ...turn(3)]
  const decision = asMasked(decide(snap(items, 'u3'), HUGE))

  it('returns masked history for the span before the boundary, with observation bodies masked', () => {
    expect(decision.artifact.sections).toHaveLength(1)
    const [section] = decision.artifact.sections
    if (section?.kind !== 'masked-history') throw new Error('expected a masked-history section')
    expect(section.items.map((item) => item.id)).toEqual(['u1', 'c1', 't1', 'u2', 'c2', 't2'])
    expect(JSON.stringify(section.items)).not.toContain('BODY-1')
    expect(JSON.stringify(section.items)).not.toContain('BODY-2')
  })
})

describe('decide — accumulation across repeated compactions', () => {
  const all = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)]
  const first = asMasked(decide(snap(all, 'u3'), HUGE))
  const second = asMasked(decide(next(first, all, 'u5'), HUGE))

  it('records where the compacted span ended, so the next snapshot can continue from there', () => {
    expect(first.detail.cursor).toEqual({ boundaryId: 'u3', evictedThroughId: 't2' })
    expect(second.detail.cursor).toEqual({ boundaryId: 'u5', evictedThroughId: 't4' })
  })

  it('carries the previous state verbatim, then appends only the newly evicted masked history', () => {
    const [carried, appended] = second.artifact.sections
    expect(carried).toEqual({ kind: 'checkpoint', text: render(first.artifact) })
    if (appended?.kind !== 'masked-history') throw new Error('expected appended masked history')
    expect(appended.items.map((item) => item.id)).toEqual(['u3', 'c3', 't3', 'u4', 'c4', 't4'])
    expect(second.artifact.sections).toHaveLength(2)
  })

  it('never re-embeds an item, however many compactions have accumulated', () => {
    const third = asMasked(decide(next(second, [...all, ...turn(6), ...turn(7)], 'u7'), HUGE))
    const state = render(third.artifact)
    for (const id of ['u1', 't1', 'u2', 'u3', 't3', 'u4', 'u5', 't5', 'u6', 't6']) {
      expect(state.split(`[${id}]`).length - 1, id).toBe(1)
    }
    expect(state).not.toContain('[u7]')
  })

  it('never lets a full observation accumulate: no body appears anywhere in the state', () => {
    const state = render(second.artifact)
    for (const n of [1, 2, 3, 4]) expect(state).not.toContain(`BODY-${n}`)
  })

  it('counts observations masked and characters omitted for the newly evicted span only', () => {
    expect(second.stats.observationsMasked).toBe(2)
    expect(second.stats.charsOmitted).toBe(bulky('BODY-3').length + bulky('BODY-4').length)
    expect(second.detail.stats).toEqual(second.stats)
  })
})

describe('decide — the budget decision', () => {
  const all = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)]
  const first = asMasked(decide(snap(all, 'u3'), HUGE))
  const accumulated = (budget: number, extra: Partial<ConversationSnapshot> = {}) =>
    decide(next(first, all, 'u5', extra), { compactBudgetTokens: budget })
  const size = asMasked(accumulated(1_000_000)).stats.candidateTokens

  it('measures the whole candidate: the previous state as well as the newly evicted history', () => {
    const previous = render(first.artifact)
    expect(size).toBeGreaterThan(estimateTokens(previous))
    expect(size).toBeGreaterThan(first.stats.candidateTokens)
  })

  it('returns masked history when the candidate is exactly at budget', () => {
    expect(accumulated(size).kind).toBe('masked-history')
  })

  it('requests a checkpoint when the candidate is immediately above budget, carrying masked history as the fallback', () => {
    const decision = accumulated(size - 1)
    if (decision.kind !== 'checkpoint-requested') throw new Error(`expected checkpoint-requested, got ${decision.kind}`)
    expect(decision.reason).toBe('over-budget')
    expect(decision.fallback).toEqual(accumulated(size))
  })

  it('returns masked history well under budget and requests a checkpoint well over it', () => {
    expect(accumulated(size * 10).kind).toBe('masked-history')
    expect(accumulated(1).kind).toBe('checkpoint-requested')
  })

  it('decides synchronously: nothing is awaited on the masked path, and decide is handed no model', () => {
    // The structural guarantee is decide's signature (snapshot and budget only) plus purity.test.ts,
    // which keeps I/O out of core. This documents it: the decision is a value, not a pending call.
    expect(accumulated(size)).not.toBeInstanceOf(Promise)
  })

  it('gives the artifact, the detail and the outcome their own statistics, so changing one cannot change another', () => {
    const outcome = asMasked(accumulated(size))
    expect(outcome.artifact.stats).not.toBe(outcome.stats)
    expect(outcome.detail.stats).not.toBe(outcome.stats)
    expect(outcome.detail.stats).not.toBe(outcome.artifact.stats)
    expect(outcome.detail.stats).toEqual(outcome.stats)
  })

  it('requests a checkpoint whenever custom instructions are present, however small the candidate', () => {
    const decision = accumulated(1_000_000, { customInstructions: 'focus on the migration' })
    if (decision.kind !== 'checkpoint-requested') throw new Error(`expected checkpoint-requested, got ${decision.kind}`)
    expect(decision.reason).toBe('custom-instructions')
  })

  it('does not treat blank custom instructions as instructions', () => {
    expect(accumulated(1_000_000, { customInstructions: '  \n' }).kind).toBe('masked-history')
  })

  it('takes the checkpoint path, never the masked one, when the budget or the estimate cannot be compared', () => {
    for (const bad of [Number.NaN, -1]) expect(accumulated(bad).kind, String(bad)).toBe('checkpoint-requested')
  })

  it('still declines on an untrusted snapshot rather than requesting a checkpoint for it', () => {
    expect(decide(snap(all, 'nowhere'), { compactBudgetTokens: 1 })).toEqual({ kind: 'decline', reason: 'masking-failure' })
    expect(decide(snap(all, 'u3', { previousCheckpoint: 'x' }), { compactBudgetTokens: 1 })).toEqual({
      kind: 'decline',
      reason: 'inconsistent-cursor',
    })
  })
})

describe('decide — file operations merge rather than replace', () => {
  const all = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)]
  const previousDetail = (files?: EngineDetail['files'], checkpoints = 0): EngineDetail => ({
    v: 1,
    engine: 'maskpoint',
    strategy: 'mask',
    checkpoints,
    stats: { observationsMasked: 0, charsOmitted: 0, candidateTokens: 0 },
    ...(files === undefined ? {} : { files }),
  })
  const filesOf = (extra: Partial<ConversationSnapshot>) =>
    asMasked(decide(snap(all, 'u3', extra), HUGE)).detail.files
  const continued = (extra: Partial<ConversationSnapshot>) =>
    asMasked(decide(snap(all, 'u5', { previousCheckpoint: 'state', evictedThrough: 't2', ...extra }), HUGE)).detail.files

  it('keeps the earlier lists and adds the host’s new operations to them, without duplicates, in order', () => {
    expect(
      continued({
        previousDetail: previousDetail({ read: ['/a.ts', '/b.ts'], written: ['/w.ts'], edited: [] }),
        fileOps: { read: ['/b.ts', '/c.ts'], written: [], edited: ['/e.ts', '/e.ts'] },
      }),
    ).toEqual({ read: ['/a.ts', '/b.ts', '/c.ts'], written: ['/w.ts'], edited: ['/e.ts'] })
  })

  it('keeps the earlier lists when the host supplies no new operations', () => {
    const files = { read: ['/a.ts'], written: [], edited: ['/e.ts'] }
    expect(continued({ previousDetail: previousDetail(files) })).toEqual(files)
  })

  it('starts from the host’s operations when there is no earlier state', () => {
    expect(filesOf({ fileOps: { read: ['/a.ts'], written: [], edited: [] } })).toEqual({ read: ['/a.ts'], written: [], edited: [] })
  })

  it('reports no file lists at all when neither side has any', () => {
    expect(filesOf({})).toBeUndefined()
    expect(continued({ previousDetail: previousDetail() })).toBeUndefined()
  })

  it('does not mutate what the adapter passed in', () => {
    const previous = previousDetail({ read: ['/a.ts'], written: [], edited: [] })
    const fileOps = { read: ['/b.ts'], written: [], edited: [] }
    continued({ previousDetail: previous, fileOps })
    expect(previous.files).toEqual({ read: ['/a.ts'], written: [], edited: [] })
    expect(fileOps).toEqual({ read: ['/b.ts'], written: [], edited: [] })
  })

  it('carries the checkpoint count forward on the masked path', () => {
    const outcome = asMasked(
      decide(snap(all, 'u5', { previousCheckpoint: 'state', evictedThrough: 't2', previousDetail: previousDetail(undefined, 3) }), HUGE),
    )
    expect(outcome.detail.checkpoints).toBe(3)
  })
})

describe('decide — the persisted detail', () => {
  const all = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)]
  const outcome = asMasked(
    decide(
      snap(all, 'u3', { fileOps: { read: ['/workspace/f1.ts'], written: [], edited: [] } }),
      HUGE,
    ),
  )

  it('is versioned and carries strategy, checkpoint count, statistics, file lists and the cursor', () => {
    expect(outcome.detail).toEqual({
      v: 1,
      engine: 'maskpoint',
      strategy: 'mask',
      checkpoints: 0,
      stats: { observationsMasked: 2, charsOmitted: bulky('BODY-1').length + bulky('BODY-2').length, candidateTokens: outcome.stats.candidateTokens },
      files: { read: ['/workspace/f1.ts'], written: [], edited: [] },
      cursor: { boundaryId: 'u3', evictedThroughId: 't2' },
    })
    expect(outcome.detail.stats.candidateTokens).toBeGreaterThan(0)
  })

  it('contains no observation body, whole or in part', () => {
    const persisted = JSON.stringify(outcome.detail)
    for (const item of all) {
      if (item.kind !== 'tool-result') continue
      expect(persisted).not.toContain(item.text?.slice(0, 20))
    }
    expect(persisted).not.toContain('BODY-')
  })

  it('survives a round trip through JSON, as it will when a host persists it', () => {
    expect(JSON.parse(JSON.stringify(outcome.detail))).toEqual(outcome.detail)
  })
})

describe('decide — a missing or inconsistent cursor declines instead of double-appending', () => {
  const all = [...turn(1), ...turn(2), ...turn(3), ...turn(4)]
  const state = 'previous compaction state'
  const declined = (extra: Partial<ConversationSnapshot>, boundaryId = 'u4') =>
    decide(snap(all, boundaryId, extra), HUGE)

  it('declines when there is previous state but no cursor saying what it represents', () => {
    expect(declined({ previousCheckpoint: state })).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('declines when there is a cursor but no previous state holding what it claims is represented', () => {
    expect(declined({ evictedThrough: 't2' })).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('declines when the cursor names an item that is not in the snapshot', () => {
    expect(declined({ previousCheckpoint: state, evictedThrough: 'gone' })).toEqual({
      kind: 'decline',
      reason: 'inconsistent-cursor',
    })
  })

  it('declines when the cursor reaches into what the host retains, which would duplicate the retained suffix', () => {
    expect(declined({ previousCheckpoint: state, evictedThrough: 'u4' })).toEqual({
      kind: 'decline',
      reason: 'inconsistent-cursor',
    })
    expect(declined({ previousCheckpoint: state, evictedThrough: 't4' })).toEqual({
      kind: 'decline',
      reason: 'inconsistent-cursor',
    })
  })

  it('accepts a cursor sitting exactly at the last item before the boundary, and appends nothing new', () => {
    const outcome = asMasked(declined({ previousCheckpoint: state, evictedThrough: 't3' }))
    expect(outcome.artifact.sections).toEqual([{ kind: 'checkpoint', text: state }])
    expect(outcome.stats).toMatchObject({ observationsMasked: 0, charsOmitted: 0 })
    expect(outcome.detail.cursor).toEqual({ boundaryId: 'u4', evictedThroughId: 't3' })
  })

  it('declines rather than returning an empty artifact when there is nothing to compact', () => {
    expect(declined({}, 'u1')).toEqual({ kind: 'decline', reason: 'nothing-to-compact' })
  })

  it('treats empty previous state as no state, so it can neither back a cursor nor make an empty artifact', () => {
    expect(declined({ previousCheckpoint: '', evictedThrough: 't3' })).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
    expect(declined({ previousCheckpoint: '' }, 'u1')).toEqual({ kind: 'decline', reason: 'nothing-to-compact' })
    const first = asMasked(declined({ previousCheckpoint: '' }))
    expect(first.artifact.sections.map((section) => section.kind)).toEqual(['masked-history'])
  })

  it('declines when the previous compaction left details but there is no previous state to append to', () => {
    const previousDetail: EngineDetail = {
      v: 1,
      engine: 'maskpoint',
      strategy: 'mask',
      checkpoints: 3,
      stats: { observationsMasked: 1, charsOmitted: 10, candidateTokens: 5 },
      cursor: { boundaryId: 'u3', evictedThroughId: 't2' },
    }
    expect(declined({ previousDetail })).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
    expect(declined({ previousDetail, evictedThrough: 't2' })).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('declines when the ids or the boundary cannot be trusted', () => {
    expect(declined({}, 'nowhere')).toEqual({ kind: 'decline', reason: 'masking-failure' })
    const clash: Item[] = [...turn(1), { id: 'u1', kind: 'user', text: 'a second item with the same id' }, ...turn(2)]
    expect(decide(snap(clash, 'u2'), HUGE)).toEqual({ kind: 'decline', reason: 'masking-failure' })
  })
})

describe('decide — masking every body for an adapter that persists the result', () => {
  const secret = 'AWS_SECRET_ACCESS_KEY=abc123'
  const items: Item[] = [
    ...turn(1, secret),
    ...turn(2),
    { id: 'u3', kind: 'user', text: 'The retained request.' },
  ]

  it('keeps a tiny observation verbatim by default, since masking it would only enlarge the history', () => {
    const outcome = asMasked(decide(snap(items, 'u3'), HUGE))
    expect(JSON.stringify(outcome.artifact)).toContain(secret)
  })

  it('leaves no observation body anywhere in the artifact or its statistics when asked to mask every body', () => {
    const outcome = asMasked(decide(snap(items, 'u3'), HUGE, { alwaysMask: true }))
    expect(JSON.stringify(outcome)).not.toContain(secret)
    expect(outcome.stats.observationsMasked).toBe(2)
  })

  it('measures the candidate on what it returns, so the budget sees the placeholder, not the body', () => {
    const plain = asMasked(decide(snap(items, 'u3'), HUGE))
    const all = asMasked(decide(snap(items, 'u3'), HUGE, { alwaysMask: true }))
    expect(all.stats.candidateTokens).not.toBe(plain.stats.candidateTokens)
  })
})
