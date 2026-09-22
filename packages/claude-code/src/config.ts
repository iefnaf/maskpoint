import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EngineConfig, resolveEngineConfig } from '@maskpoint/core'

/** Where to look for Claude Code's own settings files. */
export interface ConfigPaths {
  homeDir: string
  cwd: string
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A missing, unreadable, or malformed settings file is absent, not an error: this must never
    // block compaction (docs/design.md, "Maskpoint never blocks compaction").
    return undefined
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `maskpoint`'s own namespaced field of one settings file, or `undefined` when the file has none. */
function maskpointField(raw: unknown): unknown {
  return isObject(raw) ? raw.maskpoint : undefined
}

/** Field-by-field: `.claude/settings.local.json` overrides `.claude/settings.json`, matching the host's own precedence. */
function mergeProject(shared: unknown, local: unknown): unknown {
  if (!isObject(shared)) return local
  if (!isObject(local)) return shared
  return { ...shared, ...local }
}

/**
 * Maskpoint's settings, read straight from Claude Code's own settings files rather than through the
 * host's env-merged process (`.claude/settings.json`'s `env` block, which cli.ts's `MASKPOINT_NO_STEERING`
 * already uses for the undocumented steering toggle): reading the files directly, instead of relying on
 * one flattened environment, is what lets this adapter tell a global setting from a project one and
 * apply the trust rule to only the latter (docs/design.md, Security and privacy).
 *
 * A `maskpoint` key in a settings file is not part of Claude Code's own documented schema; JSON
 * tolerates the extra key, and every read here is defensive (`readJson`), so a settings file this
 * adapter cannot parse is simply treated as carrying no Maskpoint configuration — never a reason to
 * fail the hook.
 *
 * The project layer is always treated as trusted: a PreCompact/PostCompact/SessionStart hook only
 * runs after Claude Code's own directory-trust dialog has been accepted for this project (the host
 * does not execute project-configured hooks in an untrusted directory), so by the time this code
 * runs, the project has already cleared the gate the trust rule exists to enforce.
 */
export function loadConfig(paths: ConfigPaths, warn: (message: string) => void): EngineConfig {
  const global = maskpointField(readJson(join(paths.homeDir, '.claude', 'settings.json')))
  const shared = maskpointField(readJson(join(paths.cwd, '.claude', 'settings.json')))
  const local = maskpointField(readJson(join(paths.cwd, '.claude', 'settings.local.json')))
  const { config, warnings } = resolveEngineConfig({ global, project: mergeProject(shared, local), projectTrusted: true })
  for (const warning of warnings) warn(`config: ${warning.message}`)
  return config
}
