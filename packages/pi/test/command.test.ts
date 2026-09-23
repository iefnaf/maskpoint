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
    const message = await runMaskpointCommand(args, store, resolve, { select: undefined, input: undefined, notify: (message, level) => notes.push({ message, level }) })
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

  it('switches the checkpoint call off and on, and the listing reports it', async () => {
    const off = await run('checkpoint off', {})
    expect(off.message).toBe('Maskpoint: checkpoint off — stored, applies to the next compaction')
    expect(off.store.read()).toEqual({ checkpointEnabled: false })
    expect(resolveConfig({ stored: off.store.read() }, quiet()).config.checkpointEnabled).toBe(false)

    const notes: { message: string; level: string }[] = []
    const shown = await run('', { stored: off.store.read() }, notes)
    expect(shown.message).toMatch(/checkpoint off \(stored configuration\)/)

    const on = await run('checkpoint on', { stored: { checkpointEnabled: false } })
    expect(on.store.read()).toEqual({ checkpointEnabled: true })
  })

  it('rejects a bad value with the reason, and writes nothing', async () => {
    const { notes, message } = await run('budget lots', {})
    expect(message).toBe('Maskpoint: budget lots — use a whole number of tokens, or "auto" for the window-derived default')
    expect(notes[0]?.level).toBe('warning')
  })

  it('"auto" removes the stored budget so the window derivation stands again', async () => {
    const { store } = newStore()
    store.write({ compactBudgetTokens: 8_000 })
    const message = await runMaskpointCommand('budget auto', store, () => resolveConfig({ stored: store.read(), contextWindow: 200_000 }, quiet()), { select: undefined, input: undefined, notify: () => {} })
    expect(message).toMatch(/back to the window-derived default/)
    expect(store.read()).toEqual({})
    expect(resolveConfig({ stored: store.read(), contextWindow: 200_000 }, quiet()).config.compactBudgetTokens).toBe(50_000)
  })

  it('reset clears every stored setting', async () => {
    const { store } = newStore()
    store.write({ maskReasoning: true, compactBudgetTokens: 8_000 })
    const message = await runMaskpointCommand('reset', store, () => resolveConfig({ stored: store.read() }, quiet()), { select: undefined, input: undefined, notify: () => {} })
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

describe('the interactive wizard', () => {
  /** A scripted user: each prompt consumes the next answer, in order; undefined stands for Esc. */
  const scripted = (answers: (string | undefined)[]) => {
    const prompts: { title: string; options?: readonly string[] }[] = []
    let n = 0
    const ui = {
      select: async (title: string, options: readonly string[]) => {
        prompts.push({ title, options })
        return answers[n++]
      },
      input: async (title: string) => {
        prompts.push({ title })
        return answers[n++]
      },
      notify: (_message: string, _level: 'info' | 'warning') => {},
    }
    return { ui, prompts }
  }

  it('walks the menu, stores the choice, refreshes the labels, and exits on Esc', async () => {
    const { store } = newStore()
    const { ui } = scripted(['mask-reasoning: off', 'on', undefined])
    await runMaskpointCommand('', store, () => resolveConfig({ stored: store.read(), contextWindow: 1_000_000 }, quiet()), ui)
    expect(store.read()).toEqual({ maskReasoning: true })
  })

  it('shows the updated value when the menu loops', async () => {
    const { store } = newStore()
    const { ui, prompts } = scripted(['mask-reasoning: off', 'on', 'mask-reasoning: on', 'off', undefined])
    await runMaskpointCommand('', store, () => resolveConfig({ stored: store.read() }, quiet()), ui)
    expect(prompts[0]?.title).toMatch(/pick one to change/)
    expect(prompts[2]?.options?.[0]).toContain('mask-reasoning: on')
    expect(store.read()).toEqual({ maskReasoning: false })
  })

  it('budget "custom…" goes through input validation: a bad value warns and writes nothing', async () => {
    const { store } = newStore()
    const notes: { message: string; level: string }[] = []
    const { ui } = scripted(['budget: 96000', 'custom…', 'lots'])
    ui.notify = (message: string, level: 'info' | 'warning') => notes.push({ message, level })
    await runMaskpointCommand('', store, () => resolveConfig({ stored: store.read(), contextWindow: 1_000_000 }, quiet()), ui)
    expect(notes[0]?.level).toBe('warning')
    expect(notes[0]?.message).toMatch(/whole number of tokens/)
    expect(store.read()).toBeUndefined()
  })

  it('budget auto removes the stored value from the menu', async () => {
    const { store } = newStore()
    store.write({ compactBudgetTokens: 8_000 })
    const { ui } = scripted(['budget: 8000', 'auto (follow the model window)', undefined])
    const message = await runMaskpointCommand('', store, () => resolveConfig({ stored: store.read(), contextWindow: 200_000 }, quiet()), ui)
    expect(message).toMatch(/back to the window-derived default/)
    expect(store.read()).toEqual({})
  })

  it('reset from the menu clears the store', async () => {
    const { store } = newStore()
    store.write({ maskReasoning: true, compactBudgetTokens: 8_000 })
    const { ui } = scripted(['reset stored settings', undefined])
    const message = await runMaskpointCommand('', store, () => resolveConfig({ stored: store.read() }, quiet()), ui)
    expect(message).toMatch(/stored settings cleared/)
    expect(store.read()).toEqual({})
  })

  it('Esc at the first menu writes nothing', async () => {
    const { store } = newStore()
    const { ui } = scripted([undefined])
    const message = await runMaskpointCommand('', store, () => resolveConfig({}, quiet()), ui)
    expect(message).toBe('Maskpoint: no changes')
    expect(store.read()).toBeUndefined()
  })
})
