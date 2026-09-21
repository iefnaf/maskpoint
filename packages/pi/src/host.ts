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
}

/** Pi's `SessionBeforeCompactEvent`. */
export interface PiBeforeCompactEvent {
  preparation: PiPreparation
  /** Every session entry on the active branch, in order, including earlier compaction entries. */
  branchEntries: readonly unknown[]
  customInstructions?: string | undefined
  reason: 'manual' | 'threshold' | 'overflow'
  willRetry: boolean
  signal: AbortSignal
}

/** What a handler returns to replace Pi's summarize step. Returning nothing leaves Pi's own compactor in charge. */
export interface PiCompactionResult {
  compaction: {
    summary: string
    firstKeptEntryId: string
    tokensBefore: number
    /** Persisted in the compaction entry. Never contains observation bodies. */
    details?: unknown
  }
}

/** The parts of Pi's `ExtensionContext` the handler uses. */
export interface PiContext {
  hasUI: boolean
  ui: { notify(message: string, level?: 'info' | 'warning' | 'error'): void }
}

export interface PiExtensionApi {
  on(
    event: 'session_before_compact',
    handler: (event: PiBeforeCompactEvent, ctx: PiContext) => PiCompactionResult | undefined | Promise<PiCompactionResult | undefined>,
  ): unknown
}
