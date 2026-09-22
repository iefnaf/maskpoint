import { candidateTokens } from './candidate.js'
import { mergeFileOps } from './fileops.js'
import { locateBoundary, type MaskOptions, MaskingError, maskItems } from './mask.js'
import type {
  ArtifactSection,
  BudgetPolicy,
  ConversationSnapshot,
  DeclineReason,
  EngineDetail,
  Item,
  MaskedHistoryOutcome,
  Outcome,
} from './vocabulary.js'

/** The initial budget, in estimated tokens. A tuning parameter, not a derived constant (docs/design.md, "Budget"). */
export const DEFAULT_BUDGET: BudgetPolicy = { checkpointTriggerTokens: 12_000 }

/**
 * The candidate is over budget, or the caller asked for a focus: one checkpoint call should
 * condense it. The fallback is the masked history to return instead if that call is rejected, and
 * its artifact is the checkpoint's input — accumulated masked history, never observation bodies.
 */
export interface CheckpointRequest {
  kind: 'checkpoint-requested'
  reason: 'over-budget' | 'custom-instructions'
  fallback: MaskedHistoryOutcome
}

/** What `decide` returns: a finished outcome, or a request for the one checkpoint call. */
export type Decision = Outcome | CheckpointRequest

/**
 * The items the host has evicted since the previous compaction: everything before the retained
 * boundary that `previous` does not already represent. Where the state and the cursor disagree it
 * returns a decline reason instead, because appending on a guess could double-append the same span
 * (or drop one).
 */
function evictedSince(snapshot: ConversationSnapshot, previous: string | undefined): Item[] | DeclineReason {
  const { items, evictedThrough } = snapshot
  let cut: number
  try {
    cut = locateBoundary(items, snapshot.boundary)
  } catch (error) {
    if (error instanceof MaskingError) return 'masking-failure'
    throw error
  }

  // The state, its cursor and the details that describe it come together or not at all. State
  // without a cursor could be appended to twice; a cursor or details without state would silently
  // drop what they say is kept.
  if ((previous === undefined) !== (evictedThrough === undefined)) return 'inconsistent-cursor'
  if (previous === undefined && snapshot.previousDetail !== undefined) return 'inconsistent-cursor'
  if (evictedThrough === undefined) return items.slice(0, cut)

  const at = items.findIndex((item) => item.id === evictedThrough)
  // A cursor that names nothing, or that reaches into the retained region, cannot be trusted.
  if (at === -1 || at >= cut) return 'inconsistent-cursor'
  return items.slice(at + 1, cut)
}

/**
 * Decide what a compaction returns. Pure and synchronous: it takes no model and no host, so the
 * masked-history path cannot make a model call — only the request for one, when the budget says so.
 */
export function decide(snapshot: ConversationSnapshot, budget: BudgetPolicy, options: MaskOptions = {}): Decision {
  // Empty previous state is no state: it can back no cursor and must not become an empty section.
  const previous = snapshot.previousCheckpoint === '' ? undefined : snapshot.previousCheckpoint
  const evicted = evictedSince(snapshot, previous)
  if (typeof evicted === 'string') return { kind: 'decline', reason: evicted }

  const { items: masked, stats: maskStats } = maskItems(evicted, options)
  const sections: ArtifactSection[] = []
  if (previous !== undefined) sections.push({ kind: 'checkpoint', text: previous })
  if (masked.length > 0) sections.push({ kind: 'masked-history', items: masked })
  if (sections.length === 0) return { kind: 'decline', reason: 'nothing-to-compact' }

  const measured = { ...maskStats, candidateTokens: candidateTokens(previous, masked) }
  const evictedThroughId = evicted.at(-1)?.id ?? snapshot.evictedThrough
  const files = mergeFileOps(snapshot.previousDetail?.files, snapshot.fileOps)
  const detail: EngineDetail = {
    v: 1,
    engine: 'maskpoint',
    strategy: 'mask',
    checkpoints: snapshot.previousDetail?.checkpoints ?? 0,
    stats: { ...measured },
    ...(files === undefined ? {} : { files }),
    ...(evictedThroughId === undefined ? {} : { cursor: { boundaryId: snapshot.boundary.id, evictedThroughId } }),
  }
  const maskedHistory: MaskedHistoryOutcome = {
    kind: 'masked-history',
    artifact: { sections, stats: { ...measured } },
    detail,
    stats: measured,
  }

  if (snapshot.customInstructions?.trim()) {
    return { kind: 'checkpoint-requested', reason: 'custom-instructions', fallback: maskedHistory }
  }
  // Written as "within budget or not" so that a candidate or a budget that cannot be compared
  // (NaN) lands on the checkpoint path instead of silently passing.
  const withinBudget = measured.candidateTokens <= budget.checkpointTriggerTokens
  if (!withinBudget) return { kind: 'checkpoint-requested', reason: 'over-budget', fallback: maskedHistory }
  return maskedHistory
}
