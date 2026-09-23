import type { EngineConfig } from '@maskpoint/core'
import type { StoredConfig } from './storage.js'

/**
 * The `/maskpoint` command (issue #48): the interactive configuration surface. Every subcommand
 * either reports the effective config with where each field came from, or edits the stored file
 * that sits at the bottom of the layer chain — so a change applies to the very next compaction,
 * with no restart (settings are read lazily, at compaction time).
 *
 * Pure with respect to the host: parsing and rendering live here, the file behind `store`, and
 * the effective config behind `resolve`, so tests drive all three directly.
 */

/** What one command field accepts, and how its value words itself in the show listing. */
interface FieldSpec {
  readonly key: keyof EngineConfig
  readonly words: string
  readonly set: (value: string) => { accepted: true; value: unknown } | { accepted: false; reason: string } | { accepted: true; remove: true }
}

const boolean = (value: string): boolean | undefined =>
  value === 'on' || value === 'true' ? true : value === 'off' || value === 'false' ? false : undefined

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  reasoning: {
    key: 'maskReasoning',
    words: 'mask-reasoning',
    set: (value) => {
      const parsed = boolean(value)
      return parsed === undefined ? { accepted: false, reason: 'use "on" or "off"' } : { accepted: true, value: parsed }
    },
  },
  budget: {
    key: 'compactBudgetTokens',
    words: 'budget',
    set: (value) => {
      if (value === 'auto') return { accepted: true, remove: true }
      if (!/^\d+$/.test(value)) return { accepted: false, reason: 'use a whole number of tokens, or "auto" for the window-derived default' }
      const tokens = Number(value)
      if (tokens <= 0) return { accepted: false, reason: 'the budget must be positive' }
      return { accepted: true, value: tokens }
    },
  },
  model: {
    key: 'checkpointModel',
    words: 'checkpoint-model',
    set: (value) => {
      if (value === 'default') return { accepted: true, remove: true }
      if (value.trim() === '') return { accepted: false, reason: 'use a model id, or "default" for the session model' }
      return { accepted: true, value }
    },
  },
  notify: {
    key: 'notificationLevel',
    words: 'notify',
    set: (value) => {
      if (value === 'silent' || value === 'normal' || value === 'verbose') return { accepted: true, value }
      return { accepted: false, reason: 'use "silent", "normal", or "verbose"' }
    },
  },
  enabled: {
    key: 'enabled',
    words: 'enabled',
    set: (value) => {
      const parsed = boolean(value)
      return parsed === undefined ? { accepted: false, reason: 'use "on" or "off"' } : { accepted: true, value: parsed }
    },
  },
}

const USAGE = [
  'Maskpoint usage:',
  '  /maskpoint                        show every setting and where it came from',
  '  /maskpoint reasoning on|off       mask assistant reasoning as well as observations',
  '  /maskpoint budget <tokens>|auto   compact budget; "auto" follows the model window',
  '  /maskpoint model <id>|default     model for the checkpoint call',
  '  /maskpoint notify silent|normal|verbose',
  '  /maskpoint enabled on|off',
  '  /maskpoint reset                  clear every stored setting',
].join('\n')

/** Render the effective config for `/maskpoint` with no args. One line per field, source included. */
export function renderShow(config: EngineConfig, origin: Readonly<Partial<Record<keyof EngineConfig, string>>>): string {
  const line = (words: string, value: string, source: string | undefined): string =>
    `${words} ${value}${source === undefined ? '' : ` (${source})`}`
  return [
    'Maskpoint settings:',
    line('enabled', config.enabled ? 'on' : 'off', origin.enabled),
    line('budget', String(config.compactBudgetTokens), origin.compactBudgetTokens),
    line('mask-reasoning', config.maskReasoning ? 'on' : 'off', origin.maskReasoning),
    line('checkpoint-model', config.checkpointModel ?? 'the session model', origin.checkpointModel),
    line('notify', config.notificationLevel, origin.notificationLevel),
    'storage: changes made here apply to the next compaction, no restart needed',
  ].join('\n')
}

/**
 * Run one `/maskpoint` invocation. `notify` shows the outcome; the return value is the message
 * string (tests assert on it).
 */
export async function runMaskpointCommand(
  args: string,
  store: StoredConfig,
  resolve: () => { config: EngineConfig; origin: Readonly<Partial<Record<keyof EngineConfig, string>>> },
  notify: (message: string, level: 'info' | 'warning') => void,
): Promise<string> {
  const words = args.trim().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) {
    const { config, origin } = resolve()
    const message = renderShow(config, origin)
    notify(message, 'info')
    return message
  }

  if (words[0] === 'reset' && words.length === 1) {
    const failure = store.write({})
    const message = failure ?? 'Maskpoint: stored settings cleared; defaults (and the model window) apply from the next compaction'
    notify(failure === undefined ? message : `Maskpoint ${message}`, failure === undefined ? 'info' : 'warning')
    return message
  }

  const field = FIELDS[words[0]!]
  if (field === undefined || words.length !== 2) {
    notify(USAGE, 'info')
    return USAGE
  }

  const parsed = field.set(words[1]!)
  if (!parsed.accepted) {
    const message = `Maskpoint: ${words[0]} ${words[1]!} — ${parsed.reason}`
    notify(message, 'warning')
    return message
  }

  const stored = store.read() ?? {}
  if ('remove' in parsed && parsed.remove) delete stored[field.key]
  else stored[field.key] = (parsed as { value: unknown }).value
  const failure = store.write(stored)
  if (failure !== undefined) {
    const message = `Maskpoint ${failure}`
    notify(message, 'warning')
    return message
  }
  const message =
    'remove' in parsed && parsed.remove
      ? `Maskpoint: ${words[0]} back to ${words[1] === 'auto' ? 'the window-derived default' : 'its default'} — stored, applies to the next compaction`
      : `Maskpoint: ${words[0]} ${words[1]!} — stored, applies to the next compaction`
  notify(message, 'info')
  return message
}
