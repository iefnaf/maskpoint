import type { Item } from '@maskpoint/core'

export type Rec = Record<string, unknown>

export const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A session entry this adapter cannot represent faithfully. The caller declines rather than guess. */
export class UnrecognizedShape extends Error {
  override readonly name = 'UnrecognizedShape'
}

const unrecognized = (what: string): never => {
  throw new UnrecognizedShape(what)
}

/**
 * Whether Pi turns this entry into a message for compaction: the entries `messagesToSummarize`
 * counts. Comparing that count with what this adapter normalized is how a change in Pi's idea of
 * "conversation" shows up as a decline instead of as history silently missing from the summary.
 */
export function yieldsMessage(entry: Rec): boolean {
  switch (entry.type) {
    case 'message':
      return !isRecord(entry.message) || entry.message.role !== 'system'
    case 'custom_message':
      return true
    case 'branch_summary':
      return typeof entry.summary === 'string' && entry.summary !== ''
    default:
      return false
  }
}

const IMAGE_NOTE = '[image omitted]'

/** The text of a message's content, and how many images travelled with it. */
function readContent(content: unknown): { text: string; images: number } {
  if (content === undefined || content === null) return { text: '', images: 0 }
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return unrecognized('message content is neither text nor a list of blocks')
  const parts: string[] = []
  let images = 0
  for (const block of content) {
    if (!isRecord(block)) return unrecognized('a content block is not an object')
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') images++
    else return unrecognized(`unknown content block "${String(block.type)}"`)
  }
  return { text: parts.join('\n'), images }
}

/** Text a person wrote, with a note in place of any image, since a summary string cannot carry one. */
function textWithImageNotes(content: unknown): string {
  const { text, images } = readContent(content)
  return [text, ...Array.from({ length: images }, () => IMAGE_NOTE)].filter((part) => part !== '').join('\n')
}

function fromAssistant(message: Rec, at: (n: number) => string): Item[] {
  if (message.content === undefined || message.content === null) return []
  if (!Array.isArray(message.content)) return unrecognized('assistant content is not a list of blocks')
  const items: Item[] = []
  for (const block of message.content) {
    if (!isRecord(block)) return unrecognized('an assistant content block is not an object')
    const id = at(items.length)
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') return unrecognized('a text block has no text')
        if (block.text !== '') items.push({ id, kind: 'assistant-text', text: block.text })
        break
      case 'thinking':
        if (typeof block.thinking !== 'string') return unrecognized('a thinking block has no text')
        // Redacted reasoning is an opaque payload for the provider, not something a reader could use.
        if (block.redacted !== true && block.thinking !== '') items.push({ id, kind: 'assistant-reasoning', text: block.thinking })
        break
      case 'toolCall':
        if (typeof block.name !== 'string') return unrecognized('a tool call has no name')
        items.push({
          id,
          kind: 'tool-call',
          name: block.name,
          ...(typeof block.id === 'string' ? { callId: block.id } : {}),
          args: JSON.stringify(block.arguments ?? {}),
        })
        break
      default:
        return unrecognized(`unknown assistant block "${String(block.type)}"`)
    }
  }
  return items
}

function fromToolResult(message: Rec, at: (n: number) => string): Item[] {
  const { text, images } = readContent(message.content)
  return [
    {
      id: at(0),
      kind: 'tool-result',
      ...(typeof message.toolName === 'string' ? { name: message.toolName } : {}),
      ...(typeof message.toolCallId === 'string' ? { callId: message.toolCallId } : {}),
      status: message.isError === true ? 'error' : 'ok',
      text,
      media: images,
    },
  ]
}

/** A command the user ran themselves: the command stays readable as a call, only its output is an observation. */
function fromBashExecution(message: Rec, at: (n: number) => string): Item[] {
  // A `!!` command is kept in the session for the user but never shown to the model.
  if (message.excludeFromContext === true) return []
  if (typeof message.command !== 'string') return unrecognized('a shell execution has no command')
  const exitCode = typeof message.exitCode === 'number' ? message.exitCode : undefined
  const failed = message.cancelled === true || (exitCode !== undefined && exitCode !== 0)
  return [
    { id: at(0), kind: 'tool-call', name: 'bash', args: JSON.stringify({ command: message.command }) },
    {
      id: at(1),
      kind: 'tool-result',
      name: 'bash',
      status: failed ? 'error' : 'ok',
      ...(exitCode === undefined ? {} : { exitCode }),
      text: typeof message.output === 'string' ? message.output : '',
      media: 0,
    },
  ]
}

function fromMessage(entry: Rec, at: (n: number) => string): Item[] {
  const message = entry.message
  if (!isRecord(message)) return unrecognized('a message entry holds no message')
  switch (message.role) {
    case 'system':
      // Prompt state, not conversation: Pi keeps it out of the span it compacts too.
      return []
    case 'user':
      return [{ id: at(0), kind: 'user', text: textWithImageNotes(message.content) }]
    case 'assistant':
      return fromAssistant(message, at)
    case 'toolResult':
      return fromToolResult(message, at)
    case 'bashExecution':
      return fromBashExecution(message, at)
    default:
      return unrecognized(`unknown message role "${String(message.role)}"`)
  }
}

/**
 * The id of an entry's `n`th item: `<entry id>#<n>`. An entry can hold several items (an assistant
 * turn is its reasoning, its text and each of its tool calls), so ids stay unique within a snapshot
 * while each still names a position in the host's own entry order.
 */
export const itemId = (entryId: string, n: number): string => `${entryId}#${n}`

/**
 * The engine items for one session entry.
 *
 * Entries that carry no conversation, or whose type this adapter does not know, yield nothing.
 * An unknown type that Pi does turn into a message is caught by the message count check.
 * Throws `UnrecognizedShape` for a conversation entry this adapter cannot represent.
 */
export function normalizeEntry(entry: Rec & { id: string }): Item[] {
  const at = (n: number) => itemId(entry.id, n)
  switch (entry.type) {
    case 'message':
      return fromMessage(entry, at)
    case 'custom_message':
      if (typeof entry.customType !== 'string') return unrecognized('a custom message has no type')
      return [{ id: at(0), kind: 'host-context', label: entry.customType, text: textWithImageNotes(entry.content) }]
    case 'branch_summary':
      if (typeof entry.summary !== 'string') return unrecognized('a branch summary has no text')
      return entry.summary === '' ? [] : [{ id: at(0), kind: 'host-context', label: 'branch summary', text: entry.summary }]
    default:
      return []
  }
}
