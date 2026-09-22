import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineDetail } from '@maskpoint/core'
import { defaultCodexHome } from './config.js'

/**
 * What this adapter persists per session, outside Codex's own rollout. `checkpointText` is the
 * artifact rendered as markdown: masked history and any earlier checkpoint text, never an
 * observation body (masking always runs with `alwaysMask: true` for state that reaches this module
 * — see `compact.ts`, and the Claude Code adapter's `state.ts` for why: this file is a genuine
 * second copy of session content, so the no-expansion rule's tiny-body exception is not safe here).
 */
export interface PersistedState {
  v: 1
  sessionId: string
  detail: EngineDetail
  checkpointText: string
  updatedAt: string
}

/** Owner-only: this directory and everything under it never needs another user or process to read it. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Where derived state lives by default: the plugin's own writable data directory when running as an
 * installed plugin (`PLUGIN_DATA`, host-managed and already scoped to this plugin and this user), or
 * a directory under `CODEX_HOME` otherwise, e.g. for a manual run. Unlike the Claude Code adapter's
 * fallback (`~/.maskpoint/claude-code`, since Claude Code has no equivalent home-directory env var),
 * Codex already documents `CODEX_HOME` as its own config-and-session-data root, so nesting under it
 * is the more native choice here rather than introducing a second, unrelated dotdirectory.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const pluginData = env.PLUGIN_DATA
  if (typeof pluginData === 'string' && pluginData !== '') return join(pluginData, 'state')
  return join(defaultCodexHome(env), 'maskpoint', 'state')
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(dir, DIR_MODE)
  } catch {
    // Best effort: an already-narrower mode, or a filesystem that ignores chmod, is not worth failing over.
  }
}

const sessionFile = (stateDir: string, sessionId: string): string => join(stateDir, `${sessionId}.json`)

/**
 * Read the state this adapter persisted for a session, or undefined for none, a foreign file, a
 * version this build does not know, or anything that fails to parse. A session with no prior state
 * is indistinguishable from one where reading it failed: both mean "start fresh, mask everything".
 */
export function readState(stateDir: string, sessionId: string): PersistedState | undefined {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(stateDir, sessionId), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return undefined
    const state = raw as Partial<PersistedState>
    if (state.v !== 1 || state.sessionId !== sessionId) return undefined
    if (typeof state.checkpointText !== 'string' || typeof state.detail !== 'object' || state.detail === null) return undefined
    return state as PersistedState
  } catch {
    return undefined
  }
}

/** Persist state for a session, owner-only permissions, written so a crash mid-write cannot corrupt it. */
export function writeState(stateDir: string, state: PersistedState): string {
  ensureDir(stateDir)
  const path = sessionFile(stateDir, state.sessionId)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(state), { mode: FILE_MODE })
  chmodSync(tmp, FILE_MODE)
  renameSync(tmp, path)
  return path
}

/** Absolute path state for a session would be read from or written to, without touching the disk. */
export function statePathFor(stateDir: string, sessionId: string): string {
  return sessionFile(stateDir, sessionId)
}

/**
 * One line of the post-compaction audit log: never observation bodies, only sizes and, when Codex's
 * own compaction result was readable, a coverage ratio. `providerCompaction` records what this
 * adapter could determine about Codex's own compaction path for this event (see `audit.ts`).
 * `modelProvider` is the session's own recorded provider (e.g. `"openai"`), the closest available
 * reading of "the current authentication mode": `providerCompaction` is reported alongside it so a
 * reader can see what the finding was observed under, not just the finding on its own.
 */
export interface AuditRecord {
  v: 1
  sessionId: string
  at: string
  providerCompaction: 'opaque' | 'readable' | 'undetermined'
  modelProvider?: string
  artifactChars: number
  hostSummaryChars?: number
  salientTerms?: number
  coveredTerms?: number
  coverage?: number
}

const auditFile = (stateDir: string): string => join(stateDir, 'audit.jsonl')

/** Append one audit record. Never throws outward: a logging failure must not affect the session. */
export function appendAudit(stateDir: string, record: AuditRecord): void {
  try {
    ensureDir(stateDir)
    const path = auditFile(stateDir)
    const firstWrite = !existsSync(path)
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
    if (firstWrite) chmodSync(path, FILE_MODE)
  } catch {
    // Audit is observability, not correctness; losing one record is not worth surfacing.
  }
}
