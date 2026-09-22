import {
  type BudgetPolicy,
  type CapabilityProfile,
  DEFAULT_BUDGET,
  decide,
  type DeclineReason,
  type EngineDetail,
} from '@maskpoint/core'
import { checkWiring, ensureCompactPrompt } from './config.js'
import type { Rec } from './normalize.js'
import { artifactRenderer } from './render.js'
import { buildSnapshot, isDecline, type PreCompactInput } from './snapshot.js'
import type { PersistedState } from './state.js'

/**
 * What this adapter can do: it never replaces Codex's own compactor, only supplements it.
 * `steerSummarizer` is true because the preservation-prompt channel exists and is documented
 * (`experimental_compact_prompt_file`) — whether it is actually *wired in* for a given install is a
 * runtime fact (`CcEffect.wiring`), not a static capability, exactly as Open issue 3 frames the
 * analogous "is native compaction active" question: capability describes what the channel can do in
 * principle, not whether this session happens to have it connected.
 */
export const capabilities: CapabilityProfile = {
  replaceHistory: false,
  steerSummarizer: true,
  reinjectContext: true,
  persistMetadata: true,
  // The PreCompact/PostCompact/SessionStart hook protocol hands a command process a JSON payload on
  // stdin and reads its stdout; it carries no cancellation signal for a hook to honour.
  honestCancellation: false,
  // No documented injection cap for Codex's SessionStart additionalContext; omitted rather than
  // reporting a number this adapter cannot attribute to host documentation. This adapter still
  // enforces a practical, undocumented ceiling on itself — see render.ts, `PRACTICAL_INJECTION_CEILING`
  // — which is deliberately not mirrored here, for the same reason it is omitted in the first place.
}

export type CcEffect =
  | {
      kind: 'assisted'
      /** The artifact rendered as markdown: what gets persisted and, when it fits, re-injected. */
      checkpointText: string
      detail: EngineDetail
      /** The candidate was over budget: a checkpoint would run in a tier that has one; this adapter does not yet. */
      overBudget: boolean
      /** Custom instructions were requested; this adapter cannot apply a focus, only note that one was asked for. */
      focusRequested: boolean
      /** Whether the preservation prompt actually reached Codex's compaction-prompt configuration this run. */
      wiring: ReturnType<typeof checkWiring>
    }
  | { kind: 'decline'; reason: DeclineReason; note?: string }

const decline = (reason: DeclineReason, note?: string): CcEffect => ({ kind: 'decline', reason, ...(note === undefined ? {} : { note }) })

function plan(
  entries: readonly Rec[] | undefined,
  input: PreCompactInput,
  prior: PersistedState | undefined,
  budget: BudgetPolicy,
  codexHome: string,
): CcEffect {
  const snapshot = buildSnapshot(entries, input, prior)
  if (isDecline(snapshot)) return decline(snapshot.reason, snapshot.note)

  // Every observation is masked, not only the ones the no-expansion rule would shrink: this artifact
  // is a second copy of session content living outside Codex's own rollout store, so a tiny unmasked
  // body here (a one-line secret, a short "OK") would be a new exposure (mirrors the Claude Code
  // adapter's reasoning in compact.ts).
  const decision = decide(snapshot, budget, { alwaysMask: true })
  if (decision.kind === 'decline') return decline(decision.reason)

  // No checkpoint call in this adapter yet: Codex's hook protocol gives a command no model seam to
  // call through, so both the over-budget and the custom-instructions path fall back to the
  // masked-history candidate, which is still a valid, smaller artifact than producing nothing.
  const masked = decision.kind === 'checkpoint-requested' ? decision.fallback : decision
  if (masked.kind !== 'masked-history') return decline('engine-failure', `unexpected outcome "${masked.kind}"`)

  // Ensure the managed compact-prompt file carries the preservation directive, and check whether
  // Codex's own config.toml is actually wired to read it. A missing or changed wiring path degrades
  // to reporting `wired: false`, never to a decline — the re-injection path below is unaffected.
  let wiring: ReturnType<typeof checkWiring>
  try {
    ensureCompactPrompt(codexHome)
    wiring = checkWiring(codexHome)
  } catch {
    // The prompt-file write and config read are best-effort; a failure here never blocks the artifact.
    wiring = { wired: false, reason: 'no-config' }
  }

  return {
    kind: 'assisted',
    checkpointText: artifactRenderer.render(masked.artifact),
    detail: masked.detail,
    overBudget: decision.kind === 'checkpoint-requested' && decision.reason === 'over-budget',
    focusRequested: decision.kind === 'checkpoint-requested' && decision.reason === 'custom-instructions',
    wiring,
  }
}

/**
 * Decide what a pre-compaction hook invocation produces. Synchronous and never throws: a fault
 * becomes a decline, so a hook run can never leave the process without a defined result to act on.
 */
export function planCompaction(
  entries: readonly Rec[] | undefined,
  input: PreCompactInput,
  prior: PersistedState | undefined,
  codexHome: string,
  budget: BudgetPolicy = DEFAULT_BUDGET,
): CcEffect {
  try {
    return plan(entries, input, prior, budget, codexHome)
  } catch (error) {
    return decline('engine-failure', error instanceof Error ? error.message : String(error))
  }
}
