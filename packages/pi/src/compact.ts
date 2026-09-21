import {
  type Artifact,
  type BudgetPolicy,
  type CapabilityProfile,
  type ConversationSnapshot,
  DEFAULT_BUDGET,
  type DeclineReason,
  decide,
  type EngineDetail,
  estimateTokens,
  payloadOf,
} from '@maskpoint/core'
import type { PiBeforeCompactEvent, PiCompactionResult } from './host.js'
import { summaryRenderer } from './render.js'
import { buildSnapshot, isDecline } from './snapshot.js'

/** What Pi's adapter can do: it replaces the host's summarize step, and its state rides in the compaction entry. */
export const capabilities: CapabilityProfile = {
  replaceHistory: true,
  steerSummarizer: false,
  reinjectContext: false,
  persistMetadata: true,
  honestCancellation: true,
}

/**
 * What the adapter decided. `native` is a replacement Pi will persist as its compaction result;
 * `decline` returns nothing, so Pi's own compactor runs. `note` says what was structurally wrong,
 * never what the conversation contained.
 */
export type PiEffect =
  | {
      kind: 'native'
      artifact: Artifact
      /** The artifact rendered as Pi's summary text. */
      summary: string
      /** Pi's own cut point, passed through unchanged. */
      boundary: { id: string }
      detail: EngineDetail
      tokensBefore: number
    }
  | { kind: 'decline'; reason: DeclineReason; note?: string }

const decline = (reason: DeclineReason, note?: string): PiEffect => ({
  kind: 'decline',
  reason,
  ...(note === undefined ? {} : { note }),
})

/** What Pi charges for one image (4,800 characters at four per token): the estimator cannot see an image. */
const IMAGE_TOKENS = 1200

/**
 * What the replaced span cost before: the earlier summary plus the newly evicted history as Pi
 * held it, bodies and images included.
 */
function tokensReplaced(snapshot: ConversationSnapshot): number {
  const { items, boundary, evictedThrough } = snapshot
  const from = evictedThrough === undefined ? 0 : items.findIndex((item) => item.id === evictedThrough) + 1
  const to = items.findIndex((item) => item.id === boundary.id)
  const evicted = items.slice(from, to).reduce((total, item) => {
    const images = item.kind === 'tool-result' ? item.media : 0
    return total + estimateTokens(payloadOf(item)) + images * IMAGE_TOKENS
  }, 0)
  return evicted + estimateTokens(snapshot.previousCheckpoint ?? '')
}

function plan(event: PiBeforeCompactEvent, budget: BudgetPolicy): PiEffect {
  const snapshot = buildSnapshot(event)
  if (isDecline(snapshot)) return decline(snapshot.reason, snapshot.note)

  const decision = decide(snapshot, budget)
  if (decision.kind === 'decline') return decline(decision.reason)
  // A focus needs a model to apply it, and this adapter makes no model call. Pi's own compactor
  // honours it, which is what the user would get without Maskpoint installed.
  if (decision.kind === 'checkpoint-requested' && decision.reason === 'custom-instructions') {
    return decline('checkpoint-unavailable', 'custom instructions need a checkpoint')
  }
  // Over budget with no checkpoint to run: the masked history is still a valid, smaller result.
  const masked = decision.kind === 'checkpoint-requested' ? decision.fallback : decision
  if (masked.kind !== 'masked-history') return decline('engine-failure', `unexpected outcome "${masked.kind}"`)

  const summary = summaryRenderer.render(masked.artifact)
  // Context must strictly shrink: framing and role labels cost something, so a span with little to
  // mask can render larger than it was.
  if (!(estimateTokens(summary) < tokensReplaced(snapshot))) return decline('no-size-reduction')

  return {
    kind: 'native',
    artifact: masked.artifact,
    summary,
    boundary: { id: event.preparation.firstKeptEntryId },
    detail: masked.detail,
    tokensBefore: event.preparation.tokensBefore,
  }
}

/**
 * Decide what to do with Pi's pre-compaction event. Synchronous and model-free, and it never
 * throws: a fault becomes a decline, so a session is never left without a compaction result.
 */
export function planCompaction(event: PiBeforeCompactEvent, budget: BudgetPolicy = DEFAULT_BUDGET): PiEffect {
  try {
    return plan(event, budget)
  } catch (error) {
    return decline('engine-failure', error instanceof Error ? error.message : String(error))
  }
}

/** The result Pi persists as its compaction entry. The cut point is exactly the one Pi prepared. */
export function toPiResult(effect: Extract<PiEffect, { kind: 'native' }>): PiCompactionResult {
  return {
    compaction: {
      summary: effect.summary,
      firstKeptEntryId: effect.boundary.id,
      tokensBefore: effect.tokensBefore,
      details: effect.detail,
    },
  }
}
