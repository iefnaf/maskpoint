import type { Item } from '@maskpoint/core'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/**
 * What the host's own tool-result pruner leaves where it removed the middle of a result
 * (`PRUNE_MARKER` in `dsh-compaction-tool-result-pruner`, without its surrounding blank lines).
 * Restated because that package is an optional sibling and may not be installed; a test pins it to
 * the host's constant so a change upstream is a red test.
 */
export const HOST_PRUNE_MARKER = '[... tool result middle pruned ...]'

/** Tags the host's summary framing wraps around a checkpoint's body (`frameSummary`). */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

const IMAGE_OMITTED = '[image attachment omitted]'

function textOf(blocks: readonly ContentBlock[]): { text: string; media: number } {
  const parts: string[] = []
  let media = 0
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') media++
    else if (block.type === 'tool-result') {
      const nested = textOf(block.content)
      parts.push(nested.text)
      media += nested.media
    }
  }
  return { text: parts.join('\n'), media }
}

/** The body of a persisted checkpoint: what sits between the host's framing tags, else all its text. */
function checkpointBody(message: Message): string {
  const blocks = message.content
  const first = blocks[0]
  const last = blocks.at(-1)
  const framed =
    blocks.length >= 2 &&
    first?.type === 'text' &&
    first.text.endsWith(SUMMARY_OPEN_TAG) &&
    last?.type === 'text' &&
    last.text === SUMMARY_CLOSE_TAG
  return textOf(framed ? blocks.slice(1, -1) : blocks).text
}

/** Tool names by call id, from every assistant tool call in `messages`. */
export function toolNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool-call') names.set(block.id, block.name)
  }
  return names
}

/**
 * The host's conversation as the engine's neutral items. One host message can be several items (an
 * assistant turn is text, reasoning, and calls), so ids are the message id, suffixed by position
 * where a message splits. Nothing is dropped except empty text: every user, assistant, and tool
 * item the host recorded is here for the engine to keep or mask.
 */
export function normalizeMessages(messages: readonly Message[], names = toolNames(messages)): Item[] {
  const items: Item[] = []
  for (const message of messages) {
    const id = String(message.id)
    switch (message.role) {
      case 'user': {
        const { source } = message
        if (source.kind === 'tool') {
          const block = message.content[0]
          if (block?.type !== 'tool-result') {
            items.push({ id, kind: 'opaque', note: 'tool message without a tool result' })
            break
          }
          const { text, media } = textOf(block.content)
          items.push({
            id,
            kind: 'tool-result',
            callId: String(block.toolCallId),
            status: block.isError === true ? 'error' : 'ok',
            text,
            media,
            ...(names.has(block.toolCallId) ? { name: names.get(block.toolCallId)! } : {}),
            ...(text.includes(HOST_PRUNE_MARKER) ? { masked: true } : {}),
          })
        } else if (source.kind === 'plugin' && isCompactCheckpointSource(source)) {
          items.push({ id, kind: 'checkpoint', text: checkpointBody(message) })
        } else if (source.kind === 'plugin') {
          items.push({ id, kind: 'host-context', label: source.plugin, text: textOf(message.content).text })
        } else {
          const { text, media } = textOf(message.content)
          const images = Array.from({ length: media }, () => IMAGE_OMITTED)
          items.push({ id, kind: 'user', text: [text, ...images].filter((part) => part !== '').join('\n') })
        }
        break
      }
      case 'assistant':
        message.content.forEach((block, index) => {
          const blockId = `${id}#${index}`
          if (block.type === 'text' && block.text !== '') items.push({ id: blockId, kind: 'assistant-text', text: block.text })
          else if (block.type === 'reasoning' && block.text !== '') items.push({ id: blockId, kind: 'assistant-reasoning', text: block.text })
          else if (block.type === 'tool-call') items.push({ id: blockId, kind: 'tool-call', name: block.name, callId: String(block.id), args: block.arguments })
        })
        break
      default:
        items.push({ id, kind: 'opaque', note: `${message.role} message` })
    }
  }
  return items
}
