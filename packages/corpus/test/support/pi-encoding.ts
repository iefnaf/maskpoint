import type { ConversationSnapshot, Item } from '@maskpoint/core'
import type { PiBeforeCompactEvent } from '@maskpoint/pi'
import { boundaryIndex, representedThroughIndex } from '../../src/items.js'

type Entry = Record<string, unknown>

/**
 * Whether Pi's own `yieldsMessage` (packages/pi/src/normalize.ts) would count the entry this item
 * becomes as one of the messages Pi prepared to summarize. Kept in sync by hand: an item kind this
 * encoder gives a `message`/`custom_message` entry counts; an `opaque` item, encoded as an entry
 * type Pi does not recognize at all, does not.
 */
function countsTowardPiMessages(kind: Item['kind']): boolean {
  return kind !== 'opaque' && kind !== 'checkpoint'
}

function assistantBlock(item: Item): Record<string, unknown> {
  switch (item.kind) {
    case 'assistant-text':
      return { type: 'text', text: item.text }
    case 'assistant-reasoning':
      return { type: 'thinking', thinking: item.text }
    case 'tool-call':
      return { type: 'toolCall', id: item.callId ?? item.id, name: item.name, arguments: JSON.parse(item.args || '{}') }
    default:
      throw new Error(`pi-encoding: item kind "${item.kind}" is not an assistant block`)
  }
}

/**
 * One neutral item as a Pi session entry. `checkpoint` items are never passed here: the previous
 * compaction they represent is threaded through a `compaction` entry instead (see `buildPiEvent`).
 */
function entryFor(item: Item, id: string): Entry {
  const base = { id, parentId: null, timestamp: new Date(0).toISOString() }
  switch (item.kind) {
    case 'user':
      return { ...base, type: 'message', message: { role: 'user', content: item.text, timestamp: 1 } }
    case 'assistant-text':
    case 'assistant-reasoning':
    case 'tool-call':
      return { ...base, type: 'message', message: { role: 'assistant', content: [assistantBlock(item)], stopReason: 'stop', timestamp: 1 } }
    case 'tool-result': {
      const content: Record<string, unknown>[] = []
      if ((item.text ?? '') !== '') content.push({ type: 'text', text: item.text })
      for (let i = 0; i < item.media; i++) content.push({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
      return {
        ...base,
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: item.callId ?? item.id,
          toolName: item.name,
          content,
          isError: item.status === 'error',
          timestamp: 1,
        },
      }
    }
    case 'host-context':
      return { ...base, type: 'custom_message', customType: item.label, content: item.text }
    case 'opaque':
      // No Pi entry type maps to this: encoded as one Pi does not recognize at all, so it
      // contributes nothing (packages/pi/src/normalize.ts, `normalizeEntry`'s default case).
      // Every corpus fixture's opaque item sits in history a repeated compaction already
      // represents, which Pi never renders either way, so the loss of fidelity here is moot.
      return { ...base, type: 'maskpoint-fixture:unrecognized', note: item.note }
    case 'checkpoint':
      throw new Error('pi-encoding: checkpoint items are carried by a `compaction` entry, not encoded inline')
  }
}

/**
 * Encode a neutral `ConversationSnapshot` as the `session_before_compact` event Pi would fire over
 * the equivalent session: same items, same retained boundary, same previous-compaction state.
 * Not a real recording — a synthetic one, since CI has no Pi binary (docs/design.md, Testing
 * design) — but built from the same corpus fixture the DSH encoding uses, so a divergence between
 * the two adapters' outputs cannot be explained by different source material.
 */
export function buildPiEvent(snapshot: ConversationSnapshot): PiBeforeCompactEvent {
  const { items } = snapshot

  const represented = representedThroughIndex(snapshot)
  if (snapshot.evictedThrough !== undefined && represented === -1) {
    throw new Error('pi-encoding: evictedThrough names no item')
  }
  const boundary = boundaryIndex(snapshot)
  if (boundary === -1) throw new Error('pi-encoding: boundary names no item')

  const entryIdOf = new Map<string, string>()
  let n = 0
  for (const item of items) {
    if (item.kind !== 'checkpoint') entryIdOf.set(item.id, `entry-${n++}`)
  }

  const entries: Entry[] = []
  items.forEach((item, index) => {
    if (item.kind !== 'checkpoint') entries.push(entryFor(item, entryIdOf.get(item.id)!))
    if (index === represented) {
      const nextItem = items[index + 1]
      if (nextItem === undefined) throw new Error('pi-encoding: nothing follows the previous checkpoint')
      entries.push({
        id: `compaction-${index}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        type: 'compaction',
        summary: snapshot.previousCheckpoint,
        firstKeptEntryId: entryIdOf.get(nextItem.id)!,
        tokensBefore: 0,
      })
    }
  })

  const qualifying = items.filter(
    (item, index) => index > represented && index < boundary && countsTowardPiMessages(item.kind),
  ).length

  return {
    preparation: {
      firstKeptEntryId: entryIdOf.get(items[boundary]!.id)!,
      messagesToSummarize: new Array(qualifying).fill({}),
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 0,
      ...(snapshot.previousCheckpoint === undefined ? {} : { previousSummary: snapshot.previousCheckpoint }),
    },
    branchEntries: entries,
    ...(snapshot.customInstructions === undefined ? {} : { customInstructions: snapshot.customInstructions }),
    reason: snapshot.reason,
    willRetry: snapshot.reason === 'overflow',
    signal: new AbortController().signal,
  }
}
