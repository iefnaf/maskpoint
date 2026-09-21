import { HISTORY_FRAMING, payloadOf, roleLabel } from '@maskpoint/core'
import type { Artifact, Renderer } from '@maskpoint/core'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * The artifact as one text, laid out exactly as the engine's budget measures the candidate: the
 * carried state first, then the framing and each item under its role label. Keeping the layout the
 * same is what makes "within budget" mean what the model will actually be shown.
 */
export function renderText(artifact: Artifact): string {
  const parts: string[] = []
  for (const section of artifact.sections) {
    if (section.kind === 'checkpoint') parts.push(section.text)
    else {
      parts.push(HISTORY_FRAMING)
      for (const item of section.items) parts.push(`${roleLabel(item)}\n${payloadOf(item)}`)
    }
  }
  return parts.join('\n\n')
}

/** DSH content blocks: text only, since the host's summary path takes safe text. */
export const contentBlocks: Renderer<ContentBlock[]> = {
  render: (artifact) => [{ type: 'text', text: renderText(artifact) }],
}
