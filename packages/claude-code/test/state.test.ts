import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineDetail } from '@maskpoint/core'
import { appendAudit, defaultStateDir, readState, statePathFor, writeState } from '../src/state.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-state-'))
  roots.push(root)
  return root
}

const DETAIL: EngineDetail = {
  v: 1,
  engine: 'maskpoint',
  strategy: 'mask',
  checkpoints: 0,
  stats: { observationsMasked: 2, charsOmitted: 40, candidateTokens: 30 },
  cursor: { boundaryId: '__maskpoint_end__', evictedThroughId: 'e1#0' },
}

describe('defaultStateDir', () => {
  it('uses the plugin data directory when the host provides one', () => {
    expect(defaultStateDir({ CLAUDE_PLUGIN_DATA: '/plugins/maskpoint-data' })).toBe(join('/plugins/maskpoint-data', 'state'))
  })

  it('falls back to a dotdirectory under the home directory otherwise', () => {
    expect(defaultStateDir({})).toContain(join('.maskpoint', 'claude-code'))
  })
})

describe('writeState / readState', () => {
  it('round-trips what it wrote', () => {
    const dir = tmpDir()
    const state = { v: 1 as const, sessionId: 's1', detail: DETAIL, checkpointText: 'Recorded user message\nfixed the bug', updatedAt: 'now' }
    writeState(dir, state)
    expect(readState(dir, 's1')).toEqual(state)
  })

  it('writes the session file owner-only', () => {
    const dir = tmpDir()
    const path = writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'x', updatedAt: 'now' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('creates the state directory owner-only', () => {
    const dir = join(tmpDir(), 'nested', 'state')
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'x', updatedAt: 'now' })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('never contains an observation body: only placeholders and framed conversation text pass through it', () => {
    const dir = tmpDir()
    const secret = 'API_KEY=sk-should-never-be-here'
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'unrelated masked history, no secrets', updatedAt: 'now' })
    expect(readFileSync(statePathFor(dir, 's1'), 'utf8')).not.toContain(secret)
  })

  it('returns undefined for a session with no persisted state', () => {
    expect(readState(tmpDir(), 'nope')).toBeUndefined()
  })

  it('treats a different version as absent rather than parsing it', () => {
    const dir = tmpDir()
    writeFileSync(statePathFor(dir, 's1'), JSON.stringify({ v: 2, sessionId: 's1', detail: DETAIL, checkpointText: 'x' }))
    expect(readState(dir, 's1')).toBeUndefined()
  })

  it('treats another session\'s state, and unparseable JSON, as absent', () => {
    const dir = tmpDir()
    writeState(dir, { v: 1, sessionId: 'other-session', detail: DETAIL, checkpointText: 'x', updatedAt: 'now' })
    expect(readState(dir, 's1')).toBeUndefined()

    writeFileSync(statePathFor(dir, 's2'), 'not json at all {{{')
    expect(readState(dir, 's2')).toBeUndefined()
  })

  it('overwrites a previous session state rather than accumulating files', () => {
    const dir = tmpDir()
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'first', updatedAt: 'a' })
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'second', updatedAt: 'b' })
    expect(readState(dir, 's1')?.checkpointText).toBe('second')
  })
})

describe('appendAudit', () => {
  it('appends one JSON line per record and never throws', () => {
    const dir = tmpDir()
    appendAudit(dir, { v: 1, sessionId: 's1', at: 't1', artifactChars: 100, hostSummaryChars: 50, salientTerms: 4, coveredTerms: 2, coverage: 0.5 })
    appendAudit(dir, { v: 1, sessionId: 's1', at: 't2', artifactChars: 120, hostSummaryChars: 60, salientTerms: 5, coveredTerms: 5, coverage: 1 })
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ sessionId: 's1', coverage: 1 })
  })

  it('does not throw when the directory cannot be created', () => {
    // A path with a null byte is invalid on every platform's filesystem.
    expect(() => appendAudit('/nope\0/state', { v: 1, sessionId: 's1', at: 't', artifactChars: 0, hostSummaryChars: 0, salientTerms: 0, coveredTerms: 0, coverage: 0 })).not.toThrow()
  })
})
