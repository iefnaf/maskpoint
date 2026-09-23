import {
  recallById,
  renderRecallEntry,
  renderRecallSearch,
  searchRecall,
  type Item,
} from '@maskpoint/core'
import { isRecord, normalizeEntry, type Rec } from './normalize.js'
import type { PiContext, PiExtensionApi, PiToolRegistration } from './host.js'

/**
 * The `recall` tool: the inverse of the mask primitive, agent-initiated only. A placeholder the
 * mask step leaves reads `[tool result omitted: bash, ok, 14 lines, 892 chars (recall id:39f65e5a)]`;
 * the model passes that id and gets the entry's body back, verbatim, bounded. Zero model calls,
 * zero file reads — the raw session entries are already in memory, compaction not applied
 * (`getEntries`, never `buildContextEntries`). Design and measured behaviour: `docs/recall-tool.md`.
 */

const RECALL_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: "the id shown after 'id:' in a mask placeholder" },
    q: { type: 'string', description: 'optional substring (or /regex/) filter over masked entries, for placeholders without an id you know' },
    full: { type: 'boolean', description: 'return one entry whole up to the hard cap, instead of clipped to the search budget' },
    page: { type: 'number', description: '1-based continuation page when a full entry was clipped' },
  },
} as const

const text = (t: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: t }] })

/**
 * The raw entries recall owns: everything before the most recent compaction entry. What follows it
 * is already in context, so recovering it would only duplicate; what precedes it is the span the
 * placeholders point into.
 */
function recallableItems(ctx: PiContext | undefined): Item[] | undefined {
  const entries = ctx?.sessionManager?.getEntries()
  if (!Array.isArray(entries)) return undefined
  let boundary = -1
  for (let i = 0; i < entries.length; i++) {
    if (isRecord(entries[i]) && (entries[i] as Rec).type === 'compaction') boundary = i
  }
  if (boundary === -1) return []
  const items: Item[] = []
  for (const entry of entries.slice(0, boundary)) {
    if (isRecord(entry) && typeof entry.id === 'string') items.push(...normalizeEntry(entry as Rec & { id: string }))
  }
  return items
}

/** Register the tool on hosts that have `registerTool`; on older hosts, lose the tool, never more. */
export function registerRecallTool(pi: PiExtensionApi): void {
  if (typeof pi.registerTool !== 'function') return
  const tool: PiToolRegistration = {
    name: 'recall',
    label: 'Recall',
    description:
      'Recovers the verbatim original text behind a mask placeholder from earlier in this session. ' +
      'Placeholders look like \'[tool result omitted: bash, ok, 14 lines, 892 chars (recall id:39f65e5a)]\' — ' +
      "pass the id shown after 'id:'. For a placeholder without an id, pass q to search masked entries.",
    parameters: RECALL_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = (params ?? {}) as { id?: unknown; q?: unknown; full?: unknown; page?: unknown }
      const items = recallableItems(ctx)
      if (items === undefined) {
        return text('recall is unavailable: this host exposes no session entries to recover.')
      }
      if (items.length === 0) {
        return text('Nothing has been compacted in this session yet — there is no masked content to recover.')
      }
      if (signal.aborted) return text('recall cancelled before it ran.')

      const id = typeof p.id === 'string' && p.id !== '' ? p.id : undefined
      const q = typeof p.q === 'string' && p.q !== '' ? p.q : undefined
      if (id !== undefined) {
        const lookup = recallById(items, id)
        if (lookup.kind === 'entry') {
          const render: { full?: boolean; page?: number } = { full: p.full === true }
          if (typeof p.page === 'number' && Number.isInteger(p.page)) render.page = p.page
          return text(renderRecallEntry(lookup.item, render))
        }
        if (lookup.kind === 'ambiguous') {
          return text(
            `id '${lookup.id}' matches ${lookup.candidates.length} entries: ${lookup.candidates.join(', ')}. Pass more of the id.`,
          )
        }
        const viaSearch = q !== undefined ? searchRecall(items, q) : []
        const hint = viaSearch.length > 0
          ? ` A search for '${q}' found ${viaSearch.length} masked ${viaSearch.length === 1 ? 'entry' : 'entries'} — refine or pass one of their ids from a placeholder.`
          : q !== undefined ? ` A search for '${q}' found nothing masked.` : ''
        return text(`No masked entry with id '${lookup.id}' in this session.${hint}`)
      }
      if (q !== undefined) {
        return text(renderRecallSearch(searchRecall(items, q)))
      }
      return text("Pass the id shown after 'id:' in a mask placeholder (e.g. id:39f65e5a), or q to search masked entries.")
    },
  }
  pi.registerTool(tool)
}
