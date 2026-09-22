import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkWiring, COMPACT_PROMPT, compactPromptPath, ensureCompactPrompt } from '../src/config.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function codexHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-codex-config-'))
  roots.push(root)
  return root
}

describe('ensureCompactPrompt', () => {
  it('writes the managed prompt file when absent', () => {
    const home = codexHome()
    const path = ensureCompactPrompt(home)
    expect(path).toBe(compactPromptPath(home))
    expect(readFileSync(path, 'utf8')).toBe(COMPACT_PROMPT)
  })

  it('is idempotent: a matching file is left untouched', () => {
    const home = codexHome()
    ensureCompactPrompt(home)
    const before = readFileSync(compactPromptPath(home), 'utf8')
    ensureCompactPrompt(home)
    expect(readFileSync(compactPromptPath(home), 'utf8')).toBe(before)
  })

  it('repairs a hand-edited or drifted file back to the managed content', () => {
    const home = codexHome()
    ensureCompactPrompt(home)
    writeFileSync(compactPromptPath(home), 'someone edited this')
    ensureCompactPrompt(home)
    expect(readFileSync(compactPromptPath(home), 'utf8')).toBe(COMPACT_PROMPT)
  })
})

describe('checkWiring', () => {
  it('reports not wired when there is no config.toml at all', () => {
    const home = codexHome()
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'no-config' })
  })

  it('reports not wired when config.toml exists but sets nothing relevant', () => {
    const home = codexHome()
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5-codex"\n')
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'not-set' })
  })

  it('reports wired when experimental_compact_prompt_file points at the managed file, absolute path', () => {
    const home = codexHome()
    const managed = compactPromptPath(home)
    writeFileSync(join(home, 'config.toml'), `experimental_compact_prompt_file = "${managed}"\n`)
    expect(checkWiring(home)).toEqual({ wired: true, reason: 'wired' })
  })

  it('reports not wired for a bare relative path, since this adapter does not know what Codex resolves it against', () => {
    const home = codexHome()
    writeFileSync(join(home, 'config.toml'), 'experimental_compact_prompt_file = "maskpoint/compact-prompt.md"\n')
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'ambiguous-relative-path' })
  })

  it('reports not wired when the configured file points somewhere else', () => {
    const home = codexHome()
    writeFileSync(join(home, 'config.toml'), 'experimental_compact_prompt_file = "/etc/some/other-prompt.md"\n')
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'points-elsewhere' })
  })

  it('reports not wired when an inline compact_prompt override is also set, since it takes precedence', () => {
    const home = codexHome()
    const managed = compactPromptPath(home)
    writeFileSync(join(home, 'config.toml'), `compact_prompt = "just summarize"\nexperimental_compact_prompt_file = "${managed}"\n`)
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'inline-override-present' })
  })

  it('ignores a same-named key nested inside a table', () => {
    const home = codexHome()
    const managed = compactPromptPath(home)
    writeFileSync(join(home, 'config.toml'), `[some_table]\nexperimental_compact_prompt_file = "${managed}"\n`)
    expect(checkWiring(home)).toEqual({ wired: false, reason: 'not-set' })
  })

  it('never throws on a config.toml it cannot parse as expected', () => {
    const home = codexHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.toml'), '[[[not valid toml at all')
    expect(() => checkWiring(home)).not.toThrow()
  })
})
