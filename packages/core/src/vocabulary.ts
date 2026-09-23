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
  compactBudgetTokens: number
}

/** The statistics key set, identical on every platform. */
export interface Stats {
  observationsMasked: number
  /**
   * Reasoning blocks masked, present only once reasoning masking is on and has masked something, so
   * an artifact from either behaviour is recognisable by shape rather than by a zero to interpret.
   */
  reasoningsMasked?: number
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

/**
 * The part of a host's `AbortSignal` the engine reads. The engine package has no DOM or Node
 * typings, so it names the shape; a host's own signal satisfies it and is passed through as-is.
 */
export interface CancellationSignal {
  readonly aborted: boolean
}

/**
 * One checkpoint call, in the host-neutral shape an adapter turns into its own model request.
 * Everything a one-off summarization must not inherit from the main loop is fixed here: it has no
 * tools, keeps no cache, and never shares the main loop's routing identity.
 */
export interface ModelRequest {
  /** The configured checkpoint model. Absent means the session's own model. */
  model?: string
  /** What to produce and in what format. */
  instructions: string
  /** The candidate: previous state plus newly evicted masked history, never original observation bodies. */
  input: string
  /** The generation cap. A response cut off by it is rejected. */
  maxOutputTokens: number
  /** Fresh for this call, so a one-off summarization does not distort the main loop's caching. */
  routingId: string
  cacheRetention: 'none'
  /** Always empty: a summarization call cannot perform side effects. */
  tools: readonly never[]
  /** The host's own cancellation signal. */
  signal: CancellationSignal
}

/** How a model call ended, in the host-neutral vocabulary the double and every adapter share. */
export interface ModelResponse {
  stopReason: 'stop' | 'length' | 'tool-call' | 'error' | 'aborted'
  /** Whatever text came back. Meaningful only when `stopReason` is `stop`. */
  text: string
  usage?: Usage
  error?: string
}

/** Everything the engine needs from its host to make the one checkpoint call. */
export interface EngineDeps {
  /** The host's model call. Adapters implement it; tests use a deterministic double. */
  complete(request: ModelRequest): Promise<ModelResponse>
  /** A routing identity that has not been used before. Asked for once per checkpoint call. */
  newRoutingId(): string
  /** The host's cancellation signal, carried into the checkpoint request. */
  signal: CancellationSignal
  checkpoint: {
    /** The generation cap for the checkpoint. */
    maxOutputTokens: number
    /** A configured model for checkpoints. Absent means the session model. */
    model?: string
  }
}

/** Why a checkpoint call was not accepted. The compaction falls back to masked history. */
export type CheckpointRejection = 'provider-error' | 'aborted' | 'truncated' | 'empty' | 'tool-call'

/** Why an adapter returned no custom result, leaving the host to compact normally. */
export type DeclineReason =
  | 'unreadable-snapshot'
  | 'masking-failure'
  | 'inconsistent-cursor'
  /** No previous state and nothing evicted: any artifact would be empty, and an empty artifact is never returned. */
  | 'nothing-to-compact'
  /** The result would not be smaller than what it replaces: a native compaction must strictly shrink context. */
  | 'no-size-reduction'
  /** A checkpoint was asked for (custom instructions) and this adapter cannot run one, so the host's own compactor honours it. */
  | 'checkpoint-unavailable'
  /** The adapter failed unexpectedly. The host compacts, so a fault here can never leave a session without a result. */
  | 'engine-failure'
  | 'host-rejected'

export type Outcome =
  /** `checkpointRejection` is set when a checkpoint was attempted and this is the fallback. */
  | {
      kind: 'masked-history'
      artifact: Artifact
      detail: EngineDetail
      stats: Stats
      checkpointRejection?: CheckpointRejection
    }
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
