import { DEFAULT_ENGINE_CONFIG, deriveCompactBudget, type EngineConfig, resolveEngineConfigLayers } from '@maskpoint/core'

/**
 * Maskpoint's settings for Pi, and the channels they arrive through.
 *
 * Pi gives an extension no configuration of its own: `PiContext.config` is written structurally
 * (`host.ts`) and a real Pi release was measured supplying nothing at all — no `config` on the
 * handler's context, and only Pi's own `{ enabled, reserveTokens, keepRecentTokens }` at
 * `event.preparation.settings`, with unknown keys in `settings.json` silently dropped (issue #39).
 * So this adapter has three channels, lowest precedence first:
 *
 * 1. `host` — whatever a future Pi release puts in `ctx.config`. Kept first so that the day one
 *    does, it works without a code change.
 * 2. `environment` — one `MASKPOINT_*` variable per field, for an operator who wants a setting on
 *    every run without editing anything Pi owns.
 * 3. `flags` — this extension's own CLI flags (`docs/design.md`, Pi adapter), which appear in
 *    `pi --help` and win for the run they were typed on.
 *
 * Every layer goes through the core's validator, so an invalid value warns through the UI and
 * leaves the previous layer (or the documented default) standing rather than failing a compaction.
 *
 * This package still reads no file and imports no host SDK: the environment and the flag values are
 * handed in by the caller, which is what keeps this module a pure function of its inputs.
 */
export interface PiConfigSources {
  /** `PiContext.config`, as Pi supplied it. `undefined` on every release measured so far. */
  readonly host?: unknown
  /** The process environment, read by the extension entrypoint. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** This run's values for the extension's own CLI flags, keyed by config field. Unset flags are absent. */
  readonly flags?: Readonly<Partial<Record<keyof EngineConfig, unknown>>> | undefined
  /** The extension-owned settings file (`/maskpoint` writes it), as raw JSON. Absent when there is none. */
  readonly stored?: unknown
  /** The session model's context window, when known. Drives the compact-budget default. */
  readonly contextWindow?: number | undefined
}

/** One setting's two operator-facing names, so the table documents both channels at once. */
interface Channels {
  readonly env: string
  readonly flag: string
  readonly description: string
}

/** Every `EngineConfig` field, so a new field cannot be added without naming its channels here. */
export const CHANNELS: Record<keyof EngineConfig, Channels> = {
  enabled: {
    env: 'MASKPOINT_ENABLED',
    flag: 'maskpoint-enabled',
    description: 'Maskpoint: set to false to disable it entirely, leaving Pi to compact as if this extension were not installed (default true)',
  },
  compactBudgetTokens: {
    env: 'MASKPOINT_COMPACT_BUDGET_TOKENS',
    flag: 'maskpoint-compact-budget-tokens',
    description: 'Maskpoint: compacted history at or below this many estimated tokens is kept as-is with no model call; above it, one checkpoint call (default: a quarter of the model window, clamped to [24000, 96000]; 24000 when the window is unknown)',
  },
  checkpointModel: {
    env: 'MASKPOINT_CHECKPOINT_MODEL',
    flag: 'maskpoint-checkpoint-model',
    description: 'Maskpoint: model id for the checkpoint call. Accepted and validated, but not yet used: a checkpoint runs on the session model',
  },
  maskReasoning: {
    env: 'MASKPOINT_MASK_REASONING',
    flag: 'maskpoint-mask-reasoning',
    description: 'Maskpoint: also replace assistant reasoning with a one-line placeholder, which cuts the compacted candidate by about a third (default false; short blocks are still kept)',
  },
  notificationLevel: {
    env: 'MASKPOINT_NOTIFICATION_LEVEL',
    flag: 'maskpoint-notification-level',
    description: 'Maskpoint: how much to say in the UI — silent, normal, or verbose (default normal; a decline always shows)',
  },
}

/**
 * Pre-rename channel names, still read and mapped onto the current field with a deprecation
 * warning. The modern name in the same channel always wins (issue #46).
 */
const LEGACY_CHANNELS: Partial<Record<keyof EngineConfig, Channels>> = {
  compactBudgetTokens: {
    env: 'MASKPOINT_CHECKPOINT_TRIGGER_TOKENS',
    flag: 'maskpoint-checkpoint-trigger-tokens',
    description: 'Deprecated: use --maskpoint-compact-budget-tokens',
  },
}

/** Every flag this extension registers with Pi: one per setting, plus the deprecated renames. */
export function flagSpecs(): readonly { name: string; description: string }[] {
  const specs = Object.values(CHANNELS).map((channel) => ({ name: channel.flag, description: channel.description }))
  for (const [field, channel] of Object.entries(LEGACY_CHANNELS) as [keyof EngineConfig, Channels][])
    specs.push({ name: channel.flag, description: `${channel.description} (sets ${field})` })
  return specs
}

/** This run's flag values: modern names first, a field's deprecated flag only when its modern one is unset. */
export function readFlags(getFlag: (name: string) => boolean | string | undefined): { values: Partial<Record<keyof EngineConfig, unknown>>; deprecations: readonly string[] } {
  const values: Partial<Record<keyof EngineConfig, unknown>> = {}
  const deprecations: string[] = []
  for (const [field, channel] of Object.entries(CHANNELS) as [keyof EngineConfig, Channels][]) {
    const modern = getFlag(channel.flag)
    if (modern !== undefined) {
      values[field] = modern
      continue
    }
    const legacy = LEGACY_CHANNELS[field]
    if (legacy === undefined) continue
    const value = getFlag(legacy.flag)
    if (value !== undefined) {
      values[field] = value
      deprecations.push(`--${legacy.flag} is deprecated; use --${channel.flag}`)
    }
  }
  return { values, deprecations }
}

/**
 * Convert text to the field's own type. Only the fields whose type is text itself need this; a
 * value that does not parse is passed through unchanged so the core's validator is the single
 * place that decides a value is invalid and warns about it.
 */
function coerce(field: keyof EngineConfig, value: unknown): unknown {
  if (typeof value !== 'string') return value
  switch (field) {
    case 'enabled':
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
      return value
    case 'compactBudgetTokens':
      return /^\d+$/.test(value) ? Number(value) : value
    case 'maskReasoning':
      return coerce('enabled', value)
    default:
      return value
  }
}

/** The environment layer, built only from variables that are actually set. */
function fromEnvironment(env: PiConfigSources['env']): { raw: Record<string, unknown>; deprecations: readonly string[]; explicit: Set<string> } {
  const raw: Record<string, unknown> = {}
  const deprecations: string[] = []
  const explicit = new Set<string>()
  for (const [field, channels] of Object.entries(CHANNELS) as [keyof EngineConfig, Channels][]) {
    const modern = env?.[channels.env]
    if (modern !== undefined) {
      raw[field] = coerce(field, modern)
      explicit.add(field)
      continue
    }
    const legacy = LEGACY_CHANNELS[field]
    const value = legacy === undefined ? undefined : env?.[legacy.env]
    if (legacy !== undefined && value !== undefined) {
      raw[field] = coerce(field, value)
      explicit.add(field)
      deprecations.push(`${legacy.env} is deprecated; use ${channels.env}`)
    }
  }
  return { raw, deprecations, explicit }
}

/**
 * The flag layer, with the fields Pi reported no value for dropped: an unset flag comes back as
 * `undefined`, which is not a value to validate and must not warn about itself.
 */
function fromFlags(flags: PiConfigSources['flags']): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const [field, channels] of Object.entries(CHANNELS) as [keyof EngineConfig, Channels][]) {
    const value = flags?.[field]
    if (value === undefined) continue
    raw[field] = coerce(field, value)
  }
  return raw
}

/** The host layer's explicitly-set fields, including pre-rename key names. */
function hostExplicit(host: unknown): Set<string> {
  const keys = new Set<string>()
  if (typeof host === 'object' && host !== null && !Array.isArray(host)) {
    for (const key of Object.keys(host)) keys.add(DEPRECATED_KEY_ALIASES[key] ?? key)
  }
  return keys
}
const DEPRECATED_KEY_ALIASES: Readonly<Record<string, string>> = { checkpointTriggerTokens: 'compactBudgetTokens' }

/** Every field, for provenance walks. */
const ALL_FIELDS: readonly (keyof EngineConfig)[] = ['enabled', 'compactBudgetTokens', 'checkpointModel', 'maskReasoning', 'notificationLevel']

/** How each layer names itself when `/maskpoint` reports where a value came from. */
const LAYER_NAMES: readonly string[] = ['host configuration', 'stored configuration', 'environment', 'flag']

/** The resolved config plus, for each field a layer set, which layer that was. */
export interface ConfigWithOrigin {
  readonly config: EngineConfig
  readonly origin: Readonly<Partial<Record<keyof EngineConfig, string>>>
}

/**
 * Resolve Maskpoint's settings from every channel this host offers — the host's own object, the
 * extension's stored file, the environment, and this run's flags — warning through the given
 * callback, and reporting which layer each effective value came from. When no channel set the
 * budget and the session's model window is known, the budget is derived from it
 * (`deriveCompactBudget`); a window of `undefined` leaves the documented flat default standing.
 */
export function resolveConfig(sources: PiConfigSources, warn: (message: string) => void): ConfigWithOrigin {
  const environment = fromEnvironment(sources.env)
  for (const message of environment.deprecations) warn(message)
  const flagsRaw = fromFlags(sources.flags)
  const layers: readonly { source: string; raw: unknown }[] = [
    { source: 'host', raw: sources.host },
    { source: 'stored', raw: sources.stored },
    { source: 'environment', raw: environment.raw },
    { source: 'flag', raw: flagsRaw },
  ]

  // Provenance by cumulative diff: a field belongs to the first layer that changed it away from
  // what stood before. The partial resolutions swallow their warnings; the full one below emits.
  const origin: Partial<Record<keyof EngineConfig, string>> = {}
  let previous: EngineConfig = { ...DEFAULT_ENGINE_CONFIG }
  for (let i = 0; i < layers.length; i++) {
    const partial = resolveEngineConfigLayers(layers.slice(0, i + 1), () => {})
    for (const field of ALL_FIELDS) if (partial[field] !== previous[field]) origin[field] = LAYER_NAMES[i]!
    previous = partial
  }
  const resolved = resolveEngineConfigLayers(layers, warn)

  const budgetExplicit = environment.explicit.has('compactBudgetTokens')
    || flagsRaw.compactBudgetTokens !== undefined
    || hostExplicit(sources.host).has('compactBudgetTokens')
    || hostExplicit(sources.stored).has('compactBudgetTokens')
  if (!budgetExplicit && sources.contextWindow !== undefined) {
    return {
      config: { ...resolved, compactBudgetTokens: deriveCompactBudget(sources.contextWindow) },
      origin: { ...origin, compactBudgetTokens: 'derived from the model window' },
    }
  }
  return { config: resolved, origin }
}

/** `resolveConfig` without the provenance, for callers that only run the engine. */
export function loadConfig(sources: PiConfigSources, warn: (message: string) => void): EngineConfig {
  return resolveConfig(sources, warn).config
}
