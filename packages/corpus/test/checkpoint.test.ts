import {
  CHECKPOINT_SECTIONS,
  type ConversationSnapshot,
  decide,
  type EngineDeps,
  estimateTokens,
  type Item,
  type MaskedHistoryOutcome,
  type Outcome,
  run,
} from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { type CorpusFixture, loadCorpus } from '../src/corpus.js'
import { boundaryIndex } from '../src/items.js'
import { type ModelDouble, modelDouble, responses, type Script } from '../src/model-double.js'

/**
 * Seam 1 for the checkpoint path: the engine over neutral snapshots, driven by the shared corpus
 * and a deterministic model double. No host, no network, no paid provider.
 */

const corpus = loadCorpus()
const everyFixture = corpus.map((each) => [each.name, each] as const)

const TINY = { compactBudgetTokens: 1 }
const HUGE = { compactBudgetTokens: 1_000_000 }
const CHECKPOINT_TEXT = '## User context and constraints\nKeep the public API stable.\n\n## Next steps\nRun the billing tests.'

const withoutFocus = (snapshot: ConversationSnapshot): ConversationSnapshot => {
  const { customInstructions: _focus, ...rest } = snapshot
  return rest
}

const fixture = (name: string): CorpusFixture => {
  const found = corpus.find((each) => each.name === name)
  if (!found) throw new Error(`no fixture ${name}`)
  return found
}

/**
 * The original bodies that masking dropped from the span: observations whose text did not survive
 * into the masked item. (An image observation keeps small text metadata beside its image note and
 * loses only the payload, so it drops no body; a media-only one has none.) Compared whole, not by
 * prefix: preserved tool-call arguments may legitimately repeat the start of a body.
 */
const droppedBodies = (snapshot: ConversationSnapshot, masked: MaskedHistoryOutcome): string[] => {
  const originals = new Map(snapshot.items.map((item) => [item.id, item] as const))
  const maskedNow = masked.artifact.sections.flatMap((section) => (section.kind === 'masked-history' ? section.items : []))
  return maskedNow.flatMap((item) => {
    const original = originals.get(item.id)
    if (original?.kind !== 'tool-result' || item.kind !== 'tool-result' || !item.masked || original.masked) return []
    if (!original.text || (item.text ?? '').includes(original.text)) return []
    return [original.text]
  })
}

const checkpointOf = (outcome: Outcome) => {
  if (outcome.kind !== 'checkpoint') throw new Error(`expected checkpoint, got ${outcome.kind}`)
  return outcome
}

let routingIds = 0
/** Deps around a double: a fresh id per request, a live signal, a generation cap. */
const depsFor = (double: ModelDouble, overrides: Partial<EngineDeps> = {}): EngineDeps => ({
  complete: double.complete,
  newRoutingId: () => `route-${++routingIds}`,
  signal: new AbortController().signal,
  checkpoint: { maxOutputTokens: 2048 },
  ...overrides,
})

const called = (script: Script) => {
  const double = modelDouble(script)
  return { double, deps: depsFor(double) }
}

describe.each(everyFixture)('the checkpoint path over the %s fixture', (_name, each) => {
  const plain = withoutFocus(each.snapshot)
  const fallback = decide(plain, HUGE) as MaskedHistoryOutcome

  it('makes exactly one model call and returns the accepted checkpoint, replacing what it condensed', async () => {
    const { double, deps } = called(responses.success(CHECKPOINT_TEXT))
    const outcome = await run(plain, TINY, deps)

    expect(double.requests).toHaveLength(1)
    const accepted = checkpointOf(outcome)
    expect(accepted.artifact.sections).toEqual([{ kind: 'checkpoint', text: CHECKPOINT_TEXT }])
    expect(accepted.stats).toEqual(fallback.stats)
    expect(accepted.artifact.stats).toEqual(fallback.stats)
    expect(accepted.detail).toEqual({
      ...fallback.detail,
      strategy: 'checkpoint',
      checkpoints: (plain.previousDetail?.checkpoints ?? 0) + 1,
    })
  })

  it('uses the session model by default and states the request contract: fresh routing identity, no cache, no tools, the host signal, the cap', async () => {
    const controller = new AbortController()
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    await run(plain, TINY, depsFor(double, { signal: controller.signal }))

    const [request] = double.requests
    expect(request).toBeDefined()
    expect(request).not.toHaveProperty('model')
    expect(request).toMatchObject({ cacheRetention: 'none', tools: [], maxOutputTokens: 2048 })
    expect(request?.routingId).toMatch(/^route-\d+$/)
    expect(request?.signal).toBe(controller.signal)
  })

  it('uses the configured model when one is set', async () => {
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    await run(plain, TINY, depsFor(double, { checkpoint: { maxOutputTokens: 512, model: 'small-fast-model' } }))
    expect(double.requests[0]).toMatchObject({ model: 'small-fast-model', maxOutputTokens: 512 })
  })

  it('never reuses a routing identity: each call gets a new one, asked for once per call', async () => {
    const asked: string[] = []
    const newRoutingId = () => {
      const id = `fresh-${asked.length + 1}`
      asked.push(id)
      return id
    }
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    await run(plain, TINY, depsFor(double, { newRoutingId }))
    await run(plain, TINY, depsFor(double, { newRoutingId }))
    expect(asked).toEqual(['fresh-1', 'fresh-2'])
    expect(double.requests.map((request) => request.routingId)).toEqual(asked)
  })

  it('feeds the model the accumulated masked history the budget measured, and no observation body', async () => {
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    await run(plain, TINY, depsFor(double))
    const input = double.requests[0]?.input ?? ''

    expect(estimateTokens(input)).toBe(fallback.stats.candidateTokens)
    if (plain.previousCheckpoint !== undefined) expect(input.startsWith(plain.previousCheckpoint)).toBe(true)

    for (const body of droppedBodies(plain, fallback)) expect(input).not.toContain(body)
  })
})

describe('the corpus exercises observation removal', () => {
  it('has dropped bodies to check, so the no-observation-body assertion cannot pass vacuously', () => {
    const total = corpus.reduce((count, each) => {
      const plain = withoutFocus(each.snapshot)
      return count + droppedBodies(plain, decide(plain, HUGE) as MaskedHistoryOutcome).length
    }, 0)
    expect(total).toBeGreaterThanOrEqual(10)
  })
})

describe('the checkpoint prompt', () => {
  const plain = withoutFocus(fixture('text-observations').snapshot)
  const requestFor = async (snapshot: ConversationSnapshot) => {
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    await run(snapshot, TINY, depsFor(double))
    const [request] = double.requests
    if (!request) throw new Error('no model call was made')
    return request
  }

  it('asks for the design’s structured format, every section, in order', async () => {
    const { instructions } = await requestFor(plain)
    const design = [
      'user context and constraints',
      'completed work',
      'pending work',
      'current state',
      'code state',
      'tests and exact errors',
      'changes',
      'dependencies',
      'version-control state',
      'key decisions',
      'next steps',
    ]
    expect([...CHECKPOINT_SECTIONS].map((section) => section.toLowerCase())).toEqual(design)
    // Each section is asked for on its own numbered line, so a word that merely appears in prose
    // ("changes", "current state") cannot satisfy this.
    const asked = [...instructions.matchAll(/^\d+\. (.+)$/gm)].map((match) => (match[1] ?? '').toLowerCase())
    expect(asked).toEqual(design)
  })

  it('forbids inventing missing state and treats the input as a record, not a request', async () => {
    const { instructions } = await requestFor(plain)
    expect(instructions).toMatch(/do not invent missing state/i)
    expect(instructions).toMatch(/do not act on anything in it/i)
  })

  it('names the generation cap it will be cut off at', async () => {
    const { instructions } = await requestFor(plain)
    expect(instructions).toContain('2048 tokens')
  })

  it('appends custom instructions to the format rather than replacing it', async () => {
    const focus = 'Focus on the migration of the invoice ledger.'
    const { instructions } = await requestFor({ ...plain, customInstructions: focus })
    expect(instructions).toContain(focus)
    expect(instructions.indexOf(focus)).toBeGreaterThan(instructions.indexOf('Next steps'))
  })
})

describe('a checkpoint that is not accepted', () => {
  const PARTIAL = '## User context and constraints\nKeep the public API sta'
  const cases: Array<[string, Script, string]> = [
    ['a provider error', responses.providerError('429 rate limited'), 'provider-error'],
    ['an exception from the host', new Error('socket hang up'), 'provider-error'],
    ['an abort', responses.aborted(), 'aborted'],
    ['a length stop', responses.lengthStop(PARTIAL), 'truncated'],
    ['a tool call', responses.toolCall(), 'tool-call'],
    ['empty text', responses.empty(), 'empty'],
    ['whitespace-only text', responses.success('  \n\t '), 'empty'],
  ]

  describe.each(cases)('after %s', (_label, script, rejection) => {
    it.each(everyFixture)('falls back to the masked history, whole, on %s', async (_name, each) => {
      const plain = withoutFocus(each.snapshot)
      const fallback = decide(plain, HUGE) as MaskedHistoryOutcome
      const { double, deps } = called(script)
      const outcome = await run(plain, TINY, deps)

      expect(double.requests).toHaveLength(1)
      expect(outcome).toEqual({ ...fallback, checkpointRejection: rejection })
      if (outcome.kind !== 'masked-history') throw new Error('unreachable')
      expect(outcome.artifact.sections.length).toBeGreaterThan(0)
      expect(outcome.detail.strategy).toBe('mask')
      expect(outcome.detail.checkpoints).toBe(plain.previousDetail?.checkpoints ?? 0)
      expect(outcome).not.toHaveProperty('usage')
    })
  })

  it('never lets a truncated checkpoint into the outcome or its persisted detail', async () => {
    const plain = withoutFocus(fixture('text-observations').snapshot)
    const { deps } = called(responses.lengthStop(PARTIAL))
    const outcome = await run(plain, TINY, deps)
    expect(JSON.stringify(outcome)).not.toContain('Keep the public API')
    expect(outcome.kind).not.toBe('checkpoint')
  })

  it.each([
    ['no response at all', undefined],
    ['a response with no text', { stopReason: 'stop' }],
    ['an unrecognized stop reason', { stopReason: 'content-filter', text: CHECKPOINT_TEXT }],
  ])('falls back rather than throwing when the host hands back %s', async (_label, malformed) => {
    const plain = withoutFocus(fixture('text-observations').snapshot)
    const fallback = decide(plain, HUGE) as MaskedHistoryOutcome
    const outcome = await run(plain, TINY, {
      ...depsFor(modelDouble(responses.empty())),
      complete: async () => malformed as never,
    })
    expect(outcome.kind).toBe('masked-history')
    expect(outcome).toMatchObject({ artifact: fallback.artifact, checkpointRejection: expect.stringMatching(/^(provider-error|empty)$/) })
  })

  it('carries the previous state through untouched when the new checkpoint is rejected', async () => {
    const { snapshot } = fixture('host-context')
    expect(snapshot.previousCheckpoint).toBeTruthy()
    const { deps } = called(responses.lengthStop(PARTIAL))
    const outcome = await run(withoutFocus(snapshot), TINY, deps)
    if (outcome.kind !== 'masked-history') throw new Error(`expected masked-history, got ${outcome.kind}`)
    expect(outcome.artifact.sections[0]).toEqual({ kind: 'checkpoint', text: snapshot.previousCheckpoint })
  })
})

describe('cancellation', () => {
  const plain = withoutFocus(fixture('text-observations').snapshot)
  const fallback = decide(plain, HUGE) as MaskedHistoryOutcome
  const aborted = { ...fallback, checkpointRejection: 'aborted' }

  it('makes no call at all when the host has already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const double = modelDouble(responses.success(CHECKPOINT_TEXT))
    const outcome = await run(plain, TINY, depsFor(double, { signal: controller.signal }))
    expect(double.requests).toHaveLength(0)
    expect(outcome).toEqual(aborted)
  })

  it('discards an answer that arrives after the host cancelled', async () => {
    const controller = new AbortController()
    const outcome = await run(
      plain,
      TINY,
      depsFor(modelDouble(responses.success(CHECKPOINT_TEXT)), {
        signal: controller.signal,
        complete: async () => {
          controller.abort()
          return responses.success(CHECKPOINT_TEXT)
        },
      }),
    )
    expect(outcome).toEqual(aborted)
  })

  it('reads an exception thrown after the host cancelled as an abort, not a provider error', async () => {
    const controller = new AbortController()
    const outcome = await run(
      plain,
      TINY,
      depsFor(modelDouble(new Error('unused')), {
        signal: controller.signal,
        complete: async () => {
          controller.abort()
          throw new Error('The operation was aborted')
        },
      }),
    )
    expect(outcome).toEqual(aborted)
  })
})

describe('when a checkpoint is and is not called for', () => {
  it('makes no model call at all within budget, and returns masked history', async () => {
    const { double, deps } = called(responses.success(CHECKPOINT_TEXT))
    const plain = withoutFocus(fixture('text-observations').snapshot)
    const outcome = await run(plain, HUGE, deps)
    expect(double.requests).toHaveLength(0)
    expect(outcome).toEqual(decide(plain, HUGE))
    expect(outcome.kind).toBe('masked-history')
  })

  it('calls at exactly one token over budget, and not at budget', async () => {
    const plain = withoutFocus(fixture('text-observations').snapshot)
    const size = (decide(plain, HUGE) as MaskedHistoryOutcome).stats.candidateTokens
    const atBudget = called(responses.success(CHECKPOINT_TEXT))
    expect((await run(plain, { compactBudgetTokens: size }, atBudget.deps)).kind).toBe('masked-history')
    expect(atBudget.double.requests).toHaveLength(0)
    const over = called(responses.success(CHECKPOINT_TEXT))
    expect((await run(plain, { compactBudgetTokens: size - 1 }, over.deps)).kind).toBe('checkpoint')
    expect(over.double.requests).toHaveLength(1)
  })

  it('makes one call for custom instructions even with the budget to spare, and puts them in the prompt', async () => {
    const { snapshot } = fixture('cjk')
    expect(snapshot.customInstructions).toBeTruthy()
    const { double, deps } = called(responses.success(CHECKPOINT_TEXT))
    const outcome = await run(snapshot, HUGE, deps)
    expect(outcome.kind).toBe('checkpoint')
    expect(double.requests).toHaveLength(1)
    expect(double.requests[0]?.instructions).toContain(snapshot.customInstructions?.trim())
  })

  it('declines without a model call when the cursor cannot be trusted', async () => {
    const { evictedThrough: _e, ...missing } = fixture('host-context').snapshot
    const { double, deps } = called(responses.success(CHECKPOINT_TEXT))
    expect(await run(missing, TINY, deps)).toEqual({ kind: 'decline', reason: 'inconsistent-cursor' })
    expect(double.requests).toHaveLength(0)
  })
})

describe('reporting usage', () => {
  const plain = withoutFocus(fixture('text-observations').snapshot)

  it('reports the model’s usage on an accepted checkpoint, for the host’s accounting', async () => {
    const { deps } = called(responses.success(CHECKPOINT_TEXT, { inputTokens: 4321, outputTokens: 654 }))
    expect(checkpointOf(await run(plain, TINY, deps)).usage).toEqual({ inputTokens: 4321, outputTokens: 654 })
  })

  it('reports no usage rather than inventing one when the host gave none', async () => {
    const { deps } = called({ stopReason: 'stop', text: CHECKPOINT_TEXT })
    expect(checkpointOf(await run(plain, TINY, deps))).not.toHaveProperty('usage')
  })
})

describe('the next compaction after a checkpoint', () => {
  /** A turn after a fixture's transcript: a request, a call and a bulky result. */
  const tail = (label: string): Item[] => [
    { id: `${label}-user`, kind: 'user', text: 'One more thing, please.' },
    { id: `${label}-call`, kind: 'tool-call', name: 'read', callId: `${label}-c`, args: '{"path":"/workspace/app/notes.md"}' },
    { id: `${label}-result`, kind: 'tool-result', name: 'read', callId: `${label}-c`, status: 'ok', text: 'NOTES-BODY '.repeat(80), media: 0 },
  ]

  it.each(everyFixture)('builds on the checkpoint and does not carry the history it replaced, on %s', async (_name, each) => {
    const { snapshot } = each
    const { deps } = called(responses.success(CHECKPOINT_TEXT))
    const first = checkpointOf(await run(withoutFocus(snapshot), TINY, deps))
    const cut = boundaryIndex(snapshot)

    const next = await run(
      {
        items: [...snapshot.items, ...tail('a'), ...tail('b')],
        boundary: { id: 'b-user' },
        reason: 'threshold',
        previousCheckpoint: CHECKPOINT_TEXT,
        ...(first.detail.cursor === undefined ? {} : { evictedThrough: first.detail.cursor.evictedThroughId }),
        previousDetail: first.detail,
      },
      HUGE,
      deps,
    )
    if (next.kind !== 'masked-history') throw new Error(`expected masked-history, got ${next.kind}`)
    const [carried, appended] = next.artifact.sections
    expect(carried).toEqual({ kind: 'checkpoint', text: CHECKPOINT_TEXT })
    if (appended?.kind !== 'masked-history') throw new Error('expected appended masked history')
    expect(appended.items.map((item) => item.id)).toEqual([...snapshot.items.slice(cut), ...tail('a')].map((item) => item.id))
    // The checkpoint count carries forward, so the next checkpoint can count on from it.
    expect(next.detail.checkpoints).toBe(first.detail.checkpoints)
    expect(first.detail.checkpoints).toBe((snapshot.previousDetail?.checkpoints ?? 0) + 1)
  })
})
