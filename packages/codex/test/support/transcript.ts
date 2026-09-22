/**
 * Builders for Codex rollout lines, in the shape a real rollout has (checked against a live
 * `~/.codex/archived_sessions/*.jsonl` file and the Codex hooks/config documentation; see
 * README.md, "Evidence"). A rollout is JSON Lines: one entry per line, `type: "response_item"`
 * carrying a Responses-API-shaped conversation item under `payload`.
 */

export type Entry = Record<string, unknown>

let ordinal = 0
export const resetOrdinal = (): void => {
  ordinal = 0
}

const responseItem = (payload: Entry): Entry => ({
  timestamp: '2026-09-21T10:00:00.000Z',
  ordinal: ++ordinal,
  type: 'response_item',
  payload,
})

export const user = (text: string): Entry => responseItem({ type: 'message', id: `msg-${ordinal}`, role: 'user', content: [{ type: 'input_text', text }] })

export const assistantText = (text: string): Entry =>
  responseItem({ type: 'message', id: `msg-${ordinal}`, role: 'assistant', content: [{ type: 'output_text', text }] })

export const reasoning = (text: string): Entry =>
  responseItem({ type: 'reasoning', id: `rs-${ordinal}`, summary: [{ type: 'summary_text', text }] })

export const functionCall = (callId: string, name: string, args: Record<string, unknown>): Entry =>
  responseItem({ type: 'function_call', id: `fc-${ordinal}`, call_id: callId, name, arguments: JSON.stringify(args) })

/** A tool result whose output is a plain string, as most function calls return it. */
export const functionCallOutput = (callId: string, body: string, options: { success?: boolean } = {}): Entry =>
  responseItem({
    type: 'function_call_output',
    call_id: callId,
    output: options.success === undefined ? body : { content: body, success: options.success },
  })

export const localShellCall = (callId: string, command: string[]): Entry =>
  responseItem({ type: 'local_shell_call', call_id: callId, status: 'completed', action: { type: 'exec', command } })

/** Codex's own plaintext (local / remote-v1) compaction result: a message carrying the known marker. */
export const localCompactionSummary = (summary: string): Entry =>
  responseItem({
    type: 'message',
    id: `msg-${ordinal}`,
    role: 'assistant',
    content: [{ type: 'output_text', text: `The conversation history before this point was compacted into the following summary:\n\n${summary}` }],
  })

/** Codex's remote-v2 compaction result: an opaque encrypted item, unreadable by this adapter. */
export const remoteCompactionSummary = (): Entry =>
  responseItem({ type: 'compaction', id: `cmp-${ordinal}`, encrypted_content: 'gAAAAABnotarealtoken==' })

export const sessionMeta = (extra: Entry = {}): Entry => ({
  timestamp: '2026-09-21T09:59:00.000Z',
  ordinal: ++ordinal,
  type: 'session_meta',
  payload: { session_id: 'sess-0001', id: 'sess-0001', timestamp: '2026-09-21T09:59:00.000Z', cwd: '/workspace/app', model_provider: 'openai', ...extra },
})

export const eventMsg = (type: string): Entry => ({ timestamp: '2026-09-21T10:00:00.000Z', ordinal: ++ordinal, type: 'event_msg', payload: { type } })

export const bulky = (mark: string, lines = 40): string =>
  Array.from({ length: lines }, (_, i) => `${mark} line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n')

export const jsonl = (entries: Entry[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
