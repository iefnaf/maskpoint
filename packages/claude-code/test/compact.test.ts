import { describe, expect, it } from 'vitest'
import type { EngineDetail } from '@maskpoint/core'
import { capabilities, type CcEffect, planCompaction } from '../src/compact.js'
import type { PersistedState } from '../src/state.js'
import { assistantText, bulky, compaction, toolResult, toolUse, user } from './support/transcript.js'

const HUGE = { checkpointTriggerTokens: 1_000_000 }
const TINY = { checkpointTriggerTokens: 1 }

const assisted = (effect: CcEffect): Extract<CcEffect, { kind: 'assisted' }> => {
  if (effect.kind !== 'assisted') throw new Error(`expected assisted, got decline: ${effect.reason} ${effect.note ?? ''}`)
  return effect
}

const SESSION = [
  user('Read config.ts and summarize it.'),
  toolUse('call-1', 'read', { path: 'config.ts' }),
  toolResult('call-1', bulky('CONFIG-BODY')),
  assistantText('Here is the summary.'),
]

describe('capabilities — the tier this adapter reports', () => {
  it('never claims to replace the host compactor', () => {
    expect(capabilities.replaceHistory).toBe(false)
  })

  it('reports what it can and cannot do', () => {
    expect(capabilities).toMatchObject({ reinjectContext: true, persistMetadata: true, injectionCapChars: 10_000 })
  })
})

describe('planCompaction — the pre-compaction decision', () => {
  it('masks the whole transcript into an artifact on a first compaction', () => {
    const effect = assisted(planCompaction(SESSION, { trigger: 'auto' }, undefined, HUGE))
    expect(effect.checkpointText).toContain('Here is the summary.')
    expect(effect.checkpointText).not.toContain('CONFIG-BODY')
    expect(effect.detail).toMatchObject({ v: 1, engine: 'maskpoint', strategy: 'mask' })
  })

  it('masks even a tiny observation the no-expansion rule would otherwise leave verbatim', () => {
    const withSecret = [user('Print the key.'), toolUse('call-1', 'bash', { command: 'echo $KEY' }), toolResult('call-1', 'sk-tiny-secret')]
    const effect = assisted(planCompaction(withSecret, { trigger: 'auto' }, undefined, HUGE))
    expect(effect.checkpointText).not.toContain('sk-tiny-secret')
  })

  it('declines when the transcript could not be read', () => {
    expect(planCompaction(undefined, { trigger: 'auto' }, undefined, HUGE)).toEqual({
      kind: 'decline',
      reason: 'unreadable-snapshot',
      note: expect.any(String),
    })
  })

  it('declines when there is nothing to compact', () => {
    expect(planCompaction([], { trigger: 'auto' }, undefined, HUGE)).toEqual({ kind: 'decline', reason: 'nothing-to-compact' })
  })

  it('reports over-budget rather than declining, and still returns a usable artifact', () => {
    const effect = assisted(planCompaction(SESSION, { trigger: 'auto' }, undefined, TINY))
    expect(effect.overBudget).toBe(true)
    expect(effect.focusRequested).toBe(false)
    expect(effect.checkpointText.length).toBeGreaterThan(0)
  })

  it('reports a requested focus rather than declining, since this adapter cannot run a checkpoint yet', () => {
    const effect = assisted(planCompaction(SESSION, { trigger: 'manual', customInstructions: 'focus on the config parsing' }, undefined, HUGE))
    expect(effect.focusRequested).toBe(true)
    expect(effect.overBudget).toBe(false)
  })

  it('builds on the previous artifact: only newly evicted history is appended, and the old candidate text is kept verbatim', () => {
    const first = assisted(planCompaction(SESSION, { trigger: 'auto' }, undefined, HUGE))
    const prior: PersistedState = { v: 1, sessionId: 's1', detail: first.detail, checkpointText: first.checkpointText, updatedAt: 'then' }

    const turnTwo = [...SESSION, ...compaction('host summary'), user('Now read utils.ts.'), toolUse('call-2', 'read', { path: 'utils.ts' }), toolResult('call-2', bulky('UTILS-BODY'))]
    const second = assisted(planCompaction(turnTwo, { trigger: 'auto' }, prior, HUGE))
    expect(second.checkpointText).toContain(first.checkpointText)
    expect(second.checkpointText).not.toContain('UTILS-BODY')
    expect(second.checkpointText).not.toContain('CONFIG-BODY')
  })

  it('declines when the previous state and its cursor disagree, rather than risk double-appending', () => {
    const detail: EngineDetail = { v: 1, engine: 'maskpoint', strategy: 'mask', checkpoints: 0, stats: { observationsMasked: 1, charsOmitted: 5, candidateTokens: 3 } }
    const prior: PersistedState = { v: 1, sessionId: 's1', detail, checkpointText: 'previous state, no cursor', updatedAt: 'then' }
    expect(planCompaction(SESSION, { trigger: 'auto' }, prior, HUGE)).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('never throws: a malformed entry degrades the artifact rather than aborting the hook', () => {
    const weird = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: { unexpected: true } } }]
    expect(() => planCompaction(weird, { trigger: 'auto' }, undefined, HUGE)).not.toThrow()
  })
})
