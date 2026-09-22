import type { Item } from '@maskpoint/core'

export type Rec = Record<string, unknown>

export const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)

const IMAGE_NOTE = '[image omitted]'

/**
 * Text and image count from a content value: a plain string, or an array of content blocks. A
 * block type this adapter does not know is skipped rather than failing the whole entry — the
 * assisted tier never depends on parsing every block correctly, only on producing a useful artifact.
 */
function readContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const parts: string[] = []
  let images = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') images++
  }
  return { text: parts.join('\n'), images }
}

/** Text a person wrote, with a note in place of any image, since a rendered artifact cannot carry one. */
function textWithImageNotes(content: unknown): string {
  const { text, images } = readContent(content)
  return [text, ...Array.from({ length: images }, () => IMAGE_NOTE)].filter((part) => part !== '').join('\n')
}

/** Items for one assistant message's content blocks: text, reasoning, and tool calls. */
function fromAssistant(content: unknown, at: (n: number) => string, callNames: Map<string, string>): Item[] {
  if (!Array.isArray(content)) return []
  const items: Item[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const id = at(items.length)
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') items.push({ id, kind: 'assistant-text', text: block.text })
        break
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking !== '') {
          items.push({ id, kind: 'assistant-reasoning', text: block.thinking })
        }
        break
      case 'tool_use':
        if (typeof block.name === 'string') {
          if (typeof block.id === 'string') callNames.set(block.id, block.name)
          items.push({
            id,
            kind: 'tool-call',
            name: block.name,
            ...(typeof block.id === 'string' ? { callId: block.id } : {}),
            args: JSON.stringify(block.input ?? {}),
          })
        }
        break
      // 'redacted_thinking' and anything else carry no readable text; skipped rather than guessed at.
    }
  }
  return items
}

/** Items for a user entry: recorded text, tool results, or a real multi-modal turn with attachments. */
function fromUser(entry: Rec, at: (n: number) => string, callNames: ReadonlyMap<string, string>): Item[] {
  if (!isRecord(entry.message)) return []
  const content = entry.message.content
  if (typeof content === 'string') {
    if (content === '') return []
    if (entry.isCompactSummary === true) return [{ id: at(0), kind: 'checkpoint', text: content }]
    if (entry.isMeta === true) return [{ id: at(0), kind: 'host-context', label: 'meta', text: content }]
    return [{ id: at(0), kind: 'user', text: content }]
  }
  if (!Array.isArray(content)) return []

  // A real user turn (typed text plus any pasted images) has no `tool_result` block; a turn that
  // carries the host's tool results is made entirely of them. The two shapes are never mixed.
  if (!content.some((block) => isRecord(block) && block.type === 'tool_result')) {
    const text = textWithImageNotes(content)
    return text === '' ? [] : [{ id: at(0), kind: 'user', text }]
  }

  const items: Item[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    const { text, images } = readContent(block.content)
    items.push({
      id: at(items.length),
      kind: 'tool-result',
      ...(callId !== undefined && callNames.has(callId) ? { name: callNames.get(callId)! } : {}),
      ...(callId !== undefined ? { callId } : {}),
      status: block.is_error === true ? 'error' : 'ok',
      text,
      media: images,
    })
  }
  return items
}

/**
 * The id of an entry's `n`th item: `<entry uuid>#<n>`. One transcript line can hold several items
 * (an assistant turn is its reasoning, its text and each of its tool calls), so ids stay unique
 * within a snapshot while each still names a position in the transcript's own line order.
 */
export const itemId = (uuid: string, n: number): string => `${uuid}#${n}`

/**
 * Normalize a full pre-compaction transcript into engine items, in order.
 *
 * Unrecognized or bookkeeping line types (`system`, `attachment`, file and session bookkeeping) are
 * skipped rather than causing a decline: a change in Claude Code's transcript shape should degrade
 * the artifact's completeness, not stop it from being produced, because nothing downstream depends
 * on this adapter for correctness. A sidechain entry (a subagent turn inlined on the main branch)
 * is skipped too; it is not part of what the host itself will compact.
 */
export function normalizeTranscript(entries: readonly Rec[]): Item[] {
  const items: Item[] = []
  const callNames = new Map<string, string>()
  for (const entry of entries) {
    if (entry.isSidechain === true) continue
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
    if (uuid === undefined) continue
    const at = (n: number) => itemId(uuid, n)
    switch (entry.type) {
      case 'user':
        items.push(...fromUser(entry, at, callNames))
        break
      case 'assistant':
        if (isRecord(entry.message)) items.push(...fromAssistant(entry.message.content, at, callNames))
        break
      default:
      // system, attachment, and other bookkeeping line types carry no conversation content.
    }
  }
  return items
}
