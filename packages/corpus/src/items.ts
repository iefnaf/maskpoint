import type { ConversationSnapshot, Item } from '@maskpoint/core'

/** The bulk text an item carries: what masking would replace and what size accounting measures. */
export function payload(item: Item): string {
  switch (item.kind) {
    case 'tool-call':
      return item.args
    case 'tool-result':
      return item.text ?? ''
    case 'opaque':
      return item.note
    default:
      return item.text
  }
}

/** Index of the first item the host retains, or -1 if the boundary names no item. */
export function boundaryIndex(snapshot: ConversationSnapshot): number {
  return snapshot.items.findIndex((item) => item.id === snapshot.boundary.id)
}
