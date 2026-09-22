/**
 * The slice of Pi's extension API this adapter touches, written structurally rather than imported.
 * The extension is loaded by Pi itself, so the real objects arrive at runtime; declaring only what
 * we read keeps the package free of a host SDK dependency. Drift in Pi's shapes is caught by the
 * conformance tests over payloads recorded from real Pi sessions, not by the type checker.
 *
 * Everything that comes out of a session file is `unknown` until narrowed: Pi parses session files
 * without validating them, so old versions, forks and hand edits can put anything there.
 */

/** Pi's `CompactionPreparation`: the cut point it chose and the messages it would summarize. */
export interface PiPreparation {
  /** Id of the first session entry Pi retains verbatim. Returned to Pi unchanged. */
  firstKeptEntryId: string
  messagesToSummarize: readonly unknown[]
  /** The early part of a turn whose cut landed mid-turn; also compacted away. */
  turnPrefixMessages: readonly unknown[]
  isSplitTurn: boolean
  tokensBefore: number
  /** The previous compaction's summary text, whichever extension or strategy wrote it. */
  previousSummary?: string | undefined
  /**
   * The read, written and edited paths Pi tracked for this span, plus, when the previous compaction
   * was Pi's own, that compaction's. Sets at runtime; arrays once recorded. Read as `unknown`.
   */
  fileOps?: unknown
}

/** Pi's `SessionBeforeCompactEvent`. */
export interface PiBeforeCompactEvent {
  preparation: PiPreparation
  /** Every session entry on the active branch, in order, including earlier compaction entries. */
  branchEntries: readonly unknown[]
  customInstructions?: string | undefined
  reason: 'manual' | 'threshold' | 'overflow'
  willRetry: boolean
  /** Aborted when the user cancels. Pi always supplies one; the handler does not rely on it. */
  signal?: AbortSignal | undefined
}

/** What a handler returns to replace Pi's summarize step. Returning nothing leaves Pi's own compactor in charge. */
export interface PiCompactionResult {
  compaction: {
    summary: string
    firstKeptEntryId: string
    tokensBefore: number
    /** Persisted in the compaction entry. Never contains observation bodies. */
    details?: unknown
    /**
     * The provider's own `Usage` for the checkpoint call, when one ran. Pi stores it on the
     * compaction entry so session totals count the summarization work.
     */
    usage?: PiUsage
  }
}

/**
 * Pi's `Usage`: token accounting for one model response. Written out in full rather than narrowed
 * to the fields this adapter reads, because a usage is handed back to Pi as well: Pi's totals add
 * `usage.cost.total`, so a reduced object could not be forwarded even if this adapter wanted to.
 */
export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
  cacheWrite1h?: number | undefined
  /** Reasoning tokens, a subset of `output`. Absent when the provider reports no breakdown. */
  reasoning?: number | undefined
  totalTokens: number
  cost: PiCost
}

/** Pi's `Usage['cost']`: what the call cost, per field, at the provider's own rates. */
export interface PiCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** The one content-block shape this adapter reads; any other block type is ignored, not narrowed. */
export interface PiTextBlock {
  type: 'text'
  text: string
}

/** Pi's `AssistantMessage`, the shape `modelRegistry.complete` resolves to. */
export interface PiAssistantMessage {
  content: readonly (PiTextBlock | { type: string })[]
  usage: PiUsage
  /** Pi's `StopReason`. `pending` and `deferred` describe a streaming response, never `complete`'s. */
  stopReason: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'
}

/** Pi's `Model`: opaque beyond identity, since this adapter never inspects it, only forwards it. */
export interface PiModel {
  id: string
}

export interface PiCompleteOptions {
  maxTokens?: number
  signal?: AbortSignal | undefined
  cacheRetention?: 'none' | 'default'
  sessionId?: string
}

/** The slice of Pi's `ModelRegistry` the checkpoint call uses. */
export interface PiModelRegistry {
  complete(
    model: PiModel,
    context: { systemPrompt?: string; messages: readonly { role: 'user'; content: string; timestamp: number }[] },
    options?: PiCompleteOptions,
  ): Promise<PiAssistantMessage>
}

/** The parts of Pi's `ExtensionContext` the handler uses. */
export interface PiContext {
  hasUI: boolean
  ui: { notify(message: string, level?: 'info' | 'warning' | 'error'): void }
  /** The session's active model. Absent when none is configured or authenticated. */
  model: PiModel | undefined
  modelRegistry: PiModelRegistry
  /**
   * This extension's own settings, however Pi's runtime supplies them for an installed extension
   * (issue #8, `config.ts`). Absent when the host passes none, which is every Pi release measured
   * so far — see issue #39 for what a probe of a real session found, and `config.ts` for the
   * environment and CLI-flag channels that carry settings instead. Absent is resolved exactly like
   * an empty settings object: every field falls back to the documented default. Left as `unknown`,
   * like every other Pi-supplied value here, because nothing in this package can validate what a
   * real Pi release actually sends.
   */
  config?: unknown
}

/** A CLI flag this extension registers: `type: "string"` only, since every setting is read as text. */
export interface PiFlagOptions {
  description: string
  type: 'string'
  default?: string
}

export interface PiExtensionApi {
  on(
    event: 'session_before_compact',
    handler: (event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>,
  ): unknown
  /** Register a CLI flag, so it appears in `pi --help` and can be parsed from this run's command line. */
  registerFlag(name: string, options: PiFlagOptions): unknown
  /** This run's value for a registered flag. `undefined` when the flag was not passed. */
  getFlag(name: string): boolean | string | undefined
}
