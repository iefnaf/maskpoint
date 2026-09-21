import { type Artifact, HISTORY_FRAMING, payloadOf, type Renderer, roleLabel } from '@maskpoint/core'

/**
 * Pi's summary text. Sections keep their order: the state carried from the previous compaction
 * comes first, verbatim, and the newly evicted history follows under the history framing, each
 * item under its role label.
 *
 * It renders exactly the text the engine measured for the budget, so `candidateTokens` in the
 * persisted detail is the size of what Pi was given.
 */
export const summaryRenderer: Renderer<string> = {
  render(artifact: Artifact): string {
    const parts: string[] = []
    for (const section of artifact.sections) {
      if (section.kind === 'checkpoint') {
        parts.push(section.text)
        continue
      }
      parts.push(HISTORY_FRAMING)
      for (const item of section.items) parts.push(`${roleLabel(item)}\n${payloadOf(item)}`)
    }
    return parts.join('\n\n')
  },
}
