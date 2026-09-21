import type { Artifact, Item, Renderer, Stats } from '@maskpoint/core'
import type { CorpusFixture } from './corpus.js'
import { boundaryIndex, payload } from './items.js'

/** What the harness needs from a masking engine: the newly evicted span in, masked items and stats out. */
export interface ReplayEngine {
  name: string
  /** Set to false for an engine that returns history unmasked, so the replay can say so. */
  masks?: false
  mask(evicted: Item[]): { items: Item[]; stats: Pick<Stats, 'observationsMasked' | 'charsOmitted'> }
}

/**
 * Stand-in until the masking engine lands: returns the span untouched and says so, so a replay is
 * never mistaken for real masking. Swap for an engine wrapper once one exists.
 */
export const passThroughEngine: ReplayEngine = {
  name: 'pass-through (masking not implemented yet)',
  masks: false,
  mask: (evicted) => ({ items: evicted, stats: { observationsMasked: 0, charsOmitted: 0 } }),
}

function label(item: Item): string {
  switch (item.kind) {
    case 'user':
      return `user ${item.id}`
    case 'assistant-text':
      return `assistant ${item.id}`
    case 'assistant-reasoning':
      return `assistant reasoning ${item.id}`
    case 'tool-call':
      return `tool-call ${item.name} ${item.id}${item.callId ? ` call=${item.callId}` : ''}`
    case 'tool-result': {
      const parts = [`tool-result ${item.name ?? '?'} ${item.id}`]
      if (item.callId) parts.push(`call=${item.callId}`)
      parts.push(item.status)
      if (item.exitCode !== undefined) parts.push(`exit=${item.exitCode}`)
      if (item.media > 0) parts.push(`media=${item.media}`)
      if (item.masked) parts.push('masked')
      return parts.join(' ')
    }
    case 'checkpoint':
      return `checkpoint ${item.id}`
    case 'host-context':
      return `host-context ${item.label} ${item.id}`
    case 'opaque':
      return `opaque ${item.id}`
  }
}

function renderItems(items: Item[]): string {
  return items
    .map((item) => {
      const body = payload(item)
      const indented = body === '' ? '' : `\n${body.replace(/^/gm, '    ')}`
      return `[${label(item)}]${indented}`
    })
    .join('\n')
}

/**
 * A diagnostic text rendering of an artifact. Deliberately not the host-facing rendering: it labels
 * every item for a human reading a replay and makes no attempt to frame history as non-instruction.
 */
export const plainTextRenderer: Renderer<string> = {
  render(artifact: Artifact): string {
    return artifact.sections
      .map((section) =>
        section.kind === 'checkpoint'
          ? `== checkpoint ==\n${section.text}`
          : `== masked history (${section.items.length} items) ==\n${renderItems(section.items)}`,
      )
      .join('\n\n')
  },
}

const sizeOf = (items: Item[]) => items.reduce((total, item) => total + payload(item).length, 0)

/**
 * Print what a compaction would carry for a fixture: the masked history for the newly evicted span,
 * the region the host keeps verbatim, and statistics. Runs no host and no model.
 */
export function replay(fixture: CorpusFixture, engine: ReplayEngine): string {
  const { snapshot } = fixture
  const { items } = snapshot
  const cut = boundaryIndex(snapshot)
  const representedThrough =
    snapshot.evictedThrough === undefined ? 0 : items.findIndex((item) => item.id === snapshot.evictedThrough) + 1

  const evicted = items.slice(representedThrough, cut)
  const retained = items.slice(cut)
  const masked = engine.mask(evicted)

  const artifact: Artifact = {
    stats: { ...masked.stats, candidateTokens: 0 },
    sections: [
      ...(snapshot.previousCheckpoint === undefined
        ? []
        : [{ kind: 'checkpoint' as const, text: snapshot.previousCheckpoint }]),
      { kind: 'masked-history', items: masked.items },
    ],
  }

  return [
    `fixture: ${fixture.name}`,
    fixture.description,
    `trigger: ${snapshot.reason} · items: ${items.length} · already represented: ${representedThrough} · compacted: ${evicted.length} · retained: ${retained.length} (boundary ${snapshot.boundary.id})`,
    `engine: ${engine.name}`,
    ...(snapshot.customInstructions === undefined ? [] : [`custom instructions: ${snapshot.customInstructions}`]),
    ...(engine.masks === false ? ['note: this engine does not mask, so the history below is unmasked'] : []),
    '',
    plainTextRenderer.render(artifact),
    '',
    `== retained by host (${retained.length} items, verbatim) ==`,
    renderItems(retained),
    '',
    '== statistics ==',
    `observationsMasked: ${masked.stats.observationsMasked}`,
    `charsOmitted: ${masked.stats.charsOmitted}`,
    `compacted characters before: ${sizeOf(evicted)}`,
    `compacted characters after: ${sizeOf(masked.items)}`,
    '',
  ].join('\n')
}
