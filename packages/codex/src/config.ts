import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Codex itself looks for `config.toml`, `hooks.json`, and session state, unless overridden.
 * Documented by Codex as `CODEX_HOME`; this adapter reads and writes only under it, never inside a
 * project directory, so a project's own (possibly untrusted) configuration is never consulted for
 * this adapter's own wiring decisions (docs/design.md, "Threat: an untrusted repository").
 */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.codex')
}

/** The file this adapter manages as Codex's compaction-prompt override, once the operator wires it in. */
export function compactPromptPath(codexHome: string): string {
  return join(codexHome, 'maskpoint', 'compact-prompt.md')
}

/**
 * Structured format for Codex's own compaction summary. `experimental_compact_prompt_file` is a
 * full override of the host's built-in prompt (docs.: "Inline override for the history compaction
 * prompt" / file variant), not an addition to it, so this is a complete, reasonable prompt in its
 * own right — the same fixed structure the engine's own checkpoint call uses (docs/design.md,
 * "Checkpoint") — with Maskpoint's preservation directive appended, never the other way around: a
 * directive with no summary instructions to carry it would leave Codex's compaction worse than
 * before this adapter was installed.
 */
export const COMPACT_PROMPT = `Summarize the conversation so it can continue with the essential state preserved. Cover, where present: user context and constraints, completed work, pending work, current state, code state, tests with exact errors, changes, dependencies, version-control state, key decisions, next steps. Compress freely; never invent state that was not present.

Maskpoint: preserve exact file paths, identifiers, command lines, and the exact text of test failures. Earlier history already has stale tool output replaced by placeholders — treat those placeholders as evidence that content was omitted deliberately, not as content to reconstruct.
`

/**
 * Write the managed compact-prompt file if it is missing or has drifted from what this adapter
 * ships, so a deleted or hand-edited file is repaired rather than silently left stale. Idempotent:
 * a file that already matches is left untouched (and its mtime with it).
 */
export function ensureCompactPrompt(codexHome: string): string {
  const path = compactPromptPath(codexHome)
  const current = (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  })()
  if (current !== COMPACT_PROMPT) {
    mkdirSync(join(codexHome, 'maskpoint'), { recursive: true })
    writeFileSync(path, COMPACT_PROMPT)
  }
  return path
}

/**
 * Whether Codex's own `config.toml` actually points its compaction prompt at the file this adapter
 * manages. Only the global config under `CODEX_HOME` is consulted — never a project's `.codex/config.toml`
 * (see `defaultCodexHome`) — and only a top-level (non-table) assignment is recognized: this is a
 * narrow, single-key reader, not a TOML parser, and a key it cannot confidently read is treated as
 * absent rather than guessed at.
 */
export interface WiringCheck {
  wired: boolean
  reason: 'wired' | 'no-config' | 'not-set' | 'inline-override-present' | 'points-elsewhere' | 'ambiguous-relative-path'
}

function readTopLevelString(toml: string, key: string): string | undefined {
  let inTable = false
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inTable = true
      continue
    }
    if (inTable) continue
    const match = /^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (match && match[1] === key) return match[2]!.replace(/\\(.)/g, '$1')
  }
  return undefined
}

export function checkWiring(codexHome: string): WiringCheck {
  const configPath = join(codexHome, 'config.toml')
  let toml: string
  try {
    toml = readFileSync(configPath, 'utf8')
  } catch {
    return { wired: false, reason: 'no-config' }
  }

  // An inline override, if set, takes precedence over the file-based one on the host side (docs:
  // "Inline override for the history compaction prompt"), so this adapter's file would never be
  // read even if also configured. Reported honestly rather than assumed to win.
  const inline = readTopLevelString(toml, 'compact_prompt')
  if (inline !== undefined && inline.trim() !== '') return { wired: false, reason: 'inline-override-present' }

  const filePath = readTopLevelString(toml, 'experimental_compact_prompt_file')
  if (filePath === undefined || filePath.trim() === '') return { wired: false, reason: 'not-set' }

  // Only a `~/`-prefixed or absolute path is resolved with confidence: those are unambiguous under
  // any reasonable interpretation. A bare relative path's base (CODEX_HOME? the invoking cwd?
  // config.toml's own directory?) is not confirmed by this adapter's evidence (see README,
  // "Evidence"), so it is reported as unconfirmed rather than resolved against a guessed base —
  // asserting `wired: true` on a guess risks a false positive the operator would never see.
  const managed = compactPromptPath(codexHome)
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2)) === managed ? { wired: true, reason: 'wired' } : { wired: false, reason: 'points-elsewhere' }
  if (filePath.startsWith('/')) return filePath === managed ? { wired: true, reason: 'wired' } : { wired: false, reason: 'points-elsewhere' }
  return { wired: false, reason: 'ambiguous-relative-path' }
}
