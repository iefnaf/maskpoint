import { type ConversationSnapshot, payloadOf } from '@maskpoint/core'

/** The bulk text an item carries, as the engine measures it. */
export const payload = payloadOf

/** Index of the first item the host retains, or -1 if the boundary names no item. */
export function boundaryIndex(snapshot: ConversationSnapshot): number {
  return snapshot.items.findIndex((item) => item.id === snapshot.boundary.id)
}
