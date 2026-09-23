import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG } from '@maskpoint/core'
import { runMaskpointCommand } from '../src/command.js'
import { loadConfig, resolveConfig } from '../src/config.js'
import { StoredConfig } from '../src/storage.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) `rm -rf ${dir}`
})

const newStore = (): { store: StoredConfig; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'maskpoint-store-'))
  dirs.push(dir)
  const path = join(dir, 'maskpoint.json')
  return { store: new StoredConfig(path), path }
}

const quiet = (): ((message: string) => void) => () => {}
const resolve = (stored: unknown) =>
  resolveConfig({ env: undefined, flags: undefined, stored, contextWindow: undefined }, quiet())

describe('StoredConfig', () => {
  it('reads nothing when the file is absent, and round-trips what is written', () => {
    const { store, path } = newStore()
    expect(store.read()).toBeUndefined()
    expect(store.write({ maskReasoning: true })).toBeUndefined()
    expect(store.read()).toEqual({ maskReasoning: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ maskReasoning: true })
  })

  it('treats an unreadable or non-object file as absent, never as an error', () => {
    const { store, path } = newStore()
    writeFileSync(path, 'not json at all')
    expect(store.read()).toBeUndefined()
    writeFileSync(path, '[1,2]')
    expect(store.read()).toBeUndefined()
  })
})

describe('the stored layer', () => {
  it('sits below the environment and flags: they win field by field', () => {
    const { store } = newStore()
    store.write({ maskReasoning: true, compactBudgetTokens: 30_000 })
    const config = loadConfig({ env: { MASKPOINT_MASK_REASONING: 'false' }, stored: store.read() }, quiet())
    expect(config.maskReasoning).toBe(false)
    expect(config.compactBudgetTokens).toBe(30_000)
  })

  it('participates through the core validator: an invalid stored value warns and the default stands', () => {
    const warned: string[] = []
    const config = loadConfig({ stored: { compactBudgetTokens: -1 } }, (message) => warned.push(message))
    expect(config.compactBudgetTokens).toBe(DEFAULT_ENGINE_CONFIG.compactBudgetTokens)
    expect(warned).toEqual(['invalid stored value for "compactBudgetTokens" (-1); ignoring it'])
  })

  it('counts as an explicit budget, so the model window does not override it', () => {
    expect(loadConfig({ stored: { compactBudgetTokens: 8_000 }, contextWindow: 1_000_000 }, quiet()).compactBudgetTokens).toBe(8_000)
  })
})

describe('runMaskpointCommand', () => {
  const run = async (args: string, sources: Parameters<typeof resolveConfig>[0], notes: { message: string; level: string }[] = []) => {
    const { store } = newStore()
    const resolve = () => resolveConfig(sources, quiet())
    const message = await runMaskpointCommand(args, store, resolve, (message, level) => notes.push({ message, level }))
    return { store, notes, message }
  }

  it('shows every setting with its source, and marks the derived budget', async () => {
    const notes: { message: string; level: string }[] = []
    const { message } = await run('', { stored: { maskReasoning: true }, contextWindow: 1_000_000 }, notes)
    expect(message).toMatch(/mask-reasoning on \(stored configuration\)/)
    expect(message).toMatch(/budget 96000 \(derived from the model window\)/)
    expect(message).toMatch(/notify normal/)
    expect(notes).toEqual([{ message, level: 'info' }])
  })

  it('sets a field, persists it, and reports that it applies to the next compaction', async () => {
    const { store, notes, message } = await run('reasoning on', {})
    expect(message).toBe('Maskpoint: reasoning on — stored, applies to the next compaction')
    expect(notes[0]?.level).toBe('info')
    expect(store.read()).toEqual({ maskReasoning: true })
    expect(resolveConfig({ stored: store.read() }, quiet()).config.maskReasoning).toBe(true)
  })

  it('rejects a bad value with the reason, and writes nothing', async () => {
    const { notes, message } = await run('budget lots', {})
    expect(message).toBe('Maskpoint: budget lots — use a whole number of tokens, or "auto" for the window-derived default')
    expect(notes[0]?.level).toBe('warning')
  })

  it('"auto" removes the stored budget so the window derivation stands again', async () => {
    const { store } = newStore()
    store.write({ compactBudgetTokens: 8_000 })
    const message = await runMaskpointCommand('budget auto', store, () => resolveConfig({ stored: store.read(), contextWindow: 200_000 }, quiet()), () => {})
    expect(message).toMatch(/back to the window-derived default/)
    expect(store.read()).toEqual({})
    expect(resolveConfig({ stored: store.read(), contextWindow: 200_000 }, quiet()).config.compactBudgetTokens).toBe(50_000)
  })

  it('reset clears every stored setting', async () => {
    const { store } = newStore()
    store.write({ maskReasoning: true, compactBudgetTokens: 8_000 })
    const message = await runMaskpointCommand('reset', store, () => resolveConfig({ stored: store.read() }, quiet()), () => {})
    expect(message).toMatch(/stored settings cleared/)
    expect(store.read()).toEqual({})
  })

  it('an unknown field or wrong arity shows usage', async () => {
    for (const args of ['nonsense', 'reasoning', 'reasoning on now']) {
      const { message } = await run(args, {})
      expect(message).toMatch(/Maskpoint usage:/)
    }
  })
})
