/**
 * The platform-neutral vocabulary every adapter and the engine share.
 * Shapes follow docs/design.md ("Interfaces"); that document is the contract.
 *
 * Terminology is fixed: *masked history* is deterministic serialized history with observation
 * bodies replaced; a *checkpoint* is a model-generated state summary. Never conflate them.
 */

/**
 * One entry of a normalized conversation. Every item carries a snapshot-unique `id`, which is how
 * the retained boundary and the accumulation cursor name a position without the engine knowing the
 * host's own identifiers. (The design's Interfaces listing elides `id`; its failure table's
 * "non-monotonic ids" row and `boundary.id` / `evictedThrough` require it.)
 */
export type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant-text'; text: string }
  | { id: string; kind: 'assistant-reasoning'; text: string }
  | { id: string; kind: 'tool-call'; name: string; callId?: string; args: string }
  | {
      id: string
      kind: 'tool-result'
      name?: string
      callId?: string
      status: 'ok' | 'error'
      exitCode?: number
      text?: string
      /** Number of media payloads (images) the host observation carried. */
      media: number
      /** True when the body is already a placeholder, e.g. from a host-side pruner. */
      masked?: boolean
    }
  | { id: string; kind: 'checkpoint'; text: string }
  | { id: string; kind: 'host-context'; label: string; text: string }
  | { id: string; kind: 'opaque'; note: string }

export type ItemKind = Item['kind']

/** An observation: the item masking replaces the body of. */
export type ToolResultItem = Extract<Item, { kind: 'tool-result' }>

/** Paths the session has read, written and edited: derived state, so it holds paths and never content. */
export interface FileOps {
  read: string[]
  written: string[]
  edited: string[]
}

export interface ConversationSnapshot {
  items: Item[]
  /**
   * The host's own cut point, passed through the engine unchanged. `id` names the first item the
   * host retains verbatim; everything before it is the span the engine may mask.
   */
  boundary: { id: string }
  /**
   * The text of the previous compaction's result, whichever strategy produced it: what the host
   * carried forward. It is appended to, never re-masked. Comes with `evictedThrough` or not at all.
   */
  previousCheckpoint?: string
  /**
   * Id of the last item already represented in `previousCheckpoint`. Taken from the host's own
   * repeated-compaction boundary where it has one, else from the previous `EngineDetail.cursor`.
   */
  evictedThrough?: string
  /** What the previous compaction persisted, when the adapter found compatible details. */
  previousDetail?: EngineDetail
  /** File operations the host tracked for the span being compacted now, when it tracks them. */
  fileOps?: FileOps
  customInstructions?: string
  reason: 'manual' | 'threshold' | 'overflow'
}

/** What an adapter can actually do. Published per adapter so tiers are never overstated. */
export interface CapabilityProfile {
  replaceHistory: boolean
  steerSummarizer: boolean
  reinjectContext: boolean
  persistMetadata: boolean
  honestCancellation: boolean
  injectionCapChars?: number
}

/**
 * When accumulated history is too big to carry as masked history. The unit is tokens, by the
 * engine's own estimator, never turns: the paper's turn counts were calibrated for another scaffold.
 */
export interface BudgetPolicy {
  /** The candidate at or below this many estimated tokens stays masked history; above it, a checkpoint. */
  checkpointTriggerTokens: number
}

/** The statistics key set, identical on every platform. */
export interface Stats {
  observationsMasked: number
  charsOmitted: number
  candidateTokens: number
}

/** Persisted by adapters; never contains observation bodies. */
export interface EngineDetail {
  v: 1
  engine: 'maskpoint'
  strategy: 'mask' | 'checkpoint'
  checkpoints: number
  stats: Stats
  files?: FileOps
  cursor?: { boundaryId: string; evictedThroughId: string }
}

/** Token usage of a checkpoint model call, reported back to the host. */
export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** One ordered part of an artifact. Sections are data; rendering happens at the adapter edge. */
export type ArtifactSection =
  /** A model-generated state summary. */
  | { kind: 'checkpoint'; text: string }
  /** Chronological history in which observation bodies are replaced and everything else is intact. */
  | { kind: 'masked-history'; items: Item[] }

/** Structured engine output: ordered sections plus a statistics block, never a rendered string. */
export interface Artifact {
  sections: ArtifactSection[]
  stats: Stats
}

/** Why an adapter returned no custom result, leaving the host to compact normally. */
export type DeclineReason =
  | 'unreadable-snapshot'
  | 'masking-failure'
  | 'inconsistent-cursor'
  /** No previous state and nothing evicted: any artifact would be empty, and an empty artifact is never returned. */
  | 'nothing-to-compact'
  | 'host-rejected'

export type Outcome =
  | { kind: 'masked-history'; artifact: Artifact; detail: EngineDetail; stats: Stats }
  | { kind: 'checkpoint'; artifact: Artifact; detail: EngineDetail; stats: Stats; usage?: Usage }
  | { kind: 'decline'; reason: DeclineReason }

export type MaskedHistoryOutcome = Extract<Outcome, { kind: 'masked-history' }>

/**
 * Turns an artifact into a host's vocabulary: a Pi summary string, DSH content blocks, injected
 * markdown. Implemented by adapters; the engine never renders.
 */
export interface Renderer<Rendered> {
  render(artifact: Artifact): Rendered
}
