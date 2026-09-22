import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const plugin = JSON.parse(readFileSync(join(packageDir, '.claude-plugin', 'plugin.json'), 'utf8'))

describe('the Claude Code package', () => {
  it('ships the plugin manifest and the hooks file it declares', () => {
    expect(manifest.files).toContain('.claude-plugin')
    expect(manifest.files).toContain('hooks')
    expect(plugin.name).toBe('maskpoint-claude-code')
  })

  it('keeps the plugin manifest version equal to the package version, so a release bumps one number', () => {
    // The host reads the plugin's version from its own manifest, not from package.json, so the two
    // can drift silently: a published package whose plugin still claims the previous version is a
    // release that reports the wrong number to every user. Two fields, one assertion.
    expect(plugin.version).toBe(manifest.version)
  })

  it('declares the CLI entrypoint the hooks invoke', () => {
    const hooks = JSON.parse(readFileSync(join(packageDir, 'hooks', 'hooks.json'), 'utf8'))
    const commands = Object.values(hooks.hooks as Record<string, unknown>)
      .flat()
      .flatMap((entry) => (entry as { hooks?: { args?: string[] }[] }).hooks ?? [])
      .flatMap((hook) => (hook.args ?? []).filter((arg) => arg.endsWith('cli.js')))
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) expect(manifest.bin['maskpoint-claude-code']).toContain('cli.js')
  })
})
