import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationSnapshot, Item } from '@maskpoint/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { featuresOf, REQUIRED_FEATURES } from '../src/coverage.js'
import { type CorpusFixture, corpusDir, loadCorpus, parseSnapshot } from '../src/corpus.js'
import { checkSanitized } from '../src/sanitize.js'

const user = (id: string, text = 'hello'): Item => ({ id, kind: 'user', text })
const snapshot = (items: Item[], boundaryId: string): ConversationSnapshot => ({
  items,
  boundary: { id: boundaryId },
  reason: 'threshold',
})

const detail = {
  v: 1,
  engine: 'maskpoint',
  strategy: 'mask',
  checkpoints: 0,
  stats: { observationsMasked: 1, charsOmitted: 10, candidateTokens: 5 },
}

describe('parseSnapshot', () => {
  it('accepts a well-formed snapshot and returns it unchanged', () => {
    const value = snapshot([user('a'), { id: 'b', kind: 'assistant-text', text: 'hi' }], 'b')
    expect(parseSnapshot(value)).toEqual(value)
  })

  it.each([
    ['a non-object', 42, /snapshot/i],
    ['an unknown item kind', { ...snapshot([user('a')], 'a'), items: [{ id: 'a', kind: 'banana' }] }, /kind/],
    ['an item without an id', { ...snapshot([user('a')], 'a'), items: [{ kind: 'user', text: 'x' }] }, /id/],
    ['duplicate item ids', snapshot([user('a'), user('a')], 'a'), /duplicate/i],
    ['a boundary naming no item', snapshot([user('a')], 'zzz'), /boundary/i],
    ['an unknown reason', { ...snapshot([user('a')], 'a'), reason: 'whenever' }, /reason/],
    [
      'a tool result without a media count',
      { ...snapshot([user('a')], 'a'), items: [{ id: 'a', kind: 'tool-result', status: 'ok' }] },
      /media/,
    ],
    [
      'a tool result with a bad status',
      { ...snapshot([user('a')], 'a'), items: [{ id: 'a', kind: 'tool-result', status: 'maybe', media: 0 }] },
      /status/,
    ],
    [
      'an evictedThrough naming no item',
      { ...snapshot([user('a')], 'a'), evictedThrough: 'zzz' },
      /evictedThrough/,
    ],
    ['file operations with a missing list', { ...snapshot([user('a')], 'a'), fileOps: { read: [], written: [] } }, /fileOps.*edited/],
    [
      'file operations that are not paths',
      { ...snapshot([user('a')], 'a'), fileOps: { read: [1], written: [], edited: [] } },
      /fileOps\.read/,
    ],
    [
      'previous details of an unknown version',
      { ...snapshot([user('a')], 'a'), previousDetail: { ...detail, v: 2 } },
      /previousDetail\.v/,
    ],
    [
      'previous details with an unknown key',
      { ...snapshot([user('a')], 'a'), previousDetail: { ...detail, body: 'leak' } },
      /previousDetail.*unknown key "body"/,
    ],
    [
      'previous details without statistics',
      { ...snapshot([user('a')], 'a'), previousDetail: { ...detail, stats: { observationsMasked: 1 } } },
      /previousDetail\.stats/,
    ],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseSnapshot(value)).toThrow(message)
  })

  it('accepts the accumulation state an adapter supplies: previous details and file operations', () => {
    const value = {
      ...snapshot([user('a'), user('b')], 'b'),
      previousCheckpoint: 'state',
      evictedThrough: 'a',
      previousDetail: { ...detail, files: { read: ['/workspace/a.ts'], written: [], edited: [] }, cursor: { boundaryId: 'a', evictedThroughId: 'a' } },
      fileOps: { read: ['/workspace/b.ts'], written: [], edited: ['/workspace/c.ts'] },
    }
    expect(parseSnapshot(value)).toEqual(value)
  })
})

describe('loadCorpus', () => {
  let dir: string
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value))
  const entry = (name: string) => ({ name, file: `${name}.json`, description: `the ${name} fixture` })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maskpoint-corpus-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads every fixture the manifest enumerates', () => {
    write('one.json', snapshot([user('a')], 'a'))
    write('two.json', snapshot([user('b')], 'b'))
    write('manifest.json', { fixtures: [entry('one'), entry('two')] })

    const corpus = loadCorpus(dir)
    expect(corpus.map((fixture) => fixture.name)).toEqual(['one', 'two'])
    expect(corpus[0]?.description).toBe('the one fixture')
    expect(corpus[1]?.snapshot.boundary.id).toBe('b')
  })

  it('fails when the manifest names a fixture file that does not exist', () => {
    write('manifest.json', { fixtures: [entry('ghost')] })
    expect(() => loadCorpus(dir)).toThrow(/ghost/)
  })

  it('fails when a fixture file on disk is not enumerated by the manifest', () => {
    write('one.json', snapshot([user('a')], 'a'))
    write('orphan.json', snapshot([user('b')], 'b'))
    write('manifest.json', { fixtures: [entry('one')] })
    expect(() => loadCorpus(dir)).toThrow(/orphan\.json/)
  })

  it('fails on duplicate fixture names', () => {
    write('one.json', snapshot([user('a')], 'a'))
    write('manifest.json', { fixtures: [entry('one'), entry('one')] })
    expect(() => loadCorpus(dir)).toThrow(/duplicate/i)
  })

  it('names the offending fixture when its content is invalid', () => {
    write('bad.json', snapshot([user('a')], 'nope'))
    write('manifest.json', { fixtures: [entry('bad')] })
    expect(() => loadCorpus(dir)).toThrow(/bad.*boundary/is)
  })
})

describe('featuresOf', () => {
  it('finds nothing in a bare conversation', () => {
    expect([...featuresOf(snapshot([user('a')], 'a'))]).toEqual([])
  })

  it('derives features from content, not from labels', () => {
    const features = featuresOf(
      snapshot(
        [
          user('u1', '把配置迁移到新目录'),
          { id: 't1', kind: 'tool-call', name: 'read', callId: 'c1', args: '{"path":"a.ts"}' },
          { id: 't2', kind: 'tool-call', name: 'bash', callId: 'c2', args: '{"command":"ls"}' },
          { id: 'r1', kind: 'tool-result', name: 'read', callId: 'c1', status: 'ok', text: 'x', media: 0 },
          { id: 'r2', kind: 'tool-result', name: 'bash', callId: 'c2', status: 'error', exitCode: 2, media: 1 },
          { id: 'h1', kind: 'host-context', label: 'AGENTS.md', text: 'rules' },
        ],
        'r1',
      ),
    )
    expect(features).toEqual(
      new Set([
        'cjk',
        'parallel-tool-calls',
        'shell-execution',
        'text-observation',
        'image-observation',
        'success-result',
        'error-result',
        'host-context',
        'split-turn',
      ]),
    )
  })

  it('does not call a boundary at a turn start a split turn', () => {
    const items: Item[] = [user('u1'), { id: 'a1', kind: 'assistant-text', text: 'ok' }, user('u2')]
    expect(featuresOf(snapshot(items, 'u2')).has('split-turn')).toBe(false)
  })
})

describe('the checked-in corpus', () => {
  let corpus: CorpusFixture[]
  beforeAll(() => {
    corpus = loadCorpus(corpusDir)
  })

  it('is enumerated by its manifest and parses', () => {
    expect(corpus.length).toBeGreaterThan(0)
  })

  it('covers every feature the design requires', () => {
    const covered = new Set(corpus.flatMap((fixture) => [...featuresOf(fixture.snapshot)]))
    expect([...REQUIRED_FEATURES].filter((feature) => !covered.has(feature))).toEqual([])
  })

  it('is sanitized', () => {
    expect(checkSanitized([corpusDir])).toEqual([])
  })
})
