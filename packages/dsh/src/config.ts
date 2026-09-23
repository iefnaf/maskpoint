import Schema from '@deepseek-ai/schemastery'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { type EngineConfig, resolveEngineConfigLayer } from '@maskpoint/core'

/**
 * Maskpoint's own fields on the `compaction-basic` config row. `checkpointModel` is deliberately not
 * one of them: the host's own `summarizationProvider`/`summarizationModel` (`BasicCompactionConfig`)
 * already say who writes a checkpoint, and this backend reads them unchanged (`policy.ts`,
 * `resolveSummarizer`) — a second, Maskpoint-specific model field would just be two ways to say the
 * same thing.
 *
 * Declared as `Schema.any()`, not typed and range-checked here, on purpose: cordis validates a row's
 * `config` before this plugin's constructor ever runs, and a schema that throws on a bad value would
 * take the whole backend down with it — the opposite of "invalid values warn and fall back to
 * defaults rather than failing the compaction" (docs/spec.md, Configuration). `resolveEngineConfigLayer`
 * does the real validation, after construction, the same way `resolveTrigger`/`PolicyError` already
 * degrade a bad model policy without refusing to load (`policy.ts`, `engine.ts`).
 */
export const MASKPOINT_CONFIG_SCHEMA = Schema.object({
  enabled: Schema.any().description('Enable Maskpoint masking and checkpointing on this row. Defaults to true.'),
  compactBudgetTokens: Schema.any().description(
    'Token budget at or below which compacted history is kept as-is with no model call; above it, one checkpoint call. Defaults to 24000.',
  ),
  notificationLevel: Schema.any().description('How much this row logs per compaction: "silent", "normal", or "verbose". Defaults to "normal".'),
})

/** Resolve this row's Maskpoint fields, warning through the host's own logger for anything invalid. */
export function resolveDshConfig(config: unknown, warn: (message: string) => void): EngineConfig {
  return resolveEngineConfigLayer(config, warn)
}

/**
 * `BasicCompactionConfig`'s own top-level keys (`dsh-compaction-basic/lib/types/types.ts`,
 * `CompactionPolicyConfig` and `BasicCompactionConfig`). The host's own `resolveConfig`, called
 * inside `BasicCompactionEngine`'s constructor, rejects a config object outright if it carries a key
 * this list does not name — so a Maskpoint field must never reach it, misspelled or not.
 */
const HOST_CONFIG_KEYS = new Set([
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

/**
 * Split a row's raw config into what the host's own strict constructor may see (`base`) and
 * everything else (`own`, resolved by `resolveDshConfig`). Routing is "known host key → `base`,
 * anything else → `own`" rather than a Maskpoint-field allowlist, precisely so a misspelled
 * Maskpoint key (or any other stray key) lands on `resolveEngineConfigLayer`'s forgiving "unknown
 * key, warn and ignore" path instead of the host's throwing one — the same "invalid configuration
 * warns and falls back" guarantee this module gives a bad *value*, extended to a bad *key*.
 */
export function splitDshConfig(config: Record<string, unknown> | undefined): { base: BasicCompactionConfig | undefined; own: Record<string, unknown> | undefined } {
  if (config === undefined) return { base: undefined, own: undefined }
  const base: Record<string, unknown> = {}
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (HOST_CONFIG_KEYS.has(key)) base[key] = value
    else own[key] = value
  }
  return { base: base as BasicCompactionConfig, own }
}
