import { type EngineConfig, resolveEngineConfigLayer } from '@maskpoint/core'
import type { PiContext } from './host.js'

/**
 * Maskpoint's settings for Pi, resolved from whatever `ctx.config` carries. Unlike Claude Code and
 * DSH, this package can do no I/O of its own — `test/package.test.ts` pins every source import to a
 * relative module or `@maskpoint/core`, so this adapter has no way to read a config file directly
 * even if it wanted to. `PiContext.config` (`host.ts`) is therefore its only channel for
 * configuration, and, like the rest of `host.ts`, it is written structurally rather than against a
 * documented Pi API: drift is a conformance-fixture concern, not a type error.
 *
 * Real per-project-versus-global layering, and a trust signal for the difference (docs/design.md,
 * Security and privacy), are not something this package can express until a real Pi release shows
 * what `ctx.config` actually carries. Until then, whatever it carries is resolved as one layer, the
 * same way DSH's single merged row config is (`@maskpoint/dsh`'s `resolveDshConfig`,
 * `resolveEngineConfigLayer`): it came from wherever the operator installed or configured this
 * extension, the same trust boundary as installing it at all — never from a project this session
 * happens to be running in independently of that.
 */
export function loadConfig(ctx: PiContext, warn: (message: string) => void): EngineConfig {
  return resolveEngineConfigLayer(ctx.config, warn)
}
