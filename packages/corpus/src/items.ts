import { type ConversationSnapshot, payloadOf } from '@maskpoint/core'

/** The bulk text an item carries, as the engine measures it. */
export const payload = payloadOf

/** Index of the first item the host retains, or -1 if the boundary names no item. */
export function boundaryIndex(snapshot: ConversationSnapshot): number {
  return snapshot.items.findIndex((item) => item.id === snapshot.boundary.id)
}

/** Index of the last item `previousCheckpoint` already represents, or -1 with no previous state. */
export function representedThroughIndex(snapshot: ConversationSnapshot): number {
  return snapshot.evictedThrough === undefined ? -1 : snapshot.items.findIndex((item) => item.id === snapshot.evictedThrough)
}
