import type { ConversationSnapshot } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { calibrate, calibrateCorpus } from '../src/calibration.js'
import { loadCorpus } from '../src/corpus.js'

const corpus = loadCorpus()

const snapshotOf = (text: string): ConversationSnapshot => ({
  items: [
    { id: 'u1', kind: 'user', text },
    { id: 'boundary', kind: 'user', text: 'kept' },
  ],
  boundary: { id: 'boundary' },
  reason: 'manual',
})

describe('calibrate', () => {
  it('reports both the internal estimator and DSH host-meter totals for the same region', () => {
    const result = calibrate({ name: 'ascii', snapshot: snapshotOf('a'.repeat(400)) })
    expect(result).toBeDefined()
    expect(result!.estimator).toBeGreaterThan(0)
    expect(result!.hostMeter).toBeGreaterThan(0)
    expect(result!.divergence).toBe(result!.hostMeter - result!.estimator)
  })

  it('returns undefined for a region with nothing to compact, rather than a bogus zero', () => {
    const nothing: ConversationSnapshot = { items: [{ id: 'only', kind: 'user', text: 'kept' }], boundary: { id: 'only' }, reason: 'manual' }
    expect(calibrate({ name: 'empty', snapshot: nothing })).toBeUndefined()
  })

  it('diverges differently on CJK than on ASCII text of the same length', () => {
    const cjkText = '内容審査プロセスの詳細な説明と背景情報を含む長文のテキストです。'.repeat(6)
    const asciiText = 'e'.repeat([...cjkText].length)
    const cjk = calibrate({ name: 'cjk-sample', snapshot: snapshotOf(cjkText) })!
    const ascii = calibrate({ name: 'ascii-sample', snapshot: snapshotOf(asciiText) })!
    // Same character count, different weighting on each side (our estimator weights CJK higher per
    // character; DSH's own meter counts every character alike), so the two divergences differ.
    expect(cjk.relativeDivergence).not.toBeCloseTo(ascii.relativeDivergence!, 2)
  })
})

describe('calibrateCorpus', () => {
  const results = calibrateCorpus(corpus)

  it('produces a result for every fixture that has something to compact', () => {
    const names = results.map((result) => result.fixture)
    expect(names).toContain('cjk')
    expect(names).toContain('code-heavy')
  })

  it('tags each result with the corpus features it exercises', () => {
    const cjk = results.find((result) => result.fixture === 'cjk')!
    expect(cjk.features).toContain('cjk')
    const code = results.find((result) => result.fixture === 'code-heavy')!
    expect(code.features).toContain('code-heavy')
  })

  it('every result is finite and non-negative on both sides', () => {
    for (const result of results) {
      expect(Number.isFinite(result.estimator)).toBe(true)
      expect(Number.isFinite(result.hostMeter)).toBe(true)
      expect(result.estimator).toBeGreaterThanOrEqual(0)
      expect(result.hostMeter).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('a hand-computed sanity check', () => {
  it('matches DSH\'s documented fixed heuristic (4 chars/token) plus structural overhead on plain text', () => {
    // docs: "four characters per token plus structural overhead for roles, blocks, and
    // request-envelope fields" -- one short user message: role overhead (4) + one text block
    // (ceil(len/4) + block overhead 4).
    const text = 'a'.repeat(40)
    const result = calibrate({ name: 'sanity', snapshot: snapshotOf(text) })!
    const expectedHostMeter = 4 /* role overhead */ + Math.ceil(text.length / 4) + 4 /* block overhead */
    expect(result.hostMeter).toBe(expectedHostMeter)
  })
})
