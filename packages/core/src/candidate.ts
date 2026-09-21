import { estimateTokens } from './estimate.js'
import { HISTORY_FRAMING, roleLabel } from './framing.js'
import type { Artifact, Item } from './vocabulary.js'

/** The text an item carries, whichever field holds it: the bulk that size accounting measures. */
export function payloadOf(item: Item): string {
  switch (item.kind) {
    case 'tool-call':
      return item.args
    case 'tool-result':
      return item.text ?? ''
    case 'opaque':
      return item.note
    case 'host-context':
    case 'user':
    case 'assistant-text':
    case 'assistant-reasoning':
    case 'checkpoint':
      return item.text
  }
}

/**
 * The candidate as text: previous state first, then the history framing and each newly evicted item
 * under its role label and payload. This is what the budget measures, so the labels and framing an
 * adapter's rendering is expected to add are counted, not just payloads. It is the measure, not a
 * promise about any host's rendering: an adapter that renders differently is measured the same way.
 */
function candidateText(previous: string | undefined, evicted: readonly Item[]): string {
  const parts: string[] = []
  if (previous !== undefined && previous !== '') parts.push(previous)
  if (evicted.length > 0) {
    parts.push(HISTORY_FRAMING)
    for (const item of evicted) parts.push(`${roleLabel(item)}\n${payloadOf(item)}`)
  }
  return parts.join('\n\n')
}

/**
 * The candidate text of a masked-history artifact: exactly what `candidateTokens` measured when the
 * budget was decided, so a checkpoint call is fed the very text the budget compared.
 */
export function artifactCandidateText(artifact: Artifact): string {
  const previous = artifact.sections.find((section) => section.kind === 'checkpoint')
  const evicted = artifact.sections.flatMap((section) => (section.kind === 'masked-history' ? section.items : []))
  return candidateText(previous?.text, evicted)
}

/** Estimated tokens of the candidate, by the one estimator masking and the budget share. */
export function candidateTokens(previous: string | undefined, evicted: readonly Item[]): number {
  return estimateTokens(candidateText(previous, evicted))
}
