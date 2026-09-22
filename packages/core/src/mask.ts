import { estimateTokens } from './estimate.js'
import type { Item, Stats, ToolResultItem } from './vocabulary.js'

/** What masking measures. `candidateTokens` belongs to accumulation, which owns the candidate. */
export type MaskStats = Pick<Stats, 'observationsMasked' | 'charsOmitted'> & { reasoningsMasked?: number }

/**
 * How masking is applied. The default follows the no-expansion rule.
 */
export interface MaskOptions {
  /**
   * Mask every observation body, even one whose placeholder would not be smaller. For an adapter
   * that persists the result outside the host's own store, where the rule's saving is not worth a
   * second copy of a body: a short credential in a one-line result is exactly what it would keep.
   * Empty bodies and existing placeholders are still left alone.
   */
  alwaysMask?: boolean
  /**
   * Mask assistant reasoning as well as observations. Off by default: the design promises
   * reasoning verbatim, and the one measurement of the trade-off (`docs/reasoning-masking-evaluation.md`)
   * found no cost to continuation but left the checkpoint path untested. Still subject to the
   * no-expansion rule, so a short block of reasoning stays.
   */
  maskReasoning?: boolean
}

/** The snapshot cannot be masked as given. Adapters turn this into a decline, so the host compacts. */
export class MaskingError extends Error {
  override readonly name = 'MaskingError'
}

/**
 * A body that is nothing but one of our placeholders. Matched in full, not by prefix: an observation
 * that merely begins this way is still an observation and must still be masked.
 */
const PLACEHOLDER = /^\[tool result omitted: [^\]\n]*\]$/

/** The same, for the line a masked reasoning block leaves behind. */
const REASONING_PLACEHOLDER = /^\[reasoning omitted: [^\]\n]*\]$/

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Characters as a reader counts them (code points), not UTF-16 units. */
function countChars(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

function countLines(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * The placeholder for an observation: what it was and how much was dropped — never any of the body.
 * `omitted` is the text being dropped, `media` the number of payloads being dropped.
 */
function placeholderFor(item: ToolResultItem, omitted: string | undefined, media: number): string {
  const fields: string[] = []
  // The name comes from the host; keep it from closing the bracket or starting a new line.
  if (item.name !== undefined && item.name !== '') fields.push(item.name.replace(/[[\]\r\n]/g, '_'))
  fields.push(item.status)
  if (item.exitCode !== undefined) fields.push(`exit ${item.exitCode}`)
  if (omitted !== undefined) fields.push(plural(countLines(omitted), 'line'), plural(countChars(omitted), 'char'))
  if (media > 0) fields.push(plural(media, 'image'))
  return `[tool result omitted: ${fields.join(', ')}]`
}

const replaced = (item: ToolResultItem, text: string): ToolResultItem => ({ ...item, text, media: 0, masked: true })

/** The line a masked reasoning block leaves behind: how much of it there was, never any of what it said. */
function reasoningPlaceholder(text: string): string {
  return `[reasoning omitted: ${plural(countLines(text), 'line')}, ${plural(countChars(text), 'char')}]`
}

/**
 * The masked reasoning block and how many characters it dropped, or undefined to leave it alone.
 * Same two rules as an observation: never expand, and never re-wrap what masking already produced.
 */
function maskReasoning(item: Item, options: MaskOptions): { item: Item; charsOmitted: number } | undefined {
  if (options.maskReasoning !== true || item.kind !== 'assistant-reasoning') return undefined
  const body = item.text ?? ''
  if (body === '' || REASONING_PLACEHOLDER.test(body)) return undefined
  const placeholder = reasoningPlaceholder(body)
  if (estimateTokens(placeholder) >= estimateTokens(body)) return undefined
  return { item: { ...item, text: placeholder }, charsOmitted: countChars(body) }
}

/** The masked observation and how many characters of text it dropped, or undefined to leave it alone. */
function maskObservation(item: ToolResultItem, options: MaskOptions): { item: ToolResultItem; charsOmitted: number } | undefined {
  // Idempotence: a placeholder is already what masking makes. A host pruner's placeholder is
  // recognized by the `masked` flag its adapter sets when normalizing (see the Item vocabulary);
  // ours is also recognized by its exact text, in case that flag was lost on the way through.
  if (item.masked === true) return undefined
  const body = item.text ?? ''
  if (PLACEHOLDER.test(body)) return undefined

  // No-expansion: a text placeholder must be strictly smaller than what it replaces, by the same
  // estimator the budget uses. Otherwise the text stays as it was, unless the caller asked for
  // every body to go.
  const bodyPlaceholder = body === '' ? undefined : placeholderFor(item, body, item.media)
  if (bodyPlaceholder !== undefined && (options.alwaysMask === true || estimateTokens(bodyPlaceholder) < estimateTokens(body))) {
    return { item: replaced(item, bodyPlaceholder), charsOmitted: countChars(body) }
  }
  if (item.media === 0) return undefined

  // An image payload is dropped whatever its text costs: the estimator only sees text, and images
  // are the worst context-per-information item in a session. Text that travelled with it is
  // metadata, kept when it is small and masked like any other body when it is not.
  const imageNote = placeholderFor(item, undefined, item.media)
  return { item: replaced(item, body === '' ? imageNote : `${imageNote} ${body}`), charsOmitted: 0 }
}

/**
 * Mask every observation in `items`, leaving everything else intact — except assistant reasoning,
 * which is masked too when the caller asked for it. Pure: returns new items and never mutates its
 * input. Callers decide which span to pass; see `maskSpan` for the boundary rule.
 */
export function maskItems(items: readonly Item[], options: MaskOptions = {}): { items: Item[]; stats: MaskStats } {
  const stats: MaskStats = { observationsMasked: 0, charsOmitted: 0 }
  const out = items.map((item): Item => {
    if (item.kind !== 'tool-result' && item.kind !== 'assistant-reasoning') return item
    const masked = item.kind === 'tool-result' ? maskObservation(item, options) : maskReasoning(item, options)
    if (masked === undefined) return item
    if (item.kind === 'tool-result') stats.observationsMasked++
    else stats.reasoningsMasked = (stats.reasoningsMasked ?? 0) + 1
    stats.charsOmitted += masked.charsOmitted
    return masked.item
  })
  return { items: out, stats }
}

/**
 * Index of the retained boundary: the first item the host keeps, so the compacted span is
 * `items.slice(0, index)`. Throws `MaskingError` when the ids or the boundary cannot be trusted.
 */
export function locateBoundary(items: readonly Item[], boundary: { id: string }): number {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new MaskingError(`duplicate item id "${item.id}"`)
    seen.add(item.id)
  }
  const cut = items.findIndex((item) => item.id === boundary.id)
  if (cut === -1) throw new MaskingError(`retained boundary names no item: "${boundary.id}"`)
  return cut
}

/**
 * Mask the span the host is compacting: every item before the retained boundary. The host's
 * retained region is the only full-fidelity window, so nothing at or after the boundary is
 * touched — and none of it appears in the result, so it can never be duplicated into the compacted
 * side. Throws `MaskingError` when the boundary or the ids cannot be trusted.
 */
export function maskSpan(items: readonly Item[], boundary: { id: string }): { items: Item[]; stats: MaskStats } {
  return maskItems(items.slice(0, locateBoundary(items, boundary)))
}
