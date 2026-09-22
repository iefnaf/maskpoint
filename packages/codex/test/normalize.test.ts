import { describe, expect, it } from 'vitest'
import { normalizeTranscript } from '../src/normalize.js'
import {
  assistantText,
  eventMsg,
  functionCall,
  functionCallOutput,
  localShellCall,
  reasoning,
  resetOrdinal,
  sessionMeta,
  user,
} from './support/transcript.js'

describe('normalizeTranscript', () => {
  it('turns messages, reasoning, and tool calls into engine items in order', () => {
    resetOrdinal()
    const items = normalizeTranscript([user('Read config.ts'), reasoning('checking the file first'), functionCall('call-1', 'read', { path: 'config.ts' }), functionCallOutput('call-1', 'export const x = 1'), assistantText('Done.')])
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant-reasoning', 'tool-call', 'tool-result', 'assistant-text'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Read config.ts' })
    expect(items[2]).toMatchObject({ kind: 'tool-call', name: 'read', callId: 'call-1' })
    expect(items[3]).toMatchObject({ kind: 'tool-result', name: 'read', callId: 'call-1', status: 'ok', text: 'export const x = 1' })
  })

  it('marks a function_call_output with success: false as an error result', () => {
    resetOrdinal()
    const items = normalizeTranscript([functionCall('call-1', 'bash', { command: 'false' }), functionCallOutput('call-1', 'command not found', { success: false })])
    expect(items[1]).toMatchObject({ kind: 'tool-result', status: 'error', text: 'command not found' })
  })

  it('treats a local_shell_call as a tool-call named for the shell, carrying its command as args', () => {
    resetOrdinal()
    const items = normalizeTranscript([localShellCall('call-1', ['ls', '-la']), functionCallOutput('call-1', 'file1\nfile2')])
    expect(items[0]).toMatchObject({ kind: 'tool-call', name: 'local_shell', callId: 'call-1', args: 'ls -la' })
    expect(items[1]).toMatchObject({ kind: 'tool-result', name: 'local_shell', status: 'ok' })
  })

  it('skips bookkeeping and telemetry line types: session_meta and event_msg', () => {
    resetOrdinal()
    const items = normalizeTranscript([sessionMeta(), user('hello'), eventMsg('task_started')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello' })
  })

  it('never throws on a malformed or unrecognized entry, degrading instead', () => {
    resetOrdinal()
    const weird = [{ type: 'response_item', payload: { type: 'web_search_call', id: 'ws-1' } }, { type: 'response_item', payload: 'not-a-record' }, { type: 'response_item' }, {}]
    expect(() => normalizeTranscript(weird as never)).not.toThrow()
    expect(normalizeTranscript(weird as never)).toEqual([])
  })

  it('produces unique, monotonic item ids', () => {
    resetOrdinal()
    const items = normalizeTranscript([user('a'), assistantText('b'), assistantText('c')])
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
