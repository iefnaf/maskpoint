import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const plugin = JSON.parse(readFileSync(join(packageDir, '.codex-plugin', 'plugin.json'), 'utf8'))

describe('the Codex package', () => {
  it('ships the plugin manifest and the hooks file it points at', () => {
    expect(manifest.files).toContain('.codex-plugin')
    expect(manifest.files).toContain('hooks')
    expect(plugin.name).toBe('maskpoint-codex')
    expect(plugin.hooks).toBe('./hooks/hooks.json')
  })

  it('keeps the plugin manifest version equal to the package version, so a release bumps one number', () => {
    // The host reads the plugin's version from its own manifest, not from package.json, so the two
    // can drift silently: a published package whose plugin still claims the previous version is a
    // release that reports the wrong number to every user. Two fields, one assertion.
    expect(plugin.version).toBe(manifest.version)
  })

  it('invokes the CLI entrypoint the manifest declares', () => {
    const hooks = JSON.parse(readFileSync(join(packageDir, 'hooks', 'hooks.json'), 'utf8'))
    const args = Object.values(hooks.hooks as Record<string, unknown>)
      .flat()
      .flatMap((entry) => (entry as { hooks?: { args?: string[] }[] }).hooks ?? [])
      .flatMap((hook) => hook.args ?? [])
    const invoking = args.filter((arg) => arg.includes('cli.js'))
    expect(invoking.length).toBeGreaterThan(0)
    expect(manifest.bin['maskpoint-codex']).toContain('cli.js')
  })
})
