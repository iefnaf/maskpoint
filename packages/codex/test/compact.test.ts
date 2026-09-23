import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineDetail } from '@maskpoint/core'
import { capabilities, type CcEffect, planCompaction } from '../src/compact.js'
import { compactPromptPath } from '../src/config.js'
import type { PersistedState } from '../src/state.js'
import { assistantText, bulky, functionCall, functionCallOutput, resetOrdinal, user } from './support/transcript.js'

const HUGE = { compactBudgetTokens: 1_000_000 }
const TINY = { compactBudgetTokens: 1 }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function codexHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-codex-compact-'))
  roots.push(root)
  return root
}

const assisted = (effect: CcEffect): Extract<CcEffect, { kind: 'assisted' }> => {
  if (effect.kind !== 'assisted') throw new Error(`expected assisted, got decline: ${effect.reason} ${effect.note ?? ''}`)
  return effect
}

function session() {
  resetOrdinal()
  return [user('Read config.ts and summarize it.'), functionCall('call-1', 'read', { path: 'config.ts' }), functionCallOutput('call-1', bulky('CONFIG-BODY')), assistantText('Here is the summary.')]
}

describe('capabilities — the tier this adapter reports', () => {
  it('never claims to replace Codex\'s own compactor', () => {
    expect(capabilities.replaceHistory).toBe(false)
  })

  it('reports what it can and cannot do, with no claimed injection cap', () => {
    expect(capabilities).toMatchObject({ reinjectContext: true, persistMetadata: true, steerSummarizer: true })
    expect(capabilities.injectionCapChars).toBeUndefined()
  })
})

describe('planCompaction — the pre-compaction decision', () => {
  it('masks the whole rollout into an artifact on a first compaction', () => {
    const effect = assisted(planCompaction(session(), { trigger: 'auto' }, undefined, codexHome(), HUGE))
    expect(effect.checkpointText).toContain('Here is the summary.')
    expect(effect.checkpointText).not.toContain('CONFIG-BODY')
    expect(effect.detail).toMatchObject({ v: 1, engine: 'maskpoint', strategy: 'mask' })
  })

  it('masks even a tiny observation the no-expansion rule would otherwise leave verbatim', () => {
    resetOrdinal()
    const withSecret = [user('Print the key.'), functionCall('call-1', 'bash', { command: 'echo $KEY' }), functionCallOutput('call-1', 'sk-tiny-secret')]
    const effect = assisted(planCompaction(withSecret, { trigger: 'auto' }, undefined, codexHome(), HUGE))
    expect(effect.checkpointText).not.toContain('sk-tiny-secret')
  })

  it('declines when the rollout could not be read', () => {
    expect(planCompaction(undefined, { trigger: 'auto' }, undefined, codexHome(), HUGE)).toEqual({
      kind: 'decline',
      reason: 'unreadable-snapshot',
      note: expect.any(String),
    })
  })

  it('declines when there is nothing to compact', () => {
    expect(planCompaction([], { trigger: 'auto' }, undefined, codexHome(), HUGE)).toEqual({ kind: 'decline', reason: 'nothing-to-compact' })
  })

  it('reports over-budget rather than declining, and still returns a usable artifact', () => {
    const effect = assisted(planCompaction(session(), { trigger: 'auto' }, undefined, codexHome(), TINY))
    expect(effect.overBudget).toBe(true)
    expect(effect.focusRequested).toBe(false)
    expect(effect.checkpointText.length).toBeGreaterThan(0)
  })

  it('reports a requested focus rather than declining, since this adapter cannot run a checkpoint yet', () => {
    const effect = assisted(planCompaction(session(), { trigger: 'manual', customInstructions: 'focus on the config parsing' }, undefined, codexHome(), HUGE))
    expect(effect.focusRequested).toBe(true)
    expect(effect.overBudget).toBe(false)
  })

  it('builds on the previous artifact: only newly evicted history is appended, and the old candidate text is kept verbatim', () => {
    const home = codexHome()
    // Codex's rollout, like a real transcript, is cumulative: the second compaction sees the same
    // entries the first one saw plus whatever the session added since (mirrors the Claude Code
    // adapter's equivalent test, which re-includes its whole earlier SESSION array too).
    const firstEntries = session()
    const first = assisted(planCompaction(firstEntries, { trigger: 'auto' }, undefined, home, HUGE))
    const prior: PersistedState = { v: 1, sessionId: 's1', detail: first.detail, checkpointText: first.checkpointText, updatedAt: 'then' }

    const secondEntries = [...firstEntries, functionCall('call-2', 'read', { path: 'utils.ts' }), functionCallOutput('call-2', bulky('UTILS-BODY'))]
    const second = assisted(planCompaction(secondEntries, { trigger: 'auto' }, prior, home, HUGE))
    expect(second.checkpointText).toContain(first.checkpointText)
    expect(second.checkpointText).not.toContain('UTILS-BODY')
    expect(second.checkpointText).not.toContain('CONFIG-BODY')
  })

  it('declines when the previous state and its cursor disagree, rather than risk double-appending', () => {
    const detail: EngineDetail = { v: 1, engine: 'maskpoint', strategy: 'mask', checkpoints: 0, stats: { observationsMasked: 1, charsOmitted: 5, candidateTokens: 3 } }
    const prior: PersistedState = { v: 1, sessionId: 's1', detail, checkpointText: 'previous state, no cursor', updatedAt: 'then' }
    expect(planCompaction(session(), { trigger: 'auto' }, prior, codexHome(), HUGE)).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
  })

  it('never throws: a malformed entry degrades the artifact rather than aborting the hook', () => {
    const weird = [{ type: 'response_item', payload: { type: 'message', role: 'user', content: { unexpected: true } } }]
    expect(() => planCompaction(weird, { trigger: 'auto' }, undefined, codexHome(), HUGE)).not.toThrow()
  })

  it('reports wiring: not wired when nothing points config.toml at the managed prompt file', () => {
    const effect = assisted(planCompaction(session(), { trigger: 'auto' }, undefined, codexHome(), HUGE))
    expect(effect.wiring.wired).toBe(false)
  })

  it('reports wiring: wired when config.toml points at the managed prompt file, and writes/repairs that file', () => {
    const home = codexHome()
    writeFileSync(join(home, 'config.toml'), `experimental_compact_prompt_file = "${compactPromptPath(home)}"\n`)
    const effect = assisted(planCompaction(session(), { trigger: 'auto' }, undefined, home, HUGE))
    expect(effect.wiring).toEqual({ wired: true, reason: 'wired' })
    expect(readFileSync(compactPromptPath(home), 'utf8').length).toBeGreaterThan(0)
  })
})
