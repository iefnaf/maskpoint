import { DEFAULT_BUDGET } from './decide.js'
import type { MaskOptions } from './mask.js'
import type { BudgetPolicy } from './vocabulary.js'

/** How much a compaction logs. Adapters decide what each level actually suppresses. */
export type NotificationLevel = 'silent' | 'normal' | 'verbose'

/** The shared engine settings every adapter maps onto its host's own configuration surface. */
export interface EngineConfig {
  /** When false, an adapter must behave as though it were not installed: no artifact, no state. */
  readonly enabled: boolean
  /**
   * `BudgetPolicy.compactBudgetTokens` — docs/design.md, "Budget". The documented default is the
   * flat fallback; an adapter that can see the model's context window should derive instead
   * (`deriveCompactBudget`) unless this was set explicitly.
   */
  readonly compactBudgetTokens: number
  /** A registered model id to use for the checkpoint call instead of the session's own. */
  readonly checkpointModel?: string
  /**
   * When false, a compaction never makes its one checkpoint call: an over-budget candidate stays
   * masked history however large, and a manual focus request degrades to the same fallback. The
   * budget still governs nothing but is kept honest in `/maskpoint`'s listing. Off trades context
   * size for latency — the call is the only step that can stall a compaction.
   */
  readonly checkpointEnabled: boolean
  /**
   * Mask assistant reasoning as well as observations (`MaskOptions.maskReasoning`). Off by default:
   * the design promises reasoning verbatim, and the one measurement of the trade-off
   * (`docs/reasoning-masking-evaluation.md`) left the checkpoint path untested.
   */
  readonly maskReasoning: boolean
  readonly notificationLevel: NotificationLevel
}

/** The design's documented defaults (docs/spec.md, "Configuration"). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  enabled: true,
  compactBudgetTokens: DEFAULT_BUDGET.compactBudgetTokens,
  checkpointEnabled: true,
  maskReasoning: false,
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

const KNOWN_KEYS: readonly (keyof EngineConfig)[] = ['enabled', 'compactBudgetTokens', 'checkpointModel', 'checkpointEnabled', 'maskReasoning', 'notificationLevel']

/**
 * Pre-renames of `EngineConfig` keys, still accepted in any layer and mapped onto their current
 * name with a deprecation warning: `checkpointTriggerTokens` became `compactBudgetTokens` when the
 * budget learned to scale with the model's context window (issue #46).
 */
const DEPRECATED_KEYS: Readonly<Record<string, keyof EngineConfig>> = { checkpointTriggerTokens: 'compactBudgetTokens' }

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
    const deprecatedTo = DEPRECATED_KEYS[key]
    if (deprecatedTo !== undefined && KNOWN_KEYS.includes(key as keyof EngineConfig) === false && !(deprecatedTo in raw)) {
      warnings.push({ field: deprecatedTo, message: `"${key}" is deprecated; use "${deprecatedTo}"` })
    }
    if (!(KNOWN_KEYS as readonly string[]).includes(key) && deprecatedTo === undefined) {
      warnings.push({ field: key, message: `unknown ${source} configuration key "${key}" ignored` })
      continue
    }
    const field = (deprecatedTo !== undefined && !(deprecatedTo in raw) ? deprecatedTo : key) as keyof EngineConfig
    const value = raw[key]
    const invalid = (): void => {
      warnings.push({ field: key, message: `invalid ${source} value for "${key}" (${JSON.stringify(value)}); ignoring it` })
    }
    switch (field) {
      case 'enabled':
        if (typeof value === 'boolean') into.enabled = value
        else invalid()
        break
      case 'compactBudgetTokens':
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) into.compactBudgetTokens = value
        else invalid()
        break
      case 'checkpointModel':
        if (typeof value === 'string' && value.trim() !== '') into.checkpointModel = value
        else invalid()
        break
      case 'checkpointEnabled':
        if (typeof value === 'boolean') into.checkpointEnabled = value
        else invalid()
        break
      case 'maskReasoning':
        if (typeof value === 'boolean') into.maskReasoning = value
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
 * `resolveEngineConfig` for a host that hands an adapter already-merged configuration layers it
 * cannot label as global or project. Later layers win, and each names itself in a warning, so an
 * operator can tell which surface to go and fix (docs/design.md, Pi adapter — the host's own
 * object, the process environment, and this extension's CLI flags).
 *
 * A layer that is absent (`undefined`) contributes nothing and warns about nothing: on a host that
 * supplies no configuration for an extension at all, every one of its layers is simply missing.
 */
export function resolveEngineConfigLayers(
  layers: readonly { source: string; raw: unknown }[],
  warn: (message: string) => void,
): EngineConfig {
  const warnings: ConfigWarning[] = []
  const resolved: { -readonly [K in keyof EngineConfig]?: EngineConfig[K] } = {}
  for (const layer of layers) applyLayer(layer.raw, layer.source, resolved, warnings)
  for (const warning of warnings) warn(warning.message)
  return { ...DEFAULT_ENGINE_CONFIG, ...resolved }
}

/**
 * `resolveEngineConfigLayers` for a host that hands an adapter exactly one already-merged
 * configuration layer, with no way to tell a global setting from a project one (docs/design.md, DSH
 * adapter — cordis hands a plugin one resolved config object). Treated as the trusted `global`
 * layer: the value came from wherever the operator mounted this plugin, which is the same trust
 * boundary as installing it at all, never from an untrusted repository reachable independently of
 * that.
 */
export function resolveEngineConfigLayer(raw: unknown, warn: (message: string) => void): EngineConfig {
  return resolveEngineConfigLayers([{ source: 'global', raw }], warn)
}

/** The `BudgetPolicy` an `EngineConfig` implies, so every adapter builds it the same way. */
export function budgetOf(config: Pick<EngineConfig, 'compactBudgetTokens'>): BudgetPolicy {
  return { compactBudgetTokens: config.compactBudgetTokens }
}

/** The measured shape of the window-derived budget (docs/budget-calibration.md): a quarter of the window, clamped. */
export const COMPACT_BUDGET_WINDOW_FRACTION = 0.25
/** The floor: below this, mask-only could rarely win even on the smallest windows. */
export const COMPACT_BUDGET_MIN_TOKENS = 24_000
/** The ceiling: holed history above this must be distilled, whatever the window (measured max candidate: 309k). */
export const COMPACT_BUDGET_MAX_TOKENS = 96_000

/**
 * The compact budget for a model whose context window is known: a fixed fraction of the window,
 * clamped. Calibrated against real compaction events (docs/budget-calibration.md): 62 % of events
 * stay mask-only, versus 7 % at the old flat 12k, while the artifact's share of the window stays
 * bounded. Invalid windows fall back to the flat default.
 */
export function deriveCompactBudget(contextWindow: number): number {
  if (!(typeof contextWindow === 'number') || !Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_ENGINE_CONFIG.compactBudgetTokens
  const scaled = Math.round(COMPACT_BUDGET_WINDOW_FRACTION * contextWindow)
  return Math.min(Math.max(scaled, COMPACT_BUDGET_MIN_TOKENS), COMPACT_BUDGET_MAX_TOKENS)
}

/** The `MaskOptions` an `EngineConfig` implies, so no adapter has to remember the field mapping. */
export function maskOptionsOf(config: Pick<EngineConfig, 'maskReasoning'>): MaskOptions {
  return { maskReasoning: config.maskReasoning }
}
