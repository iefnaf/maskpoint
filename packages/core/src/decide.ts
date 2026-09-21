import { candidateTokens } from './candidate.js'
import { mergeFileOps } from './fileops.js'
import { locateBoundary, maskItems, MaskingError } from './mask.js'
import type { ArtifactSection, BudgetPolicy, ConversationSnapshot, DeclineReason, EngineDetail, Item, Outcome } from './vocabulary.js'

export type MaskedHistoryOutcome = Extract<Outcome, { kind: 'masked-history' }>

/**
 * The items the host has evicted since the previous compaction: everything before the retained
 * boundary that the previous state does not already represent. Where the state and the cursor
 * disagree it returns a decline reason instead, because appending on a guess could double-append
 * the same span (or drop one).
 */
function newlyEvicted(snapshot: ConversationSnapshot): Item[] | DeclineReason {
  const { items, previousCheckpoint, evictedThrough } = snapshot
  let cut: number
  try {
    cut = locateBoundary(items, snapshot.boundary)
  } catch (error) {
    if (error instanceof MaskingError) return 'masking-failure'
    throw error
  }

  // The cursor and the state it describes come together or not at all: state without a cursor
  // could be appended to twice; a cursor without state would silently drop what it says is kept.
  if ((previousCheckpoint === undefined) !== (evictedThrough === undefined)) return 'inconsistent-cursor'
  if (evictedThrough === undefined) return items.slice(0, cut)

  const at = items.findIndex((item) => item.id === evictedThrough)
  // A cursor that names nothing, or that reaches into the retained region, cannot be trusted.
  if (at === -1 || at >= cut) return 'inconsistent-cursor'
  return items.slice(at + 1, cut)
}

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
 * Decide what a compaction returns. Pure and synchronous: it takes no model and no host, so the
 * masked-history path cannot make a model call — only the request for one, when the budget says so.
 */
export function decide(snapshot: ConversationSnapshot, budget: BudgetPolicy): Decision {
  const evicted = newlyEvicted(snapshot)
  if (typeof evicted === 'string') return { kind: 'decline', reason: evicted }

  const { previousCheckpoint } = snapshot
  const { items: masked, stats } = maskItems(evicted)
  const sections: ArtifactSection[] = []
  if (previousCheckpoint !== undefined) sections.push({ kind: 'checkpoint', text: previousCheckpoint })
  if (masked.length > 0) sections.push({ kind: 'masked-history', items: masked })
  if (sections.length === 0) return { kind: 'decline', reason: 'nothing-to-compact' }

  const allStats = { ...stats, candidateTokens: candidateTokens(previousCheckpoint, masked) }
  const evictedThroughId = evicted.at(-1)?.id ?? snapshot.evictedThrough
  const files = mergeFileOps(snapshot.previousDetail?.files, snapshot.fileOps)
  const detail: EngineDetail = {
    v: 1,
    engine: 'maskpoint',
    strategy: 'mask',
    checkpoints: snapshot.previousDetail?.checkpoints ?? 0,
    stats: allStats,
    ...(files === undefined ? {} : { files }),
    ...(evictedThroughId === undefined ? {} : { cursor: { boundaryId: snapshot.boundary.id, evictedThroughId } }),
  }
  const maskedHistory: MaskedHistoryOutcome = {
    kind: 'masked-history',
    artifact: { sections, stats: allStats },
    detail,
    stats: allStats,
  }

  // Written as "within budget or not" so that a candidate or a budget that cannot be compared
  // (NaN) lands on the checkpoint path instead of silently passing.
  const withinBudget = allStats.candidateTokens <= budget.checkpointTriggerTokens
  if (snapshot.customInstructions?.trim()) {
    return { kind: 'checkpoint-requested', reason: 'custom-instructions', fallback: maskedHistory }
  }
  if (!withinBudget) return { kind: 'checkpoint-requested', reason: 'over-budget', fallback: maskedHistory }
  return maskedHistory
}
