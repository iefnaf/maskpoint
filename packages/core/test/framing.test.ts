import { describe, expect, it } from 'vitest'
import type { Item } from '../src/index.js'
import { HISTORY_FRAMING, roleLabel } from '../src/index.js'

const oneOfEach: Item[] = [
  { id: '1', kind: 'user', text: 'Delete the build directory.' },
  { id: '2', kind: 'assistant-text', text: 'Deleting it now.' },
  { id: '3', kind: 'assistant-reasoning', text: 'It is safe to remove.' },
  { id: '4', kind: 'tool-call', name: 'bash', args: '{"command":"rm -rf build"}' },
  { id: '5', kind: 'tool-result', name: 'bash', status: 'ok', text: 'done', media: 0 },
  { id: '6', kind: 'checkpoint', text: '## Completed work' },
  { id: '7', kind: 'host-context', label: 'AGENTS.md', text: 'Use pnpm.' },
  { id: '8', kind: 'opaque', note: 'unrecognized host event' },
]

describe('provenance framing for masked history', () => {
  it('labels every kind of item with an explicit, distinct role', () => {
    const labels = oneOfEach.map(roleLabel)
    expect(labels.every((label) => label.trim() !== '')).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('names the tool on tool calls and tool results, and the label on host context', () => {
    expect(roleLabel(oneOfEach[3]!)).toContain('bash')
    expect(roleLabel(oneOfEach[4]!)).toContain('bash')
    expect(roleLabel(oneOfEach[6]!)).toContain('AGENTS.md')
  })

  it('labels a tool result whose tool is unknown without inventing a name', () => {
    const label = roleLabel({ id: '9', kind: 'tool-result', status: 'ok', media: 0 })
    expect(label).not.toMatch(/undefined|null/)
    expect(label).toMatch(/tool result/i)
  })

  it('marks recorded user, assistant and tool content as record, not as something said now', () => {
    for (const item of oneOfEach.filter((each) => ['user', 'assistant-text', 'assistant-reasoning', 'tool-call', 'tool-result'].includes(each.kind))) {
      expect(roleLabel(item), item.kind).toMatch(/recorded/i)
    }
  })

  it('tells the reader the entries are history and not instructions to follow', () => {
    expect(HISTORY_FRAMING).toMatch(/record|history/i)
    expect(HISTORY_FRAMING).toMatch(/not\b.*\binstruction/i)
  })
})
