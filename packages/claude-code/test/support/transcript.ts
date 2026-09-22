/**
 * Builders for Claude Code transcript lines, in the shape a real transcript has (checked against a
 * Claude Code 2.1.276 session file; see test/recorded/README.md). A transcript is JSON Lines: one
 * entry per line, an assistant turn split into one entry per content block, and a tool result
 * carried by a user entry that also repeats the body in a `toolUseResult` sidecar.
 */

export type Entry = Record<string, unknown>

const SESSION = 'sess-0001'
let counter = 0
const nextUuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

/** Make uuids predictable inside a test file: call in `beforeEach`. */
export const resetUuids = (): void => {
  counter = 0
}

const envelope = (uuid: string, extra: Entry = {}): Entry => ({
  parentUuid: null,
  isSidechain: false,
  sessionId: SESSION,
  timestamp: '2026-09-21T10:00:00.000Z',
  cwd: '/workspace/app',
  version: '2.1.276',
  uuid,
  ...extra,
})

export const user = (text: string, extra: Entry = {}): Entry => ({
  type: 'user',
  ...envelope(nextUuid()),
  message: { role: 'user', content: text },
  ...extra,
})

export const assistantText = (text: string): Entry => ({
  type: 'assistant',
  ...envelope(nextUuid()),
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
})

export const assistantThinking = (thinking: string): Entry => ({
  type: 'assistant',
  ...envelope(nextUuid()),
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'thinking', thinking, signature: 'c2ln' }] },
})

export const toolUse = (id: string, name: string, input: Record<string, unknown>): Entry => ({
  type: 'assistant',
  ...envelope(nextUuid()),
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
})

/** A tool result whose body is a string, as Bash, Read and most tools return it. */
export const toolResult = (id: string, body: string, options: { isError?: boolean } = {}): Entry => ({
  type: 'user',
  ...envelope(nextUuid(), { toolUseResult: { stdout: body, stderr: '', interrupted: false } }),
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: body, ...(options.isError === undefined ? {} : { is_error: options.isError }) },
    ],
  },
})

/** A tool result made of content blocks: text and images. */
export const toolResultBlocks = (id: string, blocks: Record<string, unknown>[]): Entry => ({
  type: 'user',
  ...envelope(nextUuid()),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: blocks }] },
})

export const attachment = (kind: string, extra: Entry = {}): Entry => ({
  type: 'attachment',
  ...envelope(nextUuid()),
  attachment: { type: kind, ...extra },
})

export const system = (subtype: string, extra: Entry = {}): Entry => ({
  type: 'system',
  subtype,
  ...envelope(nextUuid()),
  ...extra,
})

/** What Claude Code writes when it compacts: a boundary, then the host's own summary as a user entry. */
export const compaction = (summary: string): Entry[] => [
  system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 190000, postTokens: 12000 } }),
  user(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
]

export const bulky = (mark: string, lines = 40): string =>
  Array.from({ length: lines }, (_, i) => `${mark} line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n')

export const jsonl = (entries: Entry[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`

/** Entries that are not conversation, and must never reach the artifact. */
export const noise = (): Entry[] => [
  { type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-21T10:00:00.000Z', sessionId: SESSION },
  system('turn_duration', { durationMs: 1200 }),
  attachment('total_tokens_reminder', { content: 'NOISE-ATTACHMENT-BODY' }),
  { type: 'ai-title', aiTitle: 'Fixing a parser', sessionId: SESSION },
]
