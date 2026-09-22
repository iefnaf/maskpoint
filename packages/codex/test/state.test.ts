import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineDetail } from '@maskpoint/core'
import { defaultCodexHome } from '../src/config.js'
import { defaultStateDir, readState, statePathFor, writeState } from '../src/state.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-codex-state-'))
  roots.push(root)
  return join(root, 'state')
}

const DETAIL: EngineDetail = { v: 1, engine: 'maskpoint', strategy: 'mask', checkpoints: 0, stats: { observationsMasked: 1, charsOmitted: 10, candidateTokens: 5 } }

describe('defaultStateDir', () => {
  it('prefers PLUGIN_DATA when set, as an installed plugin has it', () => {
    expect(defaultStateDir({ PLUGIN_DATA: '/plugin/data' })).toBe(join('/plugin/data', 'state'))
  })

  it('falls back to CODEX_HOME/maskpoint/state otherwise', () => {
    expect(defaultStateDir({ CODEX_HOME: '/custom/codex' })).toBe(join('/custom/codex', 'maskpoint', 'state'))
  })
})

describe('defaultCodexHome', () => {
  it('uses CODEX_HOME when set', () => {
    expect(defaultCodexHome({ CODEX_HOME: '/custom/codex' })).toBe('/custom/codex')
  })

  it('falls back to ~/.codex otherwise', () => {
    expect(defaultCodexHome({})).toMatch(/\.codex$/)
  })
})

describe('readState / writeState', () => {
  it('round-trips what was written', () => {
    const dir = stateDir()
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'hello', updatedAt: '2026-09-21T10:00:00.000Z' })
    expect(readState(dir, 's1')).toEqual({ v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'hello', updatedAt: '2026-09-21T10:00:00.000Z' })
  })

  it('returns undefined for a session with no persisted state', () => {
    expect(readState(stateDir(), 'nope')).toBeUndefined()
  })

  it('writes at owner-only permissions', () => {
    const dir = stateDir()
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'hi', updatedAt: 'now' })
    expect(statSync(statePathFor(dir, 's1')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('treats a foreign or unversioned file as absent', () => {
    const dir = stateDir()
    writeState(dir, { v: 1, sessionId: 's1', detail: DETAIL, checkpointText: 'hi', updatedAt: 'now' })
    expect(readState(dir, 's2')).toBeUndefined()
  })
})
