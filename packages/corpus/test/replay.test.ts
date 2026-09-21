import type { Artifact, Item } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { type CorpusFixture, loadCorpus } from '../src/corpus.js'
import { passThroughEngine, plainTextRenderer, type ReplayEngine, replay } from '../src/replay.js'

const BIG_BODY = 'BULKY-OBSERVATION-BODY '.repeat(40)

const fixture: CorpusFixture = {
  name: 'demo',
  file: 'demo.json',
  description: 'A tiny demo conversation.',
  snapshot: {
    reason: 'threshold',
    boundary: { id: 'i05' },
    items: [
      { id: 'i01', kind: 'user', text: 'Please run the tests.' },
      { id: 'i02', kind: 'tool-call', name: 'bash', callId: 'c1', args: '{"command":"npm test"}' },
      { id: 'i03', kind: 'tool-result', name: 'bash', callId: 'c1', status: 'error', exitCode: 1, text: BIG_BODY, media: 0 },
      { id: 'i04', kind: 'assistant-reasoning', text: 'Two tests failed.' },
      { id: 'i05', kind: 'assistant-text', text: 'Fixing the failing tests now.' },
      { id: 'i06', kind: 'tool-result', name: 'bash', callId: 'c2', status: 'ok', exitCode: 0, text: 'RETAINED-BODY', media: 0 },
    ],
  },
}

/** A stand-in for the real masking step: replaces every observation body with a placeholder. */
const maskingDouble: ReplayEngine = {
  name: 'masking-double',
  mask(evicted) {
    let observationsMasked = 0
    let charsOmitted = 0
    const items = evicted.map((item): Item => {
      if (item.kind !== 'tool-result' || item.text === undefined) return item
      observationsMasked++
      charsOmitted += item.text.length
      return { ...item, text: `[masked ${item.text.length} chars]`, masked: true }
    })
    return { items, stats: { observationsMasked, charsOmitted } }
  },
}

function section(report: string, title: string): string {
  const start = report.indexOf(`== ${title}`)
  expect(start, `section "${title}" in report`).toBeGreaterThanOrEqual(0)
  const next = report.indexOf('\n== ', start + 1)
  return report.slice(start, next === -1 ? undefined : next)
}

describe('replay', () => {
  const report = replay(fixture, maskingDouble)

  it('identifies the fixture, trigger, and how the history splits at the boundary', () => {
    expect(report).toContain('fixture: demo')
    expect(report).toContain('trigger: threshold')
    expect(report).toContain('compacted: 4')
    expect(report).toContain('retained: 2')
    expect(report).toContain('engine: masking-double')
  })

  it('prints the masked history with observation bodies replaced and everything else intact', () => {
    const masked = section(report, 'masked history')
    expect(masked).toContain('Please run the tests.')
    expect(masked).toContain('{"command":"npm test"}')
    expect(masked).toContain('Two tests failed.')
    expect(masked).toContain(`[masked ${BIG_BODY.length} chars]`)
    expect(masked).not.toContain('BULKY-OBSERVATION-BODY')
  })

  it('labels roles, tool names, status and exit codes', () => {
    const masked = section(report, 'masked history')
    expect(masked).toMatch(/\[user\b/)
    expect(masked).toMatch(/\[assistant reasoning\b/)
    expect(masked).toMatch(/\[tool-call bash\b/)
    expect(masked).toMatch(/\[tool-result bash\b.*\berror\b.*exit=1/)
  })

  it('lists the retained region verbatim and never hands it to the engine', () => {
    const retained = section(report, 'retained by host')
    expect(retained).toContain('Fixing the failing tests now.')
    expect(retained).toContain('RETAINED-BODY')
    expect(section(report, 'masked history')).not.toContain('RETAINED-BODY')
  })

  it('prints statistics reported by the engine plus before/after sizes of the compacted span', () => {
    const stats = section(report, 'statistics')
    expect(stats).toContain('observationsMasked: 1')
    expect(stats).toContain(`charsOmitted: ${BIG_BODY.length}`)
    expect(stats).toMatch(/compacted characters before: \d+/)
    const [before, after] = [/before: (\d+)/, /after: (\d+)/].map((p) => Number(p.exec(stats)?.[1]))
    expect(before).toBeGreaterThan(after!)
  })

  it('shows a pass-through engine honestly: nothing masked, and it says so', () => {
    const untouched = replay(fixture, passThroughEngine)
    expect(untouched).toContain('engine: pass-through')
    expect(untouched).toContain('observationsMasked: 0')
    expect(untouched).toContain('charsOmitted: 0')
    expect(section(untouched, 'masked history')).toContain('BULKY-OBSERVATION-BODY')
  })

  it('replays only the newly evicted span when earlier items are already represented in state', () => {
    const accumulated: CorpusFixture = {
      ...fixture,
      snapshot: { ...fixture.snapshot, evictedThrough: 'i02', previousCheckpoint: 'PRIOR-CHECKPOINT-STATE' },
    }
    const text = replay(accumulated, passThroughEngine)
    expect(text).toContain('compacted: 2')
    expect(text).toContain('already represented: 2')
    expect(text).toContain('PRIOR-CHECKPOINT-STATE')
    const masked = section(text, 'masked history')
    expect(masked).not.toContain('Please run the tests.')
    expect(masked).toContain('BULKY-OBSERVATION-BODY')
  })

  it('replays every fixture in the checked-in corpus', () => {
    for (const each of loadCorpus()) {
      expect(replay(each, passThroughEngine), each.name).toContain(`fixture: ${each.name}`)
    }
  })
})

describe('plainTextRenderer', () => {
  const artifact: Artifact = {
    stats: { observationsMasked: 0, charsOmitted: 0, candidateTokens: 0 },
    sections: [
      { kind: 'checkpoint', text: 'CHECKPOINT-STATE' },
      { kind: 'masked-history', items: [{ id: 'a', kind: 'user', text: 'hello there' }] },
    ],
  }

  it('renders sections in order', () => {
    const text = plainTextRenderer.render(artifact)
    expect(text.indexOf('CHECKPOINT-STATE')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('CHECKPOINT-STATE')).toBeLessThan(text.indexOf('hello there'))
  })

  it('distinguishes a checkpoint from masked history in its labels', () => {
    const text = plainTextRenderer.render(artifact)
    expect(text).toMatch(/checkpoint/i)
    expect(text).toMatch(/masked history/i)
  })
})
