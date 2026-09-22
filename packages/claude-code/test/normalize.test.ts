import { describe, expect, it } from 'vitest'
import { normalizeTranscript } from '../src/normalize.js'
import {
  assistantText,
  assistantThinking,
  attachment,
  noise,
  system,
  toolResult,
  toolResultBlocks,
  toolUse,
  user,
} from './support/transcript.js'

describe('normalizeTranscript — reading a Claude Code transcript into engine items', () => {
  it('turns a user message into a user item', () => {
    const items = normalizeTranscript([user('Rename Widget to Panel.')])
    expect(items).toEqual([{ id: expect.stringMatching(/#0$/), kind: 'user', text: 'Rename Widget to Panel.' }])
  })

  it('turns assistant text, reasoning and a tool call into their own items, in order', () => {
    const items = normalizeTranscript([assistantThinking('Grep first.'), assistantText('Searching now.'), toolUse('call-1', 'grep', { pattern: 'Widget' })])
    expect(items.map((item) => item.kind)).toEqual(['assistant-reasoning', 'assistant-text', 'tool-call'])
    expect(items[2]).toMatchObject({ kind: 'tool-call', name: 'grep', callId: 'call-1', args: JSON.stringify({ pattern: 'Widget' }) })
  })

  it('pairs a tool result with the call that named it, by tool_use_id', () => {
    const items = normalizeTranscript([toolUse('call-1', 'grep', { pattern: 'Widget' }), toolResult('call-1', 'no matches')])
    const result = items.find((item) => item.kind === 'tool-result')
    expect(result).toMatchObject({ kind: 'tool-result', name: 'grep', callId: 'call-1', status: 'ok', text: 'no matches', media: 0 })
  })

  it('marks a tool result an error when the host flagged it, and omits the name it never learned', () => {
    const items = normalizeTranscript([toolResult('call-unknown', 'ENOENT', { isError: true })])
    expect(items).toEqual([{ id: expect.any(String), kind: 'tool-result', callId: 'call-unknown', status: 'error', text: 'ENOENT', media: 0 }])
  })

  it('counts images in a tool result and keeps any text that travelled with them', () => {
    const items = normalizeTranscript([
      toolUse('call-1', 'screenshot', {}),
      toolResultBlocks('call-1', [{ type: 'text', text: 'captured' }, { type: 'image', source: {} }, { type: 'image', source: {} }]),
    ])
    const result = items.find((item) => item.kind === 'tool-result')
    expect(result).toMatchObject({ text: 'captured', media: 2 })
  })

  it('reads a real multi-modal user turn (text and a pasted image), not a tool result', () => {
    const items = normalizeTranscript([user('', { message: { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: {} }] } })])
    expect(items).toEqual([{ id: expect.any(String), kind: 'user', text: 'What is this?\n[image omitted]' }])
  })

  it('turns a compaction summary entry into a checkpoint item', () => {
    const items = normalizeTranscript([user('Earlier work summarized here.', { isCompactSummary: true, isVisibleInTranscriptOnly: true })])
    expect(items).toEqual([{ id: expect.any(String), kind: 'checkpoint', text: 'Earlier work summarized here.' }])
  })

  it('turns a meta user entry (host-injected caveat or notification) into host-context, not a real user message', () => {
    const items = normalizeTranscript([user('<local-command-caveat>Caveat: ...', { isMeta: true })])
    expect(items).toEqual([{ id: expect.any(String), kind: 'host-context', label: 'meta', text: '<local-command-caveat>Caveat: ...' }])
  })

  it('skips bookkeeping, system, attachment and unknown line types without failing', () => {
    const items = normalizeTranscript([...noise(), system('compact_boundary'), attachment('total_tokens_reminder')])
    expect(items).toEqual([])
  })

  it('skips a sidechain entry: it is a subagent turn, not part of what the host itself compacts', () => {
    const items = normalizeTranscript([user('main turn'), user('subagent turn', { isSidechain: true })])
    expect(items).toEqual([{ id: expect.any(String), kind: 'user', text: 'main turn' }])
  })

  it('skips an entry with no id to name a position by', () => {
    const items = normalizeTranscript([{ type: 'user', message: { role: 'user', content: 'no uuid here' } }])
    expect(items).toEqual([])
  })

  it('assigns each item of a multi-block assistant turn its own id, unique within the transcript', () => {
    const items = normalizeTranscript([assistantText('one'), assistantThinking('two')])
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves chronological order across entries', () => {
    const items = normalizeTranscript([user('first'), assistantText('second'), user('third')])
    expect(items.map((item) => (item.kind === 'user' ? item.text : item.kind === 'assistant-text' ? item.text : '?'))).toEqual([
      'first',
      'second',
      'third',
    ])
  })
})
