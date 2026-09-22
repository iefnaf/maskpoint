import type { ConversationSnapshot, Item } from '@maskpoint/core'
import type { Message } from '@deepseek-ai/dsh-llm'
import { normalizeMessages } from './normalize.js'

/** Marks the end of the compacted region for the engine, which is handed a boundary, not a region. */
const REGION_END: Item = { id: '\u0000maskpoint:region-end', kind: 'opaque', note: 'end of compacted region' }

/**
 * A region of the host's surface, in surface order, as the engine's snapshot: everything in it is
 * compacted, and nothing retained is part of it.
 *
 * State heading the region is what an earlier compaction left (as the host names it, a checkpoint;
 * it may be masked history): the engine continues from it and neither re-masks nor re-frames it.
 */
export function regionSnapshot(messages: readonly Message[]): ConversationSnapshot {
  const items = normalizeMessages(messages)
  const head = items[0]
  const previous = head?.kind === 'checkpoint' && head.text !== '' ? head : undefined
  return {
    items: [...items, REGION_END],
    boundary: { id: REGION_END.id },
    reason: 'manual',
    ...(previous === undefined ? {} : { previousCheckpoint: previous.text, evictedThrough: previous.id }),
  }
}
