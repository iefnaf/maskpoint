import { maskItems } from '@maskpoint/core'
import type { MaskStats } from '@maskpoint/core'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { normalizeMessages, toolNames } from './normalize.js'

/**
 * Mask the tool observations among the surface nodes `start..end` in place, by the host's own
 * model-free protocol: per observation, a `compaction/prune` shadow price immediately followed by a
 * content-only `tool/result` replacement citing the shadowed node. The shadow price is what keeps
 * the host's replay accounting exact; without it the meter and the replay projections disagree.
 *
 * An observation is left alone when the engine leaves it alone (already masked, by us or by the
 * host's pruner; or its placeholder would not be smaller) or when the host's own meter says the
 * replacement would not be smaller either, so the total can only fall.
 */
export function maskInPlace(
  session: Session,
  meter: TokenMeter,
  range: { start: number; end: number },
): MaskStats {
  const total: MaskStats = { observationsMasked: 0, charsOmitted: 0 }
  // A snapshot: replacements move nodes to new seqs, and the pass must not chase its own writes.
  const nodes = [...session.surface.nodes]
  const span = nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1)
  // An observation's tool name lives on its call, an assistant message elsewhere on the surface.
  const names = toolNames(nodes.flatMap((seq) => {
    const event = session.events[seq]
    return event?.type === 'assistant/message' ? [event.data.message] : []
  }))

  for (const seq of span) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    const original = event.data.message
    const [item] = normalizeMessages([original], names)
    if (item?.kind !== 'tool-result') continue
    const { items, stats } = maskItems([item])
    const masked = items[0]
    if (stats.observationsMasked === 0 || masked?.kind !== 'tool-result') continue

    const block = original.content[0]
    const replacement = freezeMessage<ToolResultMessage>({
      ...original,
      content: [{ ...block, content: [{ type: 'text', text: masked.text ?? '' }] }] as [typeof block],
    })
    const shadowedTokenCount = meter.estimateMessage(original)
    if (meter.estimateMessage(replacement) >= shadowedTokenCount) continue

    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount,
    })
    session.append('tool/result', { ...event.data, message: replacement }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    total.observationsMasked += stats.observationsMasked
    total.charsOmitted += stats.charsOmitted
  }
  return total
}
