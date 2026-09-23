import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ENGINE_CONFIG } from '@maskpoint/core'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function project(): { homeDir: string; cwd: string } {
  root = mkdtempSync(join(tmpdir(), 'maskpoint-cc-config-'))
  const homeDir = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(join(homeDir, '.claude'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  return { homeDir, cwd }
}

function writeSettings(dir: string, name: string, content: unknown): void {
  writeFileSync(join(dir, '.claude', name), JSON.stringify(content))
}

describe('loadConfig', () => {
  it('resolves the documented defaults when no settings files exist', () => {
    const paths = project()
    const warnings: string[] = []
    expect(loadConfig(paths, (m) => warnings.push(m))).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual([])
  })

  it('ignores a settings file with no maskpoint field, and one that is not valid JSON', () => {
    const paths = project()
    writeSettings(paths.homeDir, 'settings.json', { hooks: {} })
    writeFileSync(join(paths.cwd, '.claude', 'settings.json'), '{ not json')
    const warnings: string[] = []
    expect(loadConfig(paths, (m) => warnings.push(m))).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual([])
  })

  it('applies the global settings.json maskpoint field', () => {
    const paths = project()
    writeSettings(paths.homeDir, 'settings.json', { maskpoint: { compactBudgetTokens: 20_000 } })
    expect(loadConfig(paths, () => {})).toEqual({ ...DEFAULT_ENGINE_CONFIG, compactBudgetTokens: 20_000 })
  })

  it('applies the project settings.json maskpoint field over the global one', () => {
    const paths = project()
    writeSettings(paths.homeDir, 'settings.json', { maskpoint: { compactBudgetTokens: 20_000, notificationLevel: 'verbose' } })
    writeSettings(paths.cwd, 'settings.json', { maskpoint: { compactBudgetTokens: 5_000 } })
    expect(loadConfig(paths, () => {})).toEqual({ ...DEFAULT_ENGINE_CONFIG, compactBudgetTokens: 5_000, notificationLevel: 'verbose' })
  })

  it('lets settings.local.json override settings.json field by field', () => {
    const paths = project()
    writeSettings(paths.cwd, 'settings.json', { maskpoint: { compactBudgetTokens: 5_000, notificationLevel: 'verbose' } })
    writeSettings(paths.cwd, 'settings.local.json', { maskpoint: { compactBudgetTokens: 3_000 } })
    expect(loadConfig(paths, () => {})).toEqual({ ...DEFAULT_ENGINE_CONFIG, compactBudgetTokens: 3_000, notificationLevel: 'verbose' })
  })

  it('warns and falls back to the default when a value is invalid, without crashing', () => {
    const paths = project()
    writeSettings(paths.homeDir, 'settings.json', { maskpoint: { compactBudgetTokens: 'a lot' } })
    const warnings: string[] = []
    expect(loadConfig(paths, (m) => warnings.push(m))).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual(['config: invalid global value for "compactBudgetTokens" ("a lot"); ignoring it'])
  })

  it('lets a project settings.json disable Maskpoint', () => {
    const paths = project()
    writeSettings(paths.cwd, 'settings.json', { maskpoint: { enabled: false } })
    expect(loadConfig(paths, () => {}).enabled).toBe(false)
  })
})
