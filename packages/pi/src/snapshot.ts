import type { ConversationSnapshot, DeclineReason, Item } from '@maskpoint/core'
import { fileOpsOf, latestEngineDetail } from './details.js'
import type { PiBeforeCompactEvent } from './host.js'
import { isRecord, itemId, normalizeEntry, type Rec, UnrecognizedShape, yieldsMessage } from './normalize.js'

/** Why no snapshot could be built. `note` says what was wrong with the structure, never what it contained. */
export interface SnapshotDecline {
  reason: DeclineReason
  note: string
}

const unreadable = (note: string): SnapshotDecline => ({ reason: 'unreadable-snapshot', note })

/**
 * Translate Pi's compaction event into the engine's snapshot. Pi supplies the cut point
 * (`firstKeptEntryId`) and, on a repeated compaction, where the previous one left off, so nothing
 * here chooses a boundary: the retained boundary is Pi's, and the span already represented in the
 * previous summary is the one Pi itself skipped.
 *
 * Anything that cannot be read, recognized or reconciled with Pi's own preparation comes back as a
 * decline, so Pi's compactor runs instead. A guess here could double-append or drop history.
 */
export function buildSnapshot(event: PiBeforeCompactEvent): ConversationSnapshot | SnapshotDecline {
  const { preparation, branchEntries } = event
  if (!isRecord(preparation)) return unreadable('the compaction preparation is missing')
  if (!Array.isArray(branchEntries)) return unreadable('the branch entries are not a list')
  if (!Array.isArray(preparation.messagesToSummarize) || !Array.isArray(preparation.turnPrefixMessages)) {
    return unreadable('the preparation lists no messages to summarize')
  }

  const entries: (Rec & { id: string })[] = []
  for (const [index, entry] of branchEntries.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.type !== 'string') {
      return unreadable(`branch entry ${index} is not a session entry`)
    }
    entries.push(entry as Rec & { id: string })
  }

  const kept = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId)
  if (kept === -1) return unreadable('the first kept entry is not on the branch')

  // Where the previous compaction left off. Pi restarts the span at that compaction's first kept
  // entry, or just after the compaction when that entry is gone; everything before is already in
  // the previous summary.
  let represented = 0
  let previousCheckpoint: string | undefined
  const previous = entries.findLastIndex((entry) => entry.type === 'compaction')
  if (previous >= 0) {
    const earlier = entries[previous]!
    if (typeof earlier.summary !== 'string' || earlier.summary.trim() === '') {
      return { reason: 'inconsistent-cursor', note: 'the previous compaction carries no summary to build on' }
    }
    if (preparation.previousSummary !== earlier.summary) {
      return unreadable("Pi's previous summary is not the one on the branch")
    }
    const keptThen = entries.findIndex((entry) => entry.id === earlier.firstKeptEntryId)
    represented = keptThen >= 0 ? keptThen : previous + 1
    // The core calls carried state a "checkpoint" whichever strategy wrote it (docs/design.md,
    // "Accumulation"). Here it is masked history when Maskpoint wrote it and Pi's own summary when not.
    previousCheckpoint = earlier.summary
  } else if (preparation.previousSummary !== undefined) {
    return unreadable('Pi reports a previous summary but the branch has no compaction')
  }

  // Pi's view of the span must be ours: the same number of conversation messages between where the
  // previous compaction stopped and the cut. A difference means the two disagree about what the
  // conversation is, which is the ambiguity worth declining over.
  const expected = preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length
  const actual = entries.slice(represented, Math.max(represented, kept)).filter(yieldsMessage).length
  if (expected !== actual) return unreadable(`Pi prepared ${expected} messages to compact but the branch holds ${actual}`)

  // The span being compacted must be understood in full. What was compacted before, and what Pi
  // retains, is not ours to render, so an entry there we do not recognize is only kept as a marker.
  const items: Item[] = []
  const entryOfItem: number[] = []
  for (const [index, entry] of entries.entries()) {
    let produced: Item[]
    try {
      produced = normalizeEntry(entry)
    } catch (error) {
      if (!(error instanceof UnrecognizedShape)) throw error
      if (index >= represented && index < kept) return unreadable(`entry ${index} (${entry.type}): ${error.message}`)
      produced = [{ id: itemId(entry.id, 0), kind: 'opaque', note: `unrecognized ${entry.type} entry` }]
    }
    for (const item of produced) {
      items.push(item)
      entryOfItem.push(index)
    }
  }

  const boundaryAt = entryOfItem.findIndex((index) => index >= kept)
  if (boundaryAt === -1) return unreadable('nothing at or after the cut is model-visible')

  const evictedThroughAt = previous >= 0 ? entryOfItem.findLastIndex((index) => index < represented) : -1
  const fileOps = fileOpsOf(preparation.fileOps)
  const previousDetail = latestEngineDetail(entries)
  return {
    items,
    boundary: { id: items[boundaryAt]!.id },
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    ...(evictedThroughAt === -1 ? {} : { evictedThrough: items[evictedThroughAt]!.id }),
    ...(fileOps === undefined ? {} : { fileOps }),
    ...(previousDetail === undefined ? {} : { previousDetail }),
    ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
    reason: event.reason,
  }
}

/** Distinguishes a decline from a snapshot. */
export const isDecline = (result: ConversationSnapshot | SnapshotDecline): result is SnapshotDecline => !('items' in result)
