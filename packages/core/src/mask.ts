import { estimateTokens } from './estimate.js'
import type { Item, Stats } from './vocabulary.js'

type ToolResult = Extract<Item, { kind: 'tool-result' }>

/** What masking measures. `candidateTokens` belongs to accumulation, which owns the candidate. */
export type MaskStats = Pick<Stats, 'observationsMasked' | 'charsOmitted'>

/** The snapshot cannot be masked as given. Adapters turn this into a decline, so the host compacts. */
export class MaskingError extends Error {
  override readonly name = 'MaskingError'
}

/** Every placeholder starts like this, which is how an already-masked observation is recognized. */
const PLACEHOLDER = /^\[tool result omitted: [^\]\n]*\]/

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function countLines(text: string): number {
  if (text === '') return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * The placeholder for an observation: what it was and how much was dropped — never any of the body.
 * `omitted` is the text being dropped, `media` the number of payloads being dropped.
 */
function placeholderFor(item: ToolResult, omitted: string | undefined, media: number): string {
  const fields: string[] = []
  if (item.name !== undefined && item.name !== '') fields.push(item.name)
  fields.push(item.status)
  if (item.exitCode !== undefined) fields.push(`exit ${item.exitCode}`)
  if (omitted !== undefined) fields.push(plural(countLines(omitted), 'line'), plural(omitted.length, 'char'))
  if (media > 0) fields.push(plural(media, 'image'))
  return `[tool result omitted: ${fields.join(', ')}]`
}

const replaced = (item: ToolResult, text: string): ToolResult => ({ ...item, text, media: 0, masked: true })

/** The masked observation and how many characters of text it dropped, or undefined to leave it alone. */
function maskObservation(item: ToolResult): { item: ToolResult; charsOmitted: number } | undefined {
  // Idempotence: a placeholder — ours, or a host pruner's flagged one — is already what masking makes.
  if (item.masked === true) return undefined
  const body = item.text ?? ''
  if (PLACEHOLDER.test(body)) return undefined

  // No-expansion: a text placeholder must be strictly smaller than what it replaces, by the same
  // estimator the budget uses. Otherwise the text stays as it was.
  const replacement = body === '' ? undefined : placeholderFor(item, body, item.media)
  const shrinks = replacement !== undefined && estimateTokens(replacement) < estimateTokens(body)

  if (item.media === 0) return shrinks ? { item: replaced(item, replacement!), charsOmitted: body.length } : undefined

  // An image payload is dropped whatever its text costs: the estimator only sees text, and images
  // are the worst context-per-information item in a session. Text that travelled with it is
  // metadata, kept when it is small and masked like any other body when it is not.
  if (shrinks) return { item: replaced(item, replacement!), charsOmitted: body.length }
  const note = placeholderFor(item, undefined, item.media)
  return { item: replaced(item, body === '' ? note : `${note} ${body}`), charsOmitted: 0 }
}

/**
 * Mask every observation in `items`, leaving everything else intact. Pure: returns new items and
 * never mutates its input. Callers decide which span to pass; see `maskSpan` for the boundary rule.
 */
export function maskItems(items: readonly Item[]): { items: Item[]; stats: MaskStats } {
  const stats: MaskStats = { observationsMasked: 0, charsOmitted: 0 }
  const out = items.map((item): Item => {
    if (item.kind !== 'tool-result') return item
    const masked = maskObservation(item)
    if (masked === undefined) return item
    stats.observationsMasked++
    stats.charsOmitted += masked.charsOmitted
    return masked.item
  })
  return { items: out, stats }
}

/**
 * Mask the span the host is compacting: every item before the retained boundary. The host's
 * retained region is the only full-fidelity window, so nothing at or after the boundary is
 * touched — and none of it appears in the result, so it can never be duplicated into the compacted
 * side. Throws `MaskingError` when the boundary or the ids cannot be trusted.
 */
export function maskSpan(items: readonly Item[], boundary: { id: string }): { items: Item[]; stats: MaskStats } {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new MaskingError(`duplicate item id "${item.id}"`)
    seen.add(item.id)
  }
  const cut = items.findIndex((item) => item.id === boundary.id)
  if (cut === -1) throw new MaskingError(`retained boundary names no item: "${boundary.id}"`)
  return maskItems(items.slice(0, cut))
}
