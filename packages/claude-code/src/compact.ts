import {
  type BudgetPolicy,
  type CapabilityProfile,
  DEFAULT_BUDGET,
  decide,
  type DeclineReason,
  type EngineDetail,
} from '@maskpoint/core'
import type { Rec } from './normalize.js'
import { artifactRenderer } from './render.js'
import { buildSnapshot, isDecline, type PreCompactInput } from './snapshot.js'
import type { PersistedState } from './state.js'

/** What this adapter can do: it never replaces the host's compactor, only supplements it. */
export const capabilities: CapabilityProfile = {
  replaceHistory: false,
  steerSummarizer: true,
  reinjectContext: true,
  persistMetadata: true,
  // The PreCompact/PostCompact/SessionStart hook protocol hands a command process a JSON payload on
  // stdin and reads its stdout; it carries no cancellation signal for a hook to honour.
  honestCancellation: false,
  injectionCapChars: 10_000,
}

export type CcEffect =
  | {
      kind: 'assisted'
      /** The artifact rendered as markdown: what gets persisted and, when it fits, re-injected. */
      checkpointText: string
      detail: EngineDetail
      /** The candidate was over budget: a checkpoint would run in a tier that has one; this adapter does not yet. */
      overBudget: boolean
      /** `/compact <focus>` was requested; this adapter cannot apply a focus, only note that one was asked for. */
      focusRequested: boolean
    }
  | { kind: 'decline'; reason: DeclineReason; note?: string }

const decline = (reason: DeclineReason, note?: string): CcEffect => ({ kind: 'decline', reason, ...(note === undefined ? {} : { note }) })

function plan(entries: readonly Rec[] | undefined, input: PreCompactInput, prior: PersistedState | undefined, budget: BudgetPolicy): CcEffect {
  const snapshot = buildSnapshot(entries, input, prior)
  if (isDecline(snapshot)) return decline(snapshot.reason, snapshot.note)

  // Every observation is masked, not only the ones the no-expansion rule would shrink: this artifact
  // is a second copy of session content living outside the host's own transcript store, so a tiny
  // unmasked body here (a one-line secret, a short "OK") would be a new exposure that Pi and DSH
  // never create, since their state lives inside the host's own, already-existing session store.
  const decision = decide(snapshot, budget, { alwaysMask: true })
  if (decision.kind === 'decline') return decline(decision.reason)

  // No checkpoint call in this adapter yet: Claude Code's hook protocol gives a command no model
  // seam to call through, so both the over-budget and the custom-instructions path fall back to the
  // masked-history candidate, which is still a valid, smaller artifact than producing nothing.
  const masked = decision.kind === 'checkpoint-requested' ? decision.fallback : decision
  if (masked.kind !== 'masked-history') return decline('engine-failure', `unexpected outcome "${masked.kind}"`)

  return {
    kind: 'assisted',
    checkpointText: artifactRenderer.render(masked.artifact),
    detail: masked.detail,
    overBudget: decision.kind === 'checkpoint-requested' && decision.reason === 'over-budget',
    focusRequested: decision.kind === 'checkpoint-requested' && decision.reason === 'custom-instructions',
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
  budget: BudgetPolicy = DEFAULT_BUDGET,
): CcEffect {
  try {
    return plan(entries, input, prior, budget)
  } catch (error) {
    return decline('engine-failure', error instanceof Error ? error.message : String(error))
  }
}
