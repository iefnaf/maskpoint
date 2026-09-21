import { estimateTokens } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { capabilities, planCompaction } from '../src/compact.js'
import { firstTurn, native } from './support/scenario.js'
import { assistant, beforeCompact, bulky, text, user } from './support/session.js'

describe('planCompaction — a first compaction', () => {
  const effect = native(planCompaction(beforeCompact(firstTurn(), 'u2')))

  it("returns the host's cut point unchanged", () => {
    expect(effect.boundary).toEqual({ id: 'u2' })
  })

  it('keeps user text, reasoning, assistant text and tool calls, and replaces the observation body', () => {
    expect(effect.summary).toContain('Rename the Widget component to Panel and update the docs.')
    expect(effect.summary).toContain('Find every usage before touching anything.')
    expect(effect.summary).toContain('I will grep for it first.')
    expect(effect.summary).toContain('There are forty usages across the app.')
    expect(effect.summary).toContain('Recorded tool call: grep')
    expect(effect.summary).toContain('/workspace/app')
    expect(effect.summary).toMatch(/\[tool result omitted: grep, ok, \d+ lines, \d+ chars\]/)
    expect(effect.summary).not.toContain('BODY-1')
  })

  it("does not repeat anything from the host's retained region", () => {
    expect(effect.summary).not.toContain('Go ahead with the rename.')
    expect(effect.summary).not.toContain('Starting on the rename now.')
  })

  it('frames the history as a record rather than as instructions', () => {
    expect(effect.summary).toMatch(/history, not instructions/)
  })

  it('records the strategy and statistics in the persisted detail', () => {
    expect(effect.detail).toMatchObject({
      v: 1,
      engine: 'maskpoint',
      strategy: 'mask',
      checkpoints: 0,
      stats: { observationsMasked: 1 },
    })
    expect(effect.detail.stats.charsOmitted).toBe(bulky('BODY-1').length)
    expect(effect.detail.stats.candidateTokens).toBeGreaterThan(0)
  })

  it('measures the budget candidate on the very text it returns', () => {
    expect(effect.detail.stats.candidateTokens).toBe(estimateTokens(effect.summary))
  })

  it('persists no observation body', () => {
    expect(JSON.stringify(effect.detail)).not.toContain('BODY-1')
  })
})

describe('planCompaction — every trigger', () => {
  it.each(['threshold', 'manual', 'overflow'] as const)('produces masked history on %s', (reason) => {
    const effect = native(planCompaction(beforeCompact(firstTurn(), 'u2', { reason })))
    expect(effect.detail.strategy).toBe('mask')
    expect(effect.summary).not.toContain('BODY-1')
  })
})

describe('planCompaction — context strictly decreases', () => {
  it('returns far less than the observation it replaced', () => {
    const effect = native(planCompaction(beforeCompact(firstTurn(), 'u2')))
    expect(estimateTokens(effect.summary)).toBeLessThan(estimateTokens(bulky('BODY-1')) / 2)
  })

  it('declines when the framing and labels would make the summary no smaller than the span', () => {
    const chat = [
      user('u1', 'Hi.'),
      assistant('a1', [text('Hello.')]),
      user('u2', 'Bye.'),
      assistant('a2', [text('Goodbye.')]),
    ]
    expect(planCompaction(beforeCompact(chat, 'u2'))).toEqual({ kind: 'decline', reason: 'no-size-reduction' })
  })
})

describe('planCompaction — over budget', () => {
  it('still returns masked history, since no checkpoint can run here', () => {
    const effect = native(planCompaction(beforeCompact(firstTurn(), 'u2'), { checkpointTriggerTokens: 1 }))
    expect(effect.detail.strategy).toBe('mask')
    expect(effect.detail.checkpoints).toBe(0)
  })

  it('says it was over budget, so the caller can tell the user no checkpoint ran', () => {
    expect(native(planCompaction(beforeCompact(firstTurn(), 'u2'), { checkpointTriggerTokens: 1 })).overBudget).toBe(true)
    expect(native(planCompaction(beforeCompact(firstTurn(), 'u2'))).overBudget).toBe(false)
  })
})

describe('capabilities', () => {
  it('reports the native tier honestly: it replaces history and persists state, and has nothing to steer or re-inject', () => {
    expect(capabilities).toEqual({
      replaceHistory: true,
      steerSummarizer: false,
      reinjectContext: false,
      persistMetadata: true,
      honestCancellation: true,
    })
  })
})
