import {
  type ConversationSnapshot,
  type Decision,
  decide,
  estimateTokens,
  type Item,
  type MaskedHistoryOutcome,
} from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { type CorpusFixture, loadCorpus } from '../src/corpus.js'
import { boundaryIndex, payload } from '../src/items.js'
import { plainTextRenderer } from '../src/replay.js'

/**
 * Seam 1 for accumulation and the budget decision: the engine over neutral snapshots, driven by
 * the shared corpus. No host, no model, no network.
 */

const corpus = loadCorpus()
const fixture = (name: string): CorpusFixture => {
  const found = corpus.find((each) => each.name === name)
  if (!found) throw new Error(`no fixture ${name}`)
  return found
}

const HUGE = { checkpointTriggerTokens: 1_000_000 }
const withoutFocus = (snapshot: ConversationSnapshot): ConversationSnapshot => {
  const { customInstructions: _focus, ...rest } = snapshot
  return rest
}
const masked = (decision: Decision): MaskedHistoryOutcome => {
  if (decision.kind !== 'masked-history') throw new Error(`expected masked-history, got ${decision.kind}`)
  return decision
}
const idsOf = (outcome: MaskedHistoryOutcome): string[] =>
  outcome.artifact.sections.flatMap((section) => (section.kind === 'masked-history' ? section.items.map((item) => item.id) : []))

const bodies = (items: readonly Item[], minLength: number): string[] =>
  items.flatMap((item) => (item.kind === 'tool-result' && (item.text?.length ?? 0) >= minLength ? [item.text ?? ''] : []))

/** Two more turns after a fixture's transcript, the second of which the host retains. */
const tail = (label: string): Item[] => [
  { id: `${label}-user`, kind: 'user', text: 'One more thing, please.' },
  { id: `${label}-call`, kind: 'tool-call', name: 'read', callId: `${label}-c`, args: '{"path":"/workspace/app/notes.md"}' },
  { id: `${label}-result`, kind: 'tool-result', name: 'read', callId: `${label}-c`, status: 'ok', text: 'NOTES-BODY '.repeat(80), media: 0 },
]

describe.each(corpus.map((each) => [each.name, each] as const))('the decision layer over the %s fixture', (_name, each) => {
  const { snapshot } = each
  const plain = withoutFocus(snapshot)
  const cut = boundaryIndex(snapshot)
  const represented = snapshot.evictedThrough === undefined ? 0 : snapshot.items.findIndex((item) => item.id === snapshot.evictedThrough) + 1
  const outcome = masked(decide(plain, HUGE))

  it('carries previous state verbatim and appends only what the host evicted since', () => {
    const [first] = outcome.artifact.sections
    if (snapshot.previousCheckpoint !== undefined) {
      expect(first).toEqual({ kind: 'checkpoint', text: snapshot.previousCheckpoint })
    }
    expect(idsOf(outcome)).toEqual(snapshot.items.slice(represented, cut).map((item) => item.id))
  })

  it('draws the line at the budget: exactly at budget is masked history, one token under is a checkpoint request', () => {
    const size = outcome.stats.candidateTokens
    expect(size).toBeGreaterThan(0)
    expect(decide(plain, { checkpointTriggerTokens: size }).kind).toBe('masked-history')
    const over = decide(plain, { checkpointTriggerTokens: size - 1 })
    if (over.kind !== 'checkpoint-requested') throw new Error(`expected checkpoint-requested, got ${over.kind}`)
    expect(over.reason).toBe('over-budget')
    expect(over.fallback).toEqual(outcome)
  })

  it('persists a detail with strategy, counts, candidate size and the cursor, and no observation body', () => {
    const { detail } = outcome
    expect(detail).toMatchObject({ v: 1, engine: 'maskpoint', strategy: 'mask', stats: outcome.stats })
    expect(detail.checkpoints).toBe(snapshot.previousDetail?.checkpoints ?? 0)
    expect(detail.cursor).toEqual({ boundaryId: snapshot.boundary.id, evictedThroughId: snapshot.items[cut - 1]?.id })
    const persisted = JSON.stringify(detail)
    for (const body of bodies(snapshot.items, 24)) {
      expect(persisted).not.toContain(JSON.stringify(body).slice(1, 25))
    }
  })

  it('appends the next compaction to the returned artifact without re-embedding anything', () => {
    const items = [...snapshot.items, ...tail('a'), ...tail('b')]
    const next = masked(
      decide(
        {
          items,
          boundary: { id: 'b-user' },
          reason: 'threshold',
          previousCheckpoint: plainTextRenderer.render(outcome.artifact),
          ...(outcome.detail.cursor === undefined ? {} : { evictedThrough: outcome.detail.cursor.evictedThroughId }),
          previousDetail: outcome.detail,
        },
        HUGE,
      ),
    )
    expect(idsOf(next)).toEqual([...snapshot.items.slice(cut), ...tail('a')].map((item) => item.id))
    for (const id of idsOf(next)) expect(idsOf(outcome), id).not.toContain(id)

    // No full observation has crept into the state: every large one that was newly evicted is a
    // placeholder now. (Checked on the items, not by searching the text: tool-call arguments are
    // preserved on purpose and may legitimately repeat what an observation returned.)
    const appended = next.artifact.sections.flatMap((section) => (section.kind === 'masked-history' ? section.items : []))
    const evictedNow = [...snapshot.items.slice(cut), ...tail('a')]
    for (const original of evictedNow) {
      if (original.kind !== 'tool-result' || (original.text?.length ?? 0) < 200 || original.masked) continue
      const after = appended.find((item) => item.id === original.id)
      expect(after, original.id).toMatchObject({ kind: 'tool-result', masked: true })
      expect((after as { text?: string }).text, original.id).not.toBe(original.text)
    }
    expect(next.stats.observationsMasked).toBeGreaterThanOrEqual(1)
  })
})

describe('the decision layer over specific corpus shapes', () => {
  it('treats the previous checkpoint as part of the candidate', () => {
    const { snapshot } = fixture('host-context')
    const candidate = masked(decide(snapshot, HUGE)).stats.candidateTokens
    // Bigger than the earlier state alone, so the newly evicted history counts too...
    expect(candidate).toBeGreaterThan(estimateTokens(snapshot.previousCheckpoint ?? ''))
    // ...and a budget that only the earlier state would fit does not fit the candidate.
    const stateOnly = estimateTokens(snapshot.previousCheckpoint ?? '')
    expect(decide(snapshot, { checkpointTriggerTokens: stateOnly }).kind).toBe('checkpoint-requested')
  })

  it('merges the host’s file operations into the earlier lists rather than replacing them', () => {
    const { detail } = masked(decide(fixture('host-context').snapshot, HUGE))
    expect(detail.files).toEqual({
      read: ['/workspace/app/src/billing/invoice.ts', '/workspace/app/src/billing/ledger.ts', '/workspace/app/src/billing/payments.ts'],
      written: [],
      edited: ['/workspace/app/src/billing/invoice.ts', '/workspace/app/src/billing/ledger.ts', '/workspace/app/src/billing/payments.ts'],
    })
  })

  it('carries the earlier checkpoint count through a masked compaction', () => {
    expect(masked(decide(fixture('host-context').snapshot, HUGE)).detail.checkpoints).toBe(1)
  })

  it('reports no file lists for a session that tracks none', () => {
    expect(masked(decide(fixture('text-observations').snapshot, HUGE)).detail.files).toBeUndefined()
  })

  it('requests a checkpoint for custom instructions even with the budget to spare', () => {
    const { snapshot } = fixture('cjk')
    expect(snapshot.customInstructions).toBeTruthy()
    const decision = decide(snapshot, HUGE)
    if (decision.kind !== 'checkpoint-requested') throw new Error(`expected checkpoint-requested, got ${decision.kind}`)
    expect(decision.reason).toBe('custom-instructions')
    expect(decision.fallback.kind).toBe('masked-history')
  })

  it('declines when the cursor is dropped from a snapshot that has previous state', () => {
    const { evictedThrough: _e, ...missing } = fixture('host-context').snapshot
    expect(decide(missing, HUGE)).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('declines when the cursor points into the region the host retains', () => {
    const { snapshot } = fixture('host-context')
    const retained = snapshot.items[boundaryIndex(snapshot) + 1]
    expect(decide({ ...snapshot, evictedThrough: retained?.id ?? '' }, HUGE)).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })
})

describe('the estimator is conservative on CJK and code-heavy text', () => {
  const textOf = ({ snapshot }: CorpusFixture): string => snapshot.items.map(payload).filter((text) => text !== '').join('\n')
  const codePoints = (text: string) => [...text].length
  const naive = (text: string) => Math.ceil(codePoints(text) / 4)
  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/

  it.each(corpus.map((each) => [each.name, each] as const))('never estimates below the chars/4 rule of thumb on %s', (_name, each) => {
    const text = textOf(each)
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(naive(text))
  })

  it('weights CJK text above its character count, and several times above the chars/4 rule', () => {
    const text = textOf(fixture('cjk'))
    const cjkCharacters = [...text].filter((character) => CJK.test(character)).length
    expect(cjkCharacters).toBeGreaterThan(100)
    expect(estimateTokens(text)).toBeGreaterThan(cjkCharacters)
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(2 * naive(text))
  })

  it('weights a CJK observation more heavily than same-length English prose', () => {
    const cjk = fixture('cjk').snapshot.items.filter((item) => item.kind === 'tool-result').map(payload).find((text) => CJK.test(text))
    expect(cjk).toBeDefined()
    const english = 'e'.repeat(codePoints(cjk ?? ''))
    expect(estimateTokens(cjk ?? '')).toBeGreaterThan(estimateTokens(english))
  })

  it('weights bulky code more than the chars/4 rule, for the code-heavy observations', () => {
    const code = bodies(fixture('code-heavy').snapshot.items, 1).filter((text) => text.split('\n').length >= 30)
    expect(code.length).toBeGreaterThanOrEqual(2)
    for (const text of code) expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(naive(text) * 1.1))
  })

  it('cannot let a CJK session slip under a budget the chars/4 rule would have met', () => {
    const { snapshot } = fixture('cjk')
    const plain = withoutFocus(snapshot)
    const compacted = snapshot.items.slice(0, boundaryIndex(snapshot))
    const budget = naive(compacted.map(payload).join('\n'))
    expect(decide(plain, { checkpointTriggerTokens: budget }).kind).toBe('checkpoint-requested')
  })
})
