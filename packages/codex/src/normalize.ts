import type { Item } from '@maskpoint/core'

export type Rec = Record<string, unknown>

export const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)

const IMAGE_NOTE = '[image omitted]'

/**
 * Text and image count from a Codex content-block array (Responses-API-shaped: `input_text` /
 * `output_text` / `text`, and `input_image` / `image`). A block type this adapter does not know is
 * skipped rather than failing the whole item — the assisted tier never depends on parsing every
 * block correctly, only on producing a useful artifact.
 */
function readContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const parts: string[] = []
  let images = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    const type = typeof block.type === 'string' ? block.type : ''
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof block.text === 'string') parts.push(block.text)
    else if (type === 'input_image' || type === 'image') images++
  }
  return { text: parts.join('\n'), images }
}

/** Text a person wrote, with a note in place of any image, since a rendered artifact cannot carry one. */
function textWithImageNotes(content: unknown): string {
  const { text, images } = readContent(content)
  return [text, ...Array.from({ length: images }, () => IMAGE_NOTE)].filter((part) => part !== '').join('\n')
}

/** Joined text of a reasoning item's summary blocks. `encrypted_content`, when present, carries no readable text. */
function readReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  const parts: string[] = []
  for (const block of summary) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** The text of a `function_call_output`/`custom_tool_call_output` item's `output` field, whichever shape it has. */
function readOutput(output: unknown): { text: string; success: boolean | undefined } {
  if (typeof output === 'string') return { text: output, success: undefined }
  if (isRecord(output)) {
    const success = typeof output.success === 'boolean' ? output.success : undefined
    return { text: readContent(output.content ?? output.output).text, success }
  }
  return { text: '', success: undefined }
}

/**
 * One rollout entry's items, in order. A `response_item` line's `payload` carries the Responses-API
 * item; item ids are `<entry ordinal>#<n>` so a payload with several parts (a message with several
 * content blocks never happens in practice, but the shape allows it) stays unique. Unrecognized
 * payload types are skipped, not failed: a Codex protocol change should degrade the artifact's
 * completeness, not stop it from being produced (mirrors the Claude Code adapter's `normalize.ts`).
 */
function fromResponseItem(payload: Rec, at: (n: number) => string, callNames: Map<string, string>): Item[] {
  const id = at(0)
  switch (payload.type) {
    case 'message': {
      const role = payload.role
      const { text, images } = readContent(payload.content)
      if (role === 'user') {
        const withImages = textWithImageNotes(payload.content)
        return withImages === '' ? [] : [{ id, kind: 'user', text: withImages }]
      }
      if (role === 'assistant') return text === '' ? [] : [{ id, kind: 'assistant-text', text }]
      if (role === 'system') return text === '' ? [] : [{ id, kind: 'host-context', label: 'system', text }]
      // An unrecognized role carries no known meaning; noted only if it has an image, otherwise skipped.
      return images > 0 && text === '' ? [{ id, kind: 'host-context', label: String(role ?? 'unknown'), text: IMAGE_NOTE }] : []
    }
    case 'reasoning': {
      const text = readReasoningSummary(payload.summary)
      return text === '' ? [] : [{ id, kind: 'assistant-reasoning', text }]
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = typeof payload.name === 'string' ? payload.name : undefined
      if (name === undefined) return []
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      if (callId !== undefined) callNames.set(callId, name)
      const args = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : ''
      return [{ id, kind: 'tool-call', name, ...(callId !== undefined ? { callId } : {}), args }]
    }
    case 'local_shell_call': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : undefined
      const action = isRecord(payload.action) ? payload.action : undefined
      const command = Array.isArray(action?.command) ? action.command.filter((part): part is string => typeof part === 'string').join(' ') : ''
      if (callId !== undefined) callNames.set(callId, 'local_shell')
      return [{ id, kind: 'tool-call', name: 'local_shell', ...(callId !== undefined ? { callId } : {}), args: command }]
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      const { text, success } = readOutput(payload.output)
      return [
        {
          id,
          kind: 'tool-result',
          ...(callId !== undefined && callNames.has(callId) ? { name: callNames.get(callId)! } : {}),
          ...(callId !== undefined ? { callId } : {}),
          status: success === false ? 'error' : 'ok',
          text,
          media: 0,
        },
      ]
    }
    default:
      // 'web_search_call' and anything else carry no content this adapter renders; skipped, not guessed at.
      return []
  }
}

/**
 * The id of a rollout entry's `n`th item: `<ordinal>#<n>`. Codex rollout lines are already ordered
 * and numbered (`ordinal`), which this adapter reuses as the position component of the id so ids
 * stay unique and monotonic within a snapshot without depending on any payload-internal identifier.
 */
export const itemId = (ordinal: number, n: number): string => `${ordinal}#${n}`

/**
 * Normalize a full pre-compaction rollout into engine items, in order. Only `response_item` lines
 * carry conversation content; `session_meta`, `turn_context`, `event_msg`, `token_usage_record` and
 * `world_state` are bookkeeping and telemetry, skipped the same way Claude Code's normalizer skips
 * `system`/`attachment` lines — nothing downstream depends on this adapter for correctness.
 */
export function normalizeTranscript(entries: readonly Rec[]): Item[] {
  const items: Item[] = []
  const callNames = new Map<string, string>()
  entries.forEach((entry, ordinal) => {
    if (entry.type !== 'response_item') return
    if (!isRecord(entry.payload)) return
    const at = (n: number) => itemId(ordinal, n)
    items.push(...fromResponseItem(entry.payload, at, callNames))
  })
  return items
}
