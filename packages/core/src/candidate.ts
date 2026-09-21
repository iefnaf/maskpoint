import { estimateTokens } from './estimate.js'
import { HISTORY_FRAMING, roleLabel } from './framing.js'
import type { Item } from './vocabulary.js'

/** The bulk text an item carries: what masking replaces and what the candidate's size measures. */
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
 * The candidate as text: the exact text whose estimated size the budget is compared against —
 * previous state first, then the newly evicted masked history, each entry under its role label and
 * the history framing ahead of them. Adapters render artifacts their own way, but the budget
 * measures this, labels and framing included, so a rendering that adds only its own separators
 * cannot outgrow what was measured by more than a few tokens per entry.
 */
export function candidateText(previous: string | undefined, evicted: readonly Item[]): string {
  const parts: string[] = []
  if (previous !== undefined && previous !== '') parts.push(previous)
  if (evicted.length > 0) {
    parts.push(HISTORY_FRAMING)
    for (const item of evicted) parts.push(`${roleLabel(item)}\n${payloadOf(item)}`)
  }
  return parts.join('\n\n')
}

/** Estimated tokens of the candidate, by the one estimator masking and the budget share. */
export function candidateTokens(previous: string | undefined, evicted: readonly Item[]): number {
  return estimateTokens(candidateText(previous, evicted))
}
