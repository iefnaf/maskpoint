import type { PiAssistantMessage, PiBeforeCompactEvent, PiContext, PiModelRegistry, PiPreparation, PiUsage } from '../../src/host.js'

/**
 * Builders for Pi session entries and the `session_before_compact` event Pi derives from them.
 * The shapes follow Pi's session format; the preparation follows what Pi's `prepareCompaction`
 * does with a branch. The recorded-payload conformance tests are what check these against a
 * real Pi — this is only a convenient way to write the cases.
 */

export type Entry = Record<string, unknown>
type Block = Record<string, unknown>

let clock = 0
const base = (id: string, type: string) => ({
  type,
  id,
  parentId: null,
  timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
})

export const text = (value: string): Block => ({ type: 'text', text: value })
export const thinking = (value: string): Block => ({ type: 'thinking', thinking: value })
export const image = (): Block => ({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
export const toolCall = (id: string, name: string, args: Record<string, unknown>): Block => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
})

export const user = (id: string, content: string | Block[]): Entry => ({
  ...base(id, 'message'),
  message: { role: 'user', content, timestamp: 1 },
})

export const assistant = (id: string, content: Block[]): Entry => ({
  ...base(id, 'message'),
  message: { role: 'assistant', content, stopReason: 'stop', timestamp: 1 },
})

export const toolResult = (
  id: string,
  callId: string,
  toolName: string,
  content: string | Block[],
  isError = false,
): Entry => ({
  ...base(id, 'message'),
  message: {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: typeof content === 'string' ? [text(content)] : content,
    isError,
    timestamp: 1,
  },
})

export const bash = (
  id: string,
  command: string,
  output: string,
  exitCode: number | undefined,
  extra: Record<string, unknown> = {},
): Entry => ({
  ...base(id, 'message'),
  message: { role: 'bashExecution', command, output, exitCode, cancelled: false, truncated: false, timestamp: 1, ...extra },
})

export const customMessage = (id: string, customType: string, content: string | Block[]): Entry => ({
  ...base(id, 'custom_message'),
  customType,
  content,
  display: true,
})

export const branchSummary = (id: string, summary: string): Entry => ({
  ...base(id, 'branch_summary'),
  fromId: 'elsewhere',
  summary,
})

/** An entry that carries no conversation: Pi keeps it in the session but never sends it to the model. */
export const modelChange = (id: string): Entry => ({ ...base(id, 'model_change'), provider: 'test', modelId: 'test-model' })

export const compaction = (
  id: string,
  summary: string,
  firstKeptEntryId: string,
  details?: unknown,
): Entry => ({
  ...base(id, 'compaction'),
  summary,
  firstKeptEntryId,
  tokensBefore: 50_000,
  ...(details === undefined ? {} : { details }),
})

/** The message Pi derives from an entry for compaction, or undefined when the entry carries none. */
function messageOf(entry: Entry): unknown {
  switch (entry.type) {
    case 'message': {
      const message = entry.message as { role?: string }
      return message.role === 'system' ? undefined : message
    }
    case 'custom_message':
      return { role: 'custom', customType: entry.customType, content: entry.content, display: entry.display }
    case 'branch_summary':
      return entry.summary ? { role: 'branchSummary', summary: entry.summary, fromId: entry.fromId } : undefined
    default:
      return undefined
  }
}

const messagesIn = (entries: readonly Entry[], from: number, to: number): unknown[] =>
  entries.slice(from, to).flatMap((entry) => {
    const message = messageOf(entry)
    return message === undefined ? [] : [message]
  })

export interface CompactOptions {
  reason?: PiBeforeCompactEvent['reason']
  customInstructions?: string
  /** The user message that starts the turn being split, when the cut lands mid-turn. */
  splitTurnAt?: string
  tokensBefore?: number
  /** The file operations Pi tracked for the span, as Pi holds them at runtime: Sets of paths. */
  fileOps?: { read?: string[]; written?: string[]; edited?: string[] }
}

/**
 * The event Pi emits when it would compact `entries` keeping everything from `keepFrom` on: the
 * same span selection as Pi's `prepareCompaction`, including where an earlier compaction left off.
 */
export function beforeCompact(entries: readonly Entry[], keepFrom: string, options: CompactOptions = {}): PiBeforeCompactEvent {
  const kept = entries.findIndex((entry) => entry.id === keepFrom)
  if (kept === -1) throw new Error(`test setup: no entry "${keepFrom}"`)
  const previous = entries.findLastIndex((entry) => entry.type === 'compaction')
  let start = 0
  let previousSummary: string | undefined
  if (previous >= 0) {
    const earlier = entries[previous]!
    previousSummary = earlier.summary as string
    const keptBefore = entries.findIndex((entry) => entry.id === earlier.firstKeptEntryId)
    start = keptBefore >= 0 ? keptBefore : previous + 1
  }
  const turnStart = options.splitTurnAt === undefined ? kept : entries.findIndex((entry) => entry.id === options.splitTurnAt)
  const preparation: PiPreparation = {
    firstKeptEntryId: keepFrom,
    messagesToSummarize: messagesIn(entries, start, turnStart),
    turnPrefixMessages: options.splitTurnAt === undefined ? [] : messagesIn(entries, turnStart, kept),
    isSplitTurn: options.splitTurnAt !== undefined,
    tokensBefore: options.tokensBefore ?? 40_000,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    fileOps: {
      read: new Set(options.fileOps?.read),
      written: new Set(options.fileOps?.written),
      edited: new Set(options.fileOps?.edited),
    },
  }
  return {
    preparation,
    branchEntries: entries,
    ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
    reason: options.reason ?? 'threshold',
    willRetry: options.reason === 'overflow',
    signal: new AbortController().signal,
  }
}

/** A bulky observation body that is easy to recognize in output. */
export const bulky = (mark: string, lines = 40): string =>
  Array.from({ length: lines }, (_, i) => `${mark} line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n')

/**
 * The provider's own usage for one reply, complete: Pi's totals add `usage.cost.total` to their own,
 * so a usage this adapter forwards has to be the whole object, cost included.
 */
export function usageOf(input: number, output: number, overrides: Partial<PiUsage> = {}): PiUsage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  }
}

/** A successful, non-streaming model reply: `stop`, the given text, and simple token usage. */
export function modelReply(text: string, overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return { content: [{ type: 'text', text }], usage: usageOf(100, 40), stopReason: 'stop', ...overrides }
}

/**
 * A UI context that records what the user would have been shown. `modelRegistry.complete` rejects
 * by default, so a test that does not expect a checkpoint call catches one it did not ask for.
 */
export function fakeContext(hasUI = true, config?: unknown, contextWindow?: number): PiContext & { notes: { message: string; level: string | undefined }[] } {
  const notes: { message: string; level: string | undefined }[] = []
  const modelRegistry: PiModelRegistry = {
    complete: () => Promise.reject(new Error('no checkpoint call was expected in this test')),
  }
  return {
    hasUI,
    ui: {
      notify: (message, level) => notes.push({ message, level }),
      select: () => Promise.resolve(undefined),
      input: () => Promise.resolve(undefined),
    },
    notes,
    model: { id: 'test-model', ...(contextWindow === undefined ? {} : { contextWindow }) },
    modelRegistry,
    config,
  }
}
