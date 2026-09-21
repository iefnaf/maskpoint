import { estimateTokens, type Item, maskSpan } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { type CorpusFixture, loadCorpus } from '../src/corpus.js'
import { boundaryIndex, payload } from '../src/items.js'

/** Seam 1: the engine over neutral snapshots, driven by the shared corpus. No host, no model, no network. */

type ToolResult = Extract<Item, { kind: 'tool-result' }>
const corpus = loadCorpus()
const fixture = (name: string): CorpusFixture => {
  const found = corpus.find((each) => each.name === name)
  if (!found) throw new Error(`no fixture ${name}`)
  return found
}
const compacted = ({ snapshot }: CorpusFixture) => snapshot.items.slice(0, boundaryIndex(snapshot))
const maskFixture = ({ snapshot }: CorpusFixture) => maskSpan(snapshot.items, snapshot.boundary)
const isResult = (item: Item): item is ToolResult => item.kind === 'tool-result'
const tokens = (items: Item[]) => items.reduce((total, item) => total + estimateTokens(payload(item)), 0)

describe.each(corpus.map((each) => [each.name, each] as const))('masking the %s fixture', (_name, each) => {
  const before = compacted(each)
  const { items: after, stats } = maskFixture(each)

  it('keeps chronological order and carries exactly the compacted side', () => {
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id))
    const retained = each.snapshot.items.slice(boundaryIndex(each.snapshot)).map((item) => item.id)
    expect(after.map((item) => item.id).filter((id) => retained.includes(id))).toEqual([])
  })

  it('does not modify the snapshot, so nothing at or after the boundary can change', () => {
    const untouched = structuredClone(each.snapshot)
    maskFixture(each)
    expect(each.snapshot).toEqual(untouched)
  })

  it('removes only observation bodies: every other item comes through intact', () => {
    after.forEach((item, index) => {
      if (!isResult(item)) expect(item).toEqual(before[index])
    })
  })

  it('keeps every observation identifiable by id, call id, tool, status and exit code', () => {
    after.forEach((item, index) => {
      const original = before[index]!
      if (!isResult(item) || !isResult(original)) return
      expect({ id: item.id, callId: item.callId, name: item.name, status: item.status, exitCode: item.exitCode }).toEqual({
        id: original.id,
        callId: original.callId,
        name: original.name,
        status: original.status,
        exitCode: original.exitCode,
      })
    })
  })

  it('never lets a body, or a prefix or suffix of it, through a placeholder', () => {
    after.forEach((item, index) => {
      const original = before[index]!
      // An image's short text metadata is kept whole on purpose, so media observations are exempt.
      if (!isResult(item) || !isResult(original) || !item.masked || original.masked || original.media > 0) return
      const body = original.text ?? ''
      if (item.text === body) return
      for (const width of [12, 24]) {
        if (body.length <= width * 2) continue
        expect(item.text, `${item.id} prefix ${width}`).not.toContain(body.slice(0, width))
        expect(item.text, `${item.id} suffix ${width}`).not.toContain(body.slice(-width))
      }
    })
  })

  it('never makes a text observation larger, by the estimator the budget uses', () => {
    // Image observations are exempt: dropping the payload is the win, and the estimator only sees text.
    after.forEach((item, index) => {
      const original = before[index]!
      if (!isResult(item) || !isResult(original) || original.media > 0) return
      expect(estimateTokens(item.text ?? ''), item.id).toBeLessThanOrEqual(estimateTokens(original.text ?? ''))
    })
  })

  it('leaves no image payload behind, except in observations a host pruner already replaced', () => {
    after.forEach((item, index) => {
      const original = before[index]!
      if (isResult(item) && !(isResult(original) && original.masked)) expect(item.media, item.id).toBe(0)
    })
  })

  it('reports statistics that add up to what changed', () => {
    let changed = 0
    let omitted = 0
    after.forEach((item, index) => {
      const original = before[index]!
      if (!isResult(item) || !isResult(original) || item === original) return
      changed++
      // Text that travelled with an image as metadata is kept whole, so nothing of it was omitted.
      const body = original.text ?? ''
      if (body === '' || !(item.text ?? '').includes(body)) omitted += body.length
    })
    expect(stats).toEqual({ observationsMasked: changed, charsOmitted: omitted })
  })

  it('is idempotent: masking masked history changes nothing', () => {
    const boundary = { id: 'sentinel' }
    const again = maskSpan([...after, { id: 'sentinel', kind: 'user', text: 'retained' }], boundary)
    expect(again.items).toEqual(after)
    expect(again.stats).toEqual({ observationsMasked: 0, charsOmitted: 0 })
  })
})

describe('masking specific corpus shapes', () => {
  it('leaves tiny and empty observations verbatim, and masks the bulky ones', () => {
    const { items } = maskFixture(fixture('text-observations'))
    const results = items.filter(isResult)
    const verbatim = results.filter((item) => !item.masked)
    const masked = results.filter((item) => item.masked)
    expect(verbatim.length).toBeGreaterThan(0)
    expect(masked.length).toBeGreaterThan(0)
    for (const item of verbatim) expect(estimateTokens(item.text ?? '')).toBeLessThan(40)
  })

  it('keeps shell commands as tool calls and masks only their output, keeping exit codes', () => {
    const shell = fixture('shell-execution')
    const { items } = maskFixture(shell)
    const calls = items.filter((item) => item.kind === 'tool-call')
    expect(calls).toEqual(compacted(shell).filter((item) => item.kind === 'tool-call'))
    expect(calls.map((call) => (call as { args: string }).args).some((args) => args.includes('"command"'))).toBe(true)
    const failing = items.filter(isResult).find((item) => item.status === 'error' && item.masked)
    expect(failing?.text).toMatch(/exit \d+/)
  })

  it('drops image payloads and keeps their text metadata', () => {
    const { items } = maskFixture(fixture('image-observations'))
    const images = items.filter(isResult).filter((item) => item.name === 'screenshot' || item.name === 'read_image')
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(image.media).toBe(0)
      expect(image.text).toMatch(/\d+ images?/)
    }
    expect(images.some((image) => image.text?.includes('Screenshot captured (390x844, png).'))).toBe(true)
  })

  it('recognizes host-pruned observations and does not re-wrap them', () => {
    const pre = fixture('pre-masked')
    const { items } = maskFixture(pre)
    const flagged = compacted(pre).filter(isResult).filter((each) => each.masked)
    expect(flagged.length).toBeGreaterThan(0)
    for (const item of flagged) expect(items.find((each) => each.id === item.id)).toEqual(item)
    // Untouched observations in the same span are still masked: idempotence is not a bypass.
    const untouched = compacted(pre).filter(isResult).filter((each) => !each.masked && (each.text ?? '') !== '')
    expect(untouched.some((each) => (items.find((out) => out.id === each.id) as ToolResult).masked)).toBe(true)
  })

  it('keeps a split turn readable: the request and the actions stay, the retained suffix is not duplicated', () => {
    const split = fixture('split-turn')
    const { items } = maskFixture(split)
    expect(items[0]).toEqual(split.snapshot.items[0])
    const kinds = items.map((item) => item.kind)
    expect(kinds).toContain('tool-call')
    expect(kinds).toContain('assistant-reasoning')
    const retainedIds = split.snapshot.items.slice(boundaryIndex(split.snapshot)).map((item) => item.id)
    for (const id of retainedIds) expect(items.map((item) => item.id)).not.toContain(id)
    expect(items.filter(isResult).some((item) => item.masked)).toBe(true)
  })

  it('preserves large tool arguments and host-injected context', () => {
    const code = fixture('code-heavy')
    const args = compacted(code).filter((item) => item.kind === 'tool-call')
    expect(maskFixture(code).items.filter((item) => item.kind === 'tool-call')).toEqual(args)
    const host = fixture('host-context')
    const { items } = maskFixture(host)
    expect(items.filter((item) => item.kind === 'host-context')).toEqual(compacted(host).filter((item) => item.kind === 'host-context'))
  })

  it('shrinks the compacted span across the corpus, and by a lot where observations are bulky', () => {
    const totalBefore = corpus.reduce((total, each) => total + tokens(compacted(each)), 0)
    const totalAfter = corpus.reduce((total, each) => total + tokens(maskFixture(each).items), 0)
    expect(totalAfter).toBeLessThan(totalBefore / 2)
  })
})
