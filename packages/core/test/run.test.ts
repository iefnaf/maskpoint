import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, EngineDeps, Item } from '../src/index.js'
import { run, runMaskOnly } from '../src/index.js'

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

/** An `EngineDeps` whose one call is recorded, then answered with a usable checkpoint. */
const deps = (calls: string[]): EngineDeps => ({
  complete: async () => {
    calls.push('complete')
    return { stopReason: 'stop', text: '# Checkpoint\n\n## 1. User context and constraints\n\n- stub' }
  },
  newRoutingId: () => 'routing-1',
  signal: { aborted: false },
  checkpoint: { maxOutputTokens: 4_000 },
})

describe('runMaskOnly — the checkpoint call refused (`checkpointEnabled: false`)', () => {
  const items = [...turn(1), ...turn(2), ...turn(3)]
  const overBudget = { compactBudgetTokens: 1 }
  const withinBudget = { compactBudgetTokens: 1_000_000 }

  it('returns the masked history an over-budget decision would have condensed, recording no rejection', () => {
    const outcome = runMaskOnly(snap(items, 'u3'), overBudget)
    expect(outcome.kind).toBe('masked-history')
    if (outcome.kind === 'masked-history') expect(outcome.checkpointRejection).toBeUndefined()
  })

  it('degrades a manual focus request the same way, budget notwithstanding', () => {
    const snapshot = snap(items, 'u3', { customInstructions: 'keep the failing test front of mind' })
    const outcome = runMaskOnly(snapshot, withinBudget)
    expect(outcome.kind).toBe('masked-history')
  })

  it('is the same gate `run` honours: the over-budget snapshot makes one call through run, none through runMaskOnly', async () => {
    const viaRun: string[] = []
    const checkpoint = await run(snap(items, 'u3'), overBudget, deps(viaRun))
    expect(checkpoint.kind).toBe('checkpoint')
    expect(viaRun).toEqual(['complete'])

    const viaMaskOnly: string[] = []
    const masked = runMaskOnly(snap(items, 'u3'), overBudget)
    expect(masked.kind).toBe('masked-history')
    expect(viaMaskOnly).toEqual([])
  })

  it('returns declines unchanged, exactly as run would', () => {
    // The boundary names the first item, so nothing precedes it: the artifact would be empty.
    expect(runMaskOnly(snap([...turn(1)], 'u1'), overBudget)).toEqual({ kind: 'decline', reason: 'nothing-to-compact' })
  })
})
