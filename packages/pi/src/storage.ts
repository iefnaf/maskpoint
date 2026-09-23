import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * The extension-owned settings file (`~/.pi/agent/maskpoint.json` by default): the persistent
 * surface `/maskpoint` writes and every compaction reads (issue #48). Kept as a plain JSON object
 * of `EngineConfig`-shaped overrides — raw on purpose, so the core's validator stays the one place
 * that decides a stored value is invalid.
 *
 * This is the package's only module that touches the filesystem at runtime, and only this path:
 * user-written, never repo-local, so no untrusted-project concern applies (docs/design.md,
 * Security and privacy). `MASKPOINT_CONFIG` points it elsewhere for tests and profiles.
 */
export class StoredConfig {
  constructor(private readonly path: string) {}

  /** The stored overrides, or undefined when no file exists. Never throws: an unreadable file is an absent one. */
  read(): Record<string, unknown> | undefined {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /**
   * Overwrite the stored overrides. An invalid or unwritable store surfaces as a message the
   * caller can show, because a `/maskpoint` set that silently kept the old value would be worse.
   */
  write(overrides: Record<string, unknown>): string | undefined {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(overrides, null, 2)}\n`)
      return undefined
    } catch (error) {
      return `could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
