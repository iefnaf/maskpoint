import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

type Measurement = ReturnType<TokenMeter['measure']>

/** An inclusive span of surface nodes, named by the seqs of its first and last node. */
export interface SeqRange {
  start: number
  end: number
}

/**
 * The span the host would compact: from the head of the surface up to a retained recent tail of at
 * least `retainTokens`, cut at a tool-pairing-balanced boundary. Everything after `end` is the
 * host's retained window and is never touched. This is the host backend's own selection, restated
 * (the host does not export it) and pinned to it by a parity test.
 */
export function selectRange(
  session: Session,
  measurement: Measurement,
  retainTokens: number,
): SeqRange | null {
  const priced = measurement.nodes
  if (priced.length === 0) return null
  const nodes = session.surface.nodes
  if (nodes.length !== priced.length || nodes.some((seq, index) => seq !== priced[index]?.seq)) {
    throw new Error('maskpoint: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFrom = priced.length
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index]!.tokens
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  if (keepFrom === 0) return null

  // Never cut between a tool call and its result: retreat to the nearest balanced cut.
  while (keepFrom > 0 && !toolPairingBalancedBefore(session, nodes[keepFrom]!)) keepFrom -= 1
  if (keepFrom === 0) return null

  return { start: nodes[0]!, end: nodes[keepFrom - 1]! }
}
