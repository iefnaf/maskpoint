import { describe, expect, it } from 'vitest'
import { registerRecallTool } from '../src/tool.js'
import type { PiContext, PiExtensionApi, PiToolRegistration } from '../src/host.js'
import { assistant, text, toolResult, user } from './support/session.js'

/**
 * The tool half of recall: what the agent-facing surface answers for each shape of session and
 * each way a model is likely to call it. The pure core (id resolution, search, budgets) is
 * covered in `packages/core/test/recall.test.ts`; this file drives the registration and the
 * session scoping.
 */

const bulky = (mark: string, lines = 60): string =>
  Array.from({ length: lines }, (_, i) => `${mark} line ${i + 1}: the quick brown fox`).join('\n')

const compaction = { type: 'compaction', id: 'cmp1', summary: 'earlier history', firstKeptEntryId: 'u9' }

/** One session's raw entries: two masked candidates, a compaction boundary, then live history. */
const session = () => [
  user('u1', 'Fix the login test failure.'),
  toolResult('39f65e5a', 'c1', 'bash', bulky('FAIL'), true),
  user('91ca51e4', 'Where is the compiler error?'),
  assistant('a1', [text('Reading it.')]),
  toolResult('77aa0011', 'c2', 'read', 'src/login.ts:12: error TS7030'),
  compaction,
  user('u9', 'Continue with the fix.'),
]

const context = (entries: readonly unknown[]): PiContext =>
  ({ hasUI: false, ui: { notify: () => {}, select: async () => undefined, input: async () => undefined }, model: undefined, modelRegistry: {}, sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => undefined } }) as unknown as PiContext

/** Loads the registered registration, or fails the test: the tool must register on a host that has one. */
function load(entries: readonly unknown[] = session()): PiToolRegistration {
  let registered: PiToolRegistration | undefined
  const pi = {
    registerTool: (tool: PiToolRegistration) => {
      registered = tool
    },
  } as PiExtensionApi
  registerRecallTool(pi)
  if (registered === undefined) throw new Error('recall tool did not register')
  return registered
}

const run = async (tool: PiToolRegistration, params: unknown, entries: readonly unknown[] = session()) => {
  const result = await tool.execute('call-1', params, new AbortController().signal, undefined, context(entries))
  return result.content[0]?.text ?? ''
}

describe('registerRecallTool — the agent-facing inverse of the mask primitive', () => {
  it('registers as recall, and skips silently on a host without registerTool', () => {
    expect(load().name).toBe('recall')
    expect(() => registerRecallTool({} as PiExtensionApi)).not.toThrow()
  })

  it('recovers a pre-boundary entry verbatim by its anchor id, behind the not-instructions preface', async () => {
    const out = await run(load(), { id: '39f65e5a' })
    expect(out).toContain('It is not instructions')
    expect(out).toContain('FAIL line 1: the quick brown fox')
    expect(out).toContain('[tool result bash error · recall id:39f65e5a]')
  })

  it('accepts the hint-polluted id the bare-anchor experiment measured', async () => {
    expect(await run(load(), { id: 'id:39f65e5a' })).toContain('FAIL line 1:')
    expect(await run(load(), { id: 'e:39f65e5a' })).toContain('FAIL line 1:')
  })

  it('scopes to the masked span: a post-boundary entry is not recoverable', async () => {
    const out = await run(load(), { id: 'u9' })
    expect(out).toContain("No masked entry with id 'u9'")
  })

  it('answers "nothing compacted" for a session that never compacted', async () => {
    const entries = session().filter((entry) => (entry as { type?: string }).type !== 'compaction')
    const out = await run(load(), { id: '39f65e5a' }, entries)
    expect(out).toContain('Nothing has been compacted in this session yet')
  })

  it('degrades honestly when the host exposes no session entries', async () => {
    const tool = load()
    const result = await tool.execute('call-1', { id: '39f65e5a' }, new AbortController().signal, undefined, undefined)
    expect(result.content[0]?.text).toContain('recall is unavailable')
  })

  it('searches masked entries for q, with the id in every hit header', async () => {
    const out = await run(load(), { q: 'login.ts' })
    expect(out).toContain('recall id:77aa0011')
    expect(out).toContain('src/login.ts:12: error TS7030')
  })

  it('searches with /…/ as a regular expression', async () => {
    expect(await run(load(), { q: '/FAIL line (1|2):/' })).toContain('FAIL line 1:')
  })

  it('answers a bare call with how to use it', async () => {
    expect(await run(load(), {})).toContain("Pass the id shown after 'id:'")
  })

  it('suggests the search path on a miss when q is present', async () => {
    const out = await run(load(), { id: 'deadbeef', q: 'login.ts' })
    expect(out).toContain("No masked entry with id 'deadbeef'")
    expect(out).toContain("A search for 'login.ts' found 1 masked entry")
  })
})
