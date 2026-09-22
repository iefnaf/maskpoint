import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { runHook } from '../../src/hooks.js'
import { type Entry, jsonl } from './transcript.js'

export const SESSION_ID = 'sess-0001'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

export interface Scenario {
  /** Where derived state lives for this scenario. */
  stateDir: string
  /** Codex's own home directory (config.toml, etc.) for this scenario. */
  codexHome: string
  transcriptPath: string
  /** Replace the rollout file with these entries, as Codex's own appends would have made it. */
  writeTranscript(entries: Entry[]): void
  /** Run the pre-compaction hook exactly as Codex would: a JSON payload on standard input. */
  preCompact(overrides?: Record<string, unknown>): string
  /** Run the post-compaction hook. */
  postCompact(overrides?: Record<string, unknown>): string
  /** Run the session-start hook with the given source. */
  sessionStart(source?: string, overrides?: Record<string, unknown>): string
  /** Every diagnostic line the hooks logged. */
  logs: string[]
  /** Everything written under the state directory, by path relative to it. */
  stateFiles(): Record<string, string>
  stateFile(name: string): string
  mode(path: string): number
  writeConfigToml(content: string): void
}

export function scenario(): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-codex-'))
  roots.push(root)
  const stateDir = join(root, 'state')
  const codexHome = join(root, 'codex-home')
  const transcriptPath = join(root, `${SESSION_ID}.jsonl`)
  const logs: string[] = []
  const ports = {
    stateDir,
    codexHome,
    now: () => new Date('2026-09-21T10:30:00.000Z'),
    log: (line: string) => logs.push(line),
  }
  const payload = (event: string, extra: Record<string, unknown>) =>
    JSON.stringify({ session_id: SESSION_ID, transcript_path: transcriptPath, cwd: '/workspace/app', hook_event_name: event, ...extra })

  return {
    stateDir,
    codexHome,
    transcriptPath,
    logs,
    writeTranscript: (entries: Entry[]) => writeFileSync(transcriptPath, jsonl(entries)),
    preCompact: (overrides = {}) =>
      runHook('pre-compact', payload('PreCompact', { trigger: 'auto', turn_id: 'turn-1', custom_instructions: null, ...overrides }), ports).stdout,
    postCompact: (overrides = {}) => runHook('post-compact', payload('PostCompact', { trigger: 'auto', turn_id: 'turn-1', ...overrides }), ports).stdout,
    sessionStart: (source = 'compact', overrides = {}) =>
      runHook('session-start', payload('SessionStart', { source, ...overrides }), ports).stdout,
    stateFiles: () => {
      const found: Record<string, string> = {}
      try {
        for (const entry of readdirSync(stateDir, { recursive: true, withFileTypes: true })) {
          if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name)
            found[path.slice(stateDir.length + 1)] = readFileSync(path, 'utf8')
          }
        }
      } catch {
        // No state directory yet: nothing was written.
      }
      return found
    },
    stateFile: (name: string) => readFileSync(join(stateDir, name), 'utf8'),
    mode: (path: string) => statSync(path).mode & 0o777,
    writeConfigToml: (content: string) => {
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, 'config.toml'), content)
    },
  }
}
