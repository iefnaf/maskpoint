// The adapter's public contract: what packages/pi/src/extension.ts itself needs to wire Pi's
// pre-compaction event to `planCompaction`, plus `capabilities` (the published `CapabilityProfile`,
// docs/design.md "Interfaces"). Internals such as `snapshot.ts`'s `buildSnapshot`/`isDecline` and
// `render.ts`'s `summaryRenderer` are not part of it and are reached by relative import within the
// package's own tests instead.
export { capabilities, planCompaction, toPiResult } from './compact.js'
export type { PiEffect } from './compact.js'
export type { PiBeforeCompactEvent, PiCompactionResult, PiContext, PiExtensionApi } from './host.js'
