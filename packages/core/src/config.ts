import { DEFAULT_BUDGET } from './decide.js'

/** How much a compaction logs. Adapters decide what each level actually suppresses. */
export type NotificationLevel = 'silent' | 'normal' | 'verbose'

/** The shared engine settings every adapter maps onto its host's own configuration surface. */
export interface EngineConfig {
  /** When false, an adapter must behave as though it were not installed: no artifact, no state. */
  readonly enabled: boolean
  /** `BudgetPolicy.checkpointTriggerTokens` — docs/design.md, "Budget". */
  readonly checkpointTriggerTokens: number
  /** A registered model id to use for the checkpoint call instead of the session's own. */
  readonly checkpointModel?: string
  readonly notificationLevel: NotificationLevel
}

/** The design's documented defaults (docs/spec.md, "Configuration"). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  enabled: true,
  checkpointTriggerTokens: DEFAULT_BUDGET.checkpointTriggerTokens,
  notificationLevel: 'normal',
}

/** One thing that was wrong with a raw configuration value, and what happened instead. */
export interface ConfigWarning {
  readonly field: string
  readonly message: string
}

export interface ConfigResolution {
  readonly config: EngineConfig
  readonly warnings: readonly ConfigWarning[]
}

const KNOWN_KEYS: readonly (keyof EngineConfig)[] = ['enabled', 'checkpointTriggerTokens', 'checkpointModel', 'notificationLevel']

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate and apply one raw configuration layer onto `into`, in place, recording a warning for
 * every unknown key and every value that fails its field's validation — which is then simply
 * skipped, leaving whatever an earlier layer (or the documented default) already resolved. `source`
 * names the layer in warning text ("global", "project") so an operator can tell which file to fix.
 */
function applyLayer(raw: unknown, source: string, into: { -readonly [K in keyof EngineConfig]?: EngineConfig[K] }, warnings: ConfigWarning[]): void {
  if (raw === undefined) return
  if (!isPlainObject(raw)) {
    warnings.push({ field: source, message: `${source} configuration must be an object; ignoring it` })
    return
  }
  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      warnings.push({ field: key, message: `unknown ${source} configuration key "${key}" ignored` })
      continue
    }
    const value = raw[key]
    const invalid = (): void => {
      warnings.push({ field: key, message: `invalid ${source} value for "${key}" (${JSON.stringify(value)}); ignoring it` })
    }
    switch (key as keyof EngineConfig) {
      case 'enabled':
        if (typeof value === 'boolean') into.enabled = value
        else invalid()
        break
      case 'checkpointTriggerTokens':
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) into.checkpointTriggerTokens = value
        else invalid()
        break
      case 'checkpointModel':
        if (typeof value === 'string' && value.trim() !== '') into.checkpointModel = value
        else invalid()
        break
      case 'notificationLevel':
        if (value === 'silent' || value === 'normal' || value === 'verbose') into.notificationLevel = value
        else invalid()
        break
    }
  }
}

/**
 * Resolve the engine's shared settings from up to two untrusted raw layers: `global` always
 * applies; `project` applies only when `projectTrusted` is true (docs/design.md, Security and
 * privacy — "an untrusted repository influencing compaction"). An untrusted `project` is not parsed
 * at all — a single warning names it as ignored, so a malformed value inside it cannot itself
 * produce a second, more specific warning that implies it was read.
 *
 * Pure and host-free: an adapter supplies its own raw layers (however it reads them from its host's
 * native configuration location) and its own answer to "is this project trusted", which is not a
 * question the engine can answer on the host's behalf.
 */
export function resolveEngineConfig(input: { global?: unknown; project?: unknown; projectTrusted: boolean }): ConfigResolution {
  const warnings: ConfigWarning[] = []
  const resolved: { -readonly [K in keyof EngineConfig]?: EngineConfig[K] } = {}
  applyLayer(input.global, 'global', resolved, warnings)

  if (input.project !== undefined) {
    if (!input.projectTrusted) {
      warnings.push({ field: 'project', message: 'project configuration ignored: this project is not trusted' })
    } else {
      applyLayer(input.project, 'project', resolved, warnings)
    }
  }

  return { config: { ...DEFAULT_ENGINE_CONFIG, ...resolved }, warnings }
}

/**
 * `resolveEngineConfig` for a host that hands an adapter exactly one already-merged configuration
 * layer, with no way to tell a global setting from a project one (docs/design.md, DSH adapter —
 * cordis hands a plugin one resolved config object). Treated as the trusted `global` layer: the
 * value came from wherever the operator mounted this plugin, which is the same trust boundary as
 * installing it at all, never from an untrusted repository reachable independently of that.
 */
export function resolveEngineConfigLayer(raw: unknown, warn: (message: string) => void): EngineConfig {
  const { config, warnings } = resolveEngineConfig({ global: raw, projectTrusted: false })
  for (const warning of warnings) warn(warning.message)
  return config
}
