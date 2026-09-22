import type { ConversationSnapshot, DeclineReason, Item } from '@maskpoint/core'
import { normalizeTranscript, type Rec } from './normalize.js'
import type { PersistedState } from './state.js'

/** Why no snapshot could be built. `note` says what was structurally wrong, never what it contained. */
export interface SnapshotDecline {
  reason: DeclineReason
  note: string
}

const unreadable = (note: string): SnapshotDecline => ({ reason: 'unreadable-snapshot', note })

/**
 * The id every snapshot's boundary names. This adapter never keeps a retained region of its own —
 * the host's real retention is untouched and entirely out of scope for an assisted adapter — so the
 * boundary sits after the last real item, and every item is eligible for masking. That is exactly
 * what an artifact meant to be re-injected as fresh context needs: a self-contained record, not a
 * partial one that assumes a raw suffix survives somewhere the engine can see.
 */
export const END_BOUNDARY_ID = '__maskpoint_end__'

export interface PreCompactInput {
  customInstructions?: string | undefined
  trigger: 'manual' | 'auto'
}

/**
 * Build the engine's snapshot from a parsed transcript, the pre-compaction hook's own input, and
 * whatever this adapter persisted for the session last time. `entries` is undefined when the
 * transcript file could not be read at all, which declines rather than guessing at an empty session.
 */
export function buildSnapshot(
  entries: readonly Rec[] | undefined,
  input: PreCompactInput,
  prior: PersistedState | undefined,
): ConversationSnapshot | SnapshotDecline {
  if (entries === undefined) return unreadable('the transcript could not be read')

  const items: Item[] = normalizeTranscript(entries)
  if (items.some((item) => item.id === END_BOUNDARY_ID)) return unreadable('an item id collided with the boundary sentinel')
  items.push({ id: END_BOUNDARY_ID, kind: 'opaque', note: 'end of pre-compaction transcript' })

  return {
    items,
    boundary: { id: END_BOUNDARY_ID },
    ...(prior === undefined
      ? {}
      : {
          previousCheckpoint: prior.checkpointText,
          ...(prior.detail.cursor === undefined ? {} : { evictedThrough: prior.detail.cursor.evictedThroughId }),
          previousDetail: prior.detail,
        }),
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    // Claude Code's PreCompact payload distinguishes only manual vs. auto; auto covers both proactive
    // threshold compaction and overflow recovery, and the payload cannot tell them apart (see
    // docs/design.md, Claude Code adapter). Neither `decide` nor `maskSpan` reads this field — it
    // travels only for an adapter's own reporting — so the approximation costs nothing.
    reason: input.trigger === 'manual' ? 'manual' : 'threshold',
  }
}

export const isDecline = (result: ConversationSnapshot | SnapshotDecline): result is SnapshotDecline => !('items' in result)
