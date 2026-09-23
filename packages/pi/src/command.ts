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
  '  /maskpoint                        open the interactive settings menu',
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
 * The interactive prompts `/maskpoint` raises. Each blocks until answered; `select` and `input`
 * answer `undefined` when the user dismisses the prompt (Esc), which always means "change
 * nothing" — never an error. `notify` is the passive surface the typed path shares.
 */
export interface WizardUI {
  /** Absent on a host with no prompts: `/maskpoint` then falls back to the plain listing. */
  select?: ((title: string, options: readonly string[]) => Promise<string | undefined>) | undefined
  input?: ((title: string, options?: { default?: string; placeholder?: string }) => Promise<string | undefined>) | undefined
  notify(message: string, level: 'info' | 'warning'): void
}

/** Apply one validated field write to the store, reporting what happened. Shared by both surfaces. */
function applyField(
  field: FieldSpec,
  command: string,
  value: string,
  store: StoredConfig,
  parsed: { accepted: true; value: unknown } | { accepted: true; remove: true },
  notify: (message: string, level: 'info' | 'warning') => void,
): string {
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
      ? `Maskpoint: ${command} back to ${value === 'auto' ? 'the window-derived default' : 'its default'} — stored, applies to the next compaction`
      : `Maskpoint: ${command} ${value} — stored, applies to the next compaction`
  notify(message, 'info')
  return message
}

/**
 * The interactive menu `/maskpoint` opens with no arguments: current values in the labels, pick to
 * change, pick again to choose the new value, loop until Esc or "done". Nothing needs remembering;
 * nothing is written on dismissal.
 */
async function runWizard(store: StoredConfig, resolve: () => Resolved, ui: WizardUI & { select: NonNullable<WizardUI['select']>; input: NonNullable<WizardUI['input']> }): Promise<string> {
  let last = 'Maskpoint: no changes'
  for (;;) {
    const { config, origin } = resolve()
    const source = (field: keyof EngineConfig): string => (origin[field] === undefined ? '' : ` (${origin[field]})`)
    const choice = await ui.select(
      'Maskpoint settings — pick one to change (Esc to finish)',
      [
        `mask-reasoning: ${config.maskReasoning ? 'on' : 'off'}${source('maskReasoning')}`,
        `budget: ${config.compactBudgetTokens}${source('compactBudgetTokens')}`,
        `checkpoint-model: ${config.checkpointModel ?? 'the session model'}${source('checkpointModel')}`,
        `notify: ${config.notificationLevel}${source('notificationLevel')}`,
        `enabled: ${config.enabled ? 'on' : 'off'}${source('enabled')}`,
        'reset stored settings',
        'done',
      ],
    )
    if (choice === undefined || choice === 'done') return last
    if (choice === 'reset stored settings') {
      const failure = store.write({})
      last = failure ?? 'Maskpoint: stored settings cleared; defaults (and the model window) apply from the next compaction'
      ui.notify(failure === undefined ? last : `Maskpoint ${failure}`, failure === undefined ? 'info' : 'warning')
      continue
    }
    if (choice.startsWith('mask-reasoning:')) {
      const value = await ui.select('mask-reasoning — also replace assistant reasoning with a placeholder', ['on', 'off'])
      if (value !== undefined) last = applyField(FIELDS.reasoning!, 'reasoning', value, store, { accepted: true, value: value === 'on' }, ui.notify)
    } else if (choice.startsWith('budget:')) {
      const value = await ui.select('budget — tokens at or below which compaction stays free of model calls', [
        'auto (follow the model window)',
        '24000',
        '48000',
        '96000',
        'custom…',
      ])
      if (value === undefined) continue
      if (value === 'custom…') {
        const typed = await ui.input('budget in tokens (a whole number)', { placeholder: 'e.g. 32000' })
        if (typed === undefined) continue
        const parsed = FIELDS.budget!.set(typed.trim())
        if (!parsed.accepted) ui.notify(`Maskpoint: ${typed.trim()} — ${parsed.reason}`, 'warning')
        else last = applyField(FIELDS.budget!, 'budget', typed.trim(), store, parsed, ui.notify)
      } else if (value.startsWith('auto')) {
        last = applyField(FIELDS.budget!, 'budget', 'auto', store, { accepted: true, remove: true }, ui.notify)
      } else {
        last = applyField(FIELDS.budget!, 'budget', value, store, FIELDS.budget!.set(value) as { accepted: true; value: unknown }, ui.notify)
      }
    } else if (choice.startsWith('checkpoint-model:')) {
      const typed = await ui.input('model id for the checkpoint call (empty for the session model)', {
        default: config.checkpointModel ?? '',
        placeholder: 'the session model',
      })
      if (typed === undefined) continue
      const trimmed = typed.trim()
      if (trimmed === '' || trimmed === 'default') last = applyField(FIELDS.model!, 'model', 'default', store, { accepted: true, remove: true }, ui.notify)
      else last = applyField(FIELDS.model!, 'model', trimmed, store, FIELDS.model!.set(trimmed) as { accepted: true; value: unknown }, ui.notify)
    } else if (choice.startsWith('notify:')) {
      const value = await ui.select('notification level', ['silent', 'normal', 'verbose'])
      if (value !== undefined) last = applyField(FIELDS.notify!, 'notify', value, store, { accepted: true, value }, ui.notify)
    } else if (choice.startsWith('enabled:')) {
      const value = await ui.select('enabled — off leaves compaction entirely to Pi', ['on', 'off'])
      if (value !== undefined) last = applyField(FIELDS.enabled!, 'enabled', value, store, { accepted: true, value: value === 'on' }, ui.notify)
    }
  }
}

interface Resolved {
  config: EngineConfig
  origin: Readonly<Partial<Record<keyof EngineConfig, string>>>
}

/**
 * Run one `/maskpoint` invocation. No arguments opens the interactive menu when the host offers
 * prompts (a host without them gets the plain listing); arguments run the typed subcommands for
 * scripts and muscle memory. The return value is the last message shown (tests assert on it).
 */
export async function runMaskpointCommand(
  args: string,
  store: StoredConfig,
  resolve: () => Resolved,
  ui: WizardUI,
): Promise<string> {
  const words = args.trim().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) {
    if (ui.select === undefined) {
      const { config, origin } = resolve()
      const message = renderShow(config, origin)
      ui.notify(message, 'info')
      return message
    }
    return runWizard(store, resolve, ui as WizardUI & { select: NonNullable<WizardUI['select']>; input: NonNullable<WizardUI['input']> })
  }

  if (words[0] === 'reset' && words.length === 1) {
    const failure = store.write({})
    const message = failure ?? 'Maskpoint: stored settings cleared; defaults (and the model window) apply from the next compaction'
    ui.notify(failure === undefined ? message : `Maskpoint ${message}`, failure === undefined ? 'info' : 'warning')
    return message
  }

  const field = FIELDS[words[0]!]
  if (field === undefined || words.length !== 2) {
    ui.notify(USAGE, 'info')
    return USAGE
  }

  const parsed = field.set(words[1]!)
  if (!parsed.accepted) {
    const message = `Maskpoint: ${words[0]} ${words[1]!} — ${parsed.reason}`
    ui.notify(message, 'warning')
    return message
  }

  return applyField(field, words[0]!, words[1]!, store, parsed, ui.notify)
}
