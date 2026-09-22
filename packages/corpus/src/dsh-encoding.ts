import type { ConversationSnapshot, Item } from '@maskpoint/core'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import { boundaryIndex, representedThroughIndex } from './items.js'

function assistantBlock(item: Item): Record<string, unknown> {
  switch (item.kind) {
    case 'assistant-text':
      return { type: 'text', text: item.text }
    case 'assistant-reasoning':
      return { type: 'reasoning', text: item.text }
    case 'tool-call':
      // DSH's own normalize keeps `args` as the raw string it was given (packages/dsh/src/normalize.ts),
      // no round trip through an object, unlike Pi's shape.
      return { type: 'tool-call', id: item.callId ?? item.id, name: item.name, arguments: item.args }
    default:
      throw new Error(`dsh-encoding: item kind "${item.kind}" is not an assistant block`)
  }
}

function toolResultMessage(id: string, item: Extract<Item, { kind: 'tool-result' }>): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if ((item.text ?? '') !== '') content.push({ type: 'text', text: item.text })
  for (let i = 0; i < item.media; i++) content.push({ type: 'image' })
  return {
    id,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: item.callId ?? id, content, isError: item.status === 'error' }],
    source: { kind: 'tool', callId: item.callId ?? id },
  }
}

/**
 * One neutral item as a DSH message. `checkpoint` items are never passed here directly: the region
 * a repeated compaction sees begins with the checkpoint message itself (see `buildDshMessages`).
 */
function messageFor(item: Item, id: string): Record<string, unknown> {
  switch (item.kind) {
    case 'user':
      return { id, role: 'user', content: item.text === '' ? [] : [{ type: 'text', text: item.text }], source: { kind: 'user' } }
    case 'assistant-text':
    case 'assistant-reasoning':
    case 'tool-call':
      return { id, role: 'assistant', content: [assistantBlock(item)], source: { kind: 'model', provider: 'test', model: 'test' } }
    case 'tool-result':
      return toolResultMessage(id, item)
    case 'host-context':
      return { id, role: 'user', content: [{ type: 'text', text: item.text }], source: { kind: 'plugin', plugin: item.label } }
    case 'opaque':
      // No `user`/`assistant` role maps to this: DSH's `normalizeMessages` falls back to its own
      // opaque note for any other role (packages/dsh/src/normalize.ts, `default` case), so the
      // exact wording is host-specific and deliberately not compared (see parity.test.ts).
      return { id, role: 'system', content: [], source: { kind: 'user' } }
    case 'checkpoint':
      throw new Error('dsh-encoding: checkpoint items are carried as the region head, not encoded inline')
  }
}

/**
 * Encode a neutral `ConversationSnapshot` as the `messages` DSH's compaction transaction would hand
 * `summarize()` for the equivalent region: the host only ever gives the hook the span being
 * compacted, so unlike Pi's full-branch encoding, this is pre-cut to the previous checkpoint (when
 * there is one) followed by exactly the newly evicted items, boundary excluded.
 */
export function buildDshMessages(snapshot: ConversationSnapshot): { messages: Message[] } {
  const { items } = snapshot

  const represented = representedThroughIndex(snapshot)
  if (snapshot.evictedThrough !== undefined && represented === -1) {
    throw new Error('dsh-encoding: evictedThrough names no item')
  }
  const boundary = boundaryIndex(snapshot)
  if (boundary === -1) throw new Error('dsh-encoding: boundary names no item')

  const messages: Record<string, unknown>[] = []
  if (snapshot.previousCheckpoint !== undefined) {
    messages.push({
      id: 'checkpoint-0',
      role: 'user',
      content: [{ type: 'text', text: snapshot.previousCheckpoint }],
      source: compactCheckpointSource(CompactionId('parity-fixture')),
    })
  }

  let n = 0
  for (let index = represented + 1; index < boundary; index++) {
    const item = items[index]!
    if (item.kind === 'checkpoint') continue // represented by the checkpoint message above, if any
    messages.push(messageFor(item, `msg-${n++}`))
  }

  return { messages: messages as unknown as Message[] }
}
