import { decide, estimateTokens } from '@maskpoint/core'
import type { ConversationSnapshot, Item } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { renderText } from '../src/render.js'

const items: Item[] = [
  { id: 'a', kind: 'checkpoint', text: 'Earlier state: the migration is half done.' },
  { id: 'b', kind: 'user', text: 'run the build again' },
  { id: 'c', kind: 'tool-call', name: 'bash', callId: 'c1', args: '{"cmd":"make"}' },
  { id: 'd', kind: 'tool-result', name: 'bash', callId: 'c1', status: 'error', exitCode: 2, text: 'error: no rule\n'.repeat(300), media: 0 },
  { id: 'e', kind: 'assistant-text', text: 'The build fails; investigating.' },
  { id: 'f', kind: 'opaque', note: 'end' },
]

describe('the budget counts what the model is shown', () => {
  it("is the same size the engine measured: the rendered text's estimate equals the candidate's", () => {
    const snapshot: ConversationSnapshot = {
      items,
      boundary: { id: 'f' },
      previousCheckpoint: 'Earlier state: the migration is half done.',
      evictedThrough: 'a',
      reason: 'manual',
    }
    const decision = decide(snapshot, { checkpointTriggerTokens: 1_000_000 })
    if (decision.kind !== 'masked-history') throw new Error('expected masked history')

    expect(estimateTokens(renderText(decision.artifact))).toBe(decision.stats.candidateTokens)
  })
})
