import { type EngineConfig, resolveEngineConfigLayers } from '@maskpoint/core'

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
  checkpointTriggerTokens: {
    env: 'MASKPOINT_CHECKPOINT_TRIGGER_TOKENS',
    flag: 'maskpoint-checkpoint-trigger-tokens',
    description: 'Maskpoint: masked history above this many estimated tokens triggers one checkpoint model call (default 12000; raise it to keep compaction free of model calls)',
  },
  checkpointModel: {
    env: 'MASKPOINT_CHECKPOINT_MODEL',
    flag: 'maskpoint-checkpoint-model',
    description: 'Maskpoint: model id for the checkpoint call. Accepted and validated, but not yet used: a checkpoint runs on the session model',
  },
  notificationLevel: {
    env: 'MASKPOINT_NOTIFICATION_LEVEL',
    flag: 'maskpoint-notification-level',
    description: 'Maskpoint: how much to say in the UI — silent, normal, or verbose (default normal; a decline always shows)',
  },
}

/** Every flag this extension registers with Pi, one per setting, for `registerFlag`. */
export function flagSpecs(): readonly { name: string; description: string }[] {
  return Object.values(CHANNELS).map((channel) => ({ name: channel.flag, description: channel.description }))
}

/** This run's value for every setting's flag, read back through Pi's `getFlag`. */
export function readFlags(getFlag: (name: string) => boolean | string | undefined): Record<keyof EngineConfig, unknown> {
  const flags = {} as Record<keyof EngineConfig, unknown>
  for (const [field, channel] of Object.entries(CHANNELS) as [keyof EngineConfig, Channels][]) {
    flags[field] = getFlag(channel.flag)
  }
  return flags
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
    case 'checkpointTriggerTokens':
      return /^\d+$/.test(value) ? Number(value) : value
    default:
      return value
  }
}

/** The environment layer, built only from variables that are actually set. */
function fromEnvironment(env: PiConfigSources['env']): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const [field, channels] of Object.entries(CHANNELS) as [keyof EngineConfig, Channels][]) {
    const value = env?.[channels.env]
    if (value === undefined) continue
    raw[field] = coerce(field, value)
  }
  return raw
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

/** Resolve Maskpoint's settings from every channel this host offers, warning through the given callback. */
export function loadConfig(sources: PiConfigSources, warn: (message: string) => void): EngineConfig {
  return resolveEngineConfigLayers(
    [
      { source: 'host', raw: sources.host },
      { source: 'environment', raw: fromEnvironment(sources.env) },
      { source: 'flag', raw: fromFlags(sources.flags) },
    ],
    warn,
  )
}
