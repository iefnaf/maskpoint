/**
 * Maskpoint spike (issue #9): how may a MODEL-FREE masked replacement land in
 * DSH, and how may a Maskpoint backend be packaged?
 *
 * REFERENCE ONLY. This file is evidence for docs/spikes/dsh-model-free-replacement.md;
 * it is not part of this repository's build or tests and cannot run here.
 *
 * To reproduce: copy it to `packages/compaction/compaction-basic/tests/` in a
 * deepseek-harness checkout at commit 47f943859b (0.1.0-rc.5), install with
 * the pinned pnpm, then:
 *
 *   pnpm exec vitest run packages/compaction/compaction-basic/tests/maskpoint-spike.spec.ts --reporter=verbose
 *
 * Characterization, not production code. Every landing shape is run with DSH's
 * real session store, token meter, replay projections, and the session and
 * compaction invariant companions mounted. Those companions are the executable
 * form of the seam contract. DSH's test topologies mount them; a search of the
 * shipped bundle found no mount, so a shape rejected here is a contract
 * violation DSH's own CI would catch, not necessarily a runtime guard users hit.
 *
 * Landings are built from public entrypoints only (session append, token
 * meter, compaction seam), so what works here works from an out-of-tree
 * package. The exception is the type-only deep import of `SummaryResult` /
 * `SummarizationInput` from `dsh-compaction-basic/src/summarizer.ts`, which the
 * package root does not re-export.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, ToolResultMessage } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CompactionEngine, {
  CompactionId,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const MODEL = 'test-model'
const BODY = (n: number): string => `line of build output ${n}\n`.repeat(200)

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(CompactionInvariant)
  return ctx
}

/**
 * Three closed turns, each: user prompt, tool-call step producing one large
 * observation, closing assistant text. The last assistant message reports
 * provider usage so `measure().totalTokens` is anchored on a provider figure,
 * exactly as in a live session. `openTurn` leaves turn 4 open (an automatic
 * compaction runs inside the current turn); otherwise the session is idle.
 */
function conversation(ctx: Context, openTurn: boolean): { session: Session; observationSeqs: number[] } {
  const session = ctx.sessions.create(SessionId(openTurn ? 'spike-open' : 'spike-idle'))
  const observationSeqs: number[] = []
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `please run step ${turn} and report` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    const callId = CallId(`call-${turn}`)
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"cmd":"make"}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{"cmd":"make"}' })
    const result = session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: BODY(turn) }], isError: false }),
    }, { surfaceOp: 'append' })
    observationSeqs.push(result.seq)
    session.append('step/end', { turn, step: 1 })
    session.append('step/start', { turn, step: 2 })
    session.append('assistant/message', {
      turn,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `step ${turn} finished` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
      ...turn === 3 ? { usage: { inputTokens: 9_000, outputTokens: 40 } } : {},
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 2 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (openTurn) {
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'now compact and continue' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return { session, observationSeqs }
}

/** What DSH's token accounting says right now, from the three independent readers. */
function accounting(ctx: Context, session: Session): {
  /** `ctx.tokenMeter.measure().totalTokens`: the pressure figure compaction and the UI act on. */
  total: number
  /** `measure().surfaceTokens`: the priced-surface authority. */
  surface: number
  /** `contextBreakdown` replay projection (O(1) shadow-price fold). */
  breakdownMessages: number
  /** `contextPressure` replay projection: usage sample carried forward by surface movement. */
  projected: number | undefined
} {
  const measured = ctx.tokenMeter.measure(session)
  const values = ctx.sessionProjections.snapshot(session).values
  return {
    total: measured.totalTokens,
    surface: measured.surfaceTokens,
    breakdownMessages: values.contextBreakdown.messageTokens,
    projected: values.contextPressure.projectedTokens,
  }
}

/** Event types appended since `from`, with replacements marked, for exact-sequence assertions. */
function sequence(session: Session, from: number): string[] {
  return session.events.slice(from).map((event) => {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    const replace = typeof op === 'object' && op !== null ? '(replace)' : ''
    return `${event.type}${replace}`
  })
}

/** Placeholder rule: tool, status, size omitted; never any of the body. */
function placeholderFor(message: ToolResultMessage): string {
  const block = message.content[0]
  const body = block.content.map(part => part.type === 'text' ? part.text : '').join('')
  return `[observation masked: bash, ${block.isError === true ? 'error' : 'ok'}, `
    + `${body.split('\n').length} lines, ${body.length} chars omitted]`
}

/** The balanced span from the first surface node through the last node of closed turn 3. */
function closedRegion(session: Session): { start: number; end: number; seqs: number[] } {
  const turn4 = session.events.find(e => e.type === 'turn/start' && e.data.turn === 4)
  const limit = turn4?.seq ?? session.events.length
  const seqs = session.surface.nodes.filter(seq => seq < limit)
  return { start: seqs[0]!, end: seqs.at(-1)!, seqs }
}

// ---------------------------------------------------------------------------
// landing shapes under test
// ---------------------------------------------------------------------------

/**
 * SHAPE A1 — the host's model-free protocol, verbatim: per observation, a
 * `compaction/prune` shadow price immediately followed by a content-only
 * `tool/result` replacement citing the shadowed node. Applies Maskpoint's
 * no-expansion rule with the meter's own estimator.
 */
function landInPlaceMask(ctx: Context, session: Session, seqs: readonly number[]): number[] {
  const landed: number[] = []
  for (const seq of seqs) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    const original = event.data.message
    const block = original.content[0]
    const masked = freezeMessage<ToolResultMessage>({
      ...original,
      content: [{ ...block, content: [{ type: 'text', text: placeholderFor(original) }] }] as [typeof block],
    })
    if (ctx.tokenMeter.estimateMessage(masked) >= ctx.tokenMeter.estimateMessage(original)) continue
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
    })
    landed.push(session.append('tool/result', { ...event.data, message: masked }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    }).seq)
  }
  return landed
}

interface RegionShape {
  /** Wrap in `compaction/start` … `compaction/end`. */
  bracket: boolean
  /** Use the seam's checkpoint provenance on the replacement `user/message`. */
  checkpointSource: boolean
  /** Owning turn for the bracket (null = idle/standalone). */
  turn: number | null
}

/**
 * SHAPES A2–A4 — a region-level model-free replacement: one `user/message`
 * replacing a balanced span, priced by `compaction/prune` instead of
 * `compaction/summary`. The variants differ only in what surrounds it.
 */
function landRegionWithPrune(ctx: Context, session: Session, shape: RegionShape): { start: number; end: number } {
  const { start, end, seqs } = closedRegion(session)
  const priced = ctx.tokenMeter.measure(session).nodes.filter(node => seqs.includes(node.seq))
  const compactionId = CompactionId('spike-region')
  if (shape.bracket) session.append('compaction/start', { compactionId, turn: shape.turn })
  session.append('compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: [...seqs],
    shadowedTokenCount: priced.reduce((total, node) => total + node.tokens, 0),
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[masked history: 3 user prompts, 3 bash calls, 3 observations masked]' }],
    source: shape.checkpointSource ? compactCheckpointSource(compactionId) : { kind: 'plugin', plugin: 'maskpoint-spike' },
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [...seqs],
  })
  if (shape.bracket) session.append('compaction/end', { compactionId, turn: shape.turn })
  return { start, end }
}

/** SHAPE B — the summary path with a Maskpoint envelope and NO `llmStreamCall` marker. */
class MaskOnlySummaryEngine extends BasicCompactionEngine {
  protected override summarize(input: SummarizationInput): Promise<SummaryResult> {
    const lines = input.messages.map((message) => {
      const parts = message.content.map((block) => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool-call') return `${block.name}(${block.arguments})`
        if (block.type === 'tool-result') return '[observation masked]'
        return ''
      })
      return `${message.role}: ${parts.join(' ')}`
    })
    return Promise.resolve({
      summary: [{ type: 'text', text: lines.join('\n') }],
      provider: 'maskpoint',
      model: 'mask-only',
    })
  }
}

/**
 * After a checkpoint-provenance landing, all three readers agree and each moved by exactly
 * the priced delta (replacement minus shadowed). Returns the replacement's price.
 */
function expectExactCheckpointLanding(
  ctx: Context,
  session: Session,
  before: ReturnType<typeof accounting>,
  result: CompactionResult,
): number {
  const checkpoint = session.events.findLast(e => e.type === 'user/message' && isCompactCheckpointSource(e.data.source))!
  const replacement = ctx.tokenMeter.measure(session).nodes.find(node => node.seq === checkpoint.seq)!.tokens
  const delta = replacement - result.shadowedTokenCount
  const after = accounting(ctx, session)
  expect(after.breakdownMessages).toBe(after.surface)
  expect(after.surface).toBe(before.surface + delta)
  expect(after.total).toBe(before.total + delta)
  expect(after.projected).toBe(before.projected! + delta)
  expect(after.total).toBeLessThan(before.total)
  return replacement
}

function agentFor(session: Session): never {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  } as never
}

// ---------------------------------------------------------------------------
// UNKNOWN 1 — durable representation of a model-free masked replacement
// ---------------------------------------------------------------------------

describe('Unknown 1: landing shapes for a model-free masked replacement', () => {
  it('A1 in-place prune protocol inside an open turn: legal, honest, and accounting stays exact', async () => {
    const ctx = await harness()
    const { session, observationSeqs } = conversation(ctx, true)
    const before = accounting(ctx, session)
    const generation = session.surface.replaceGeneration
    const shadowed = ctx.tokenMeter.measure(session).nodes
      .filter(node => observationSeqs.includes(node.seq)).reduce((sum, node) => sum + node.tokens, 0)
    const pairingBefore = session.surface.nodes.map(seq => [
      toolPairingBalancedBefore(session, seq), toolPairingBalancedAfter(session, seq)])
    const messagesBefore = session.deriveMessages()
    const from = session.events.length

    const landed = landInPlaceMask(ctx, session, observationSeqs)

    expect(landed).toHaveLength(3)
    // Exact event sequence: one shadow price then one replacement, per observation, no bracket.
    expect(sequence(session, from)).toEqual([
      'compaction/prune', 'tool/result(replace)',
      'compaction/prune', 'tool/result(replace)',
      'compaction/prune', 'tool/result(replace)',
    ])
    const replacementTokens = ctx.tokenMeter.measure(session).nodes
      .filter(node => landed.includes(node.seq)).reduce((sum, node) => sum + node.tokens, 0)
    const after = accounting(ctx, session)
    // Replay accounting: all three readers agree, and the total moved by exactly the priced delta.
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.surface).toBe(before.surface - shadowed + replacementTokens)
    expect(after.total).toBe(before.total - shadowed + replacementTokens)
    expect(after.projected).toBe(before.projected! - shadowed + replacementTokens)
    expect(after.total).toBeLessThan(before.total)
    console.log(`[spike] A1 total ${before.total} -> ${after.total}; shadowed ${shadowed}, replacement ${replacementTokens}; `
      + `surface ${before.surface} -> ${after.surface}; breakdown ${before.breakdownMessages} -> ${after.breakdownMessages}`)
    // The reduction is durable proof for overflow-retry (`replaceGeneration` advances).
    expect(session.surface.replaceGeneration).toBeGreaterThan(generation)
    // Pairing is untouched: same node count, and every balanced-boundary predicate has the same answer.
    // (Mid-step nodes are legitimately unbalanced; masking must not change which ones are.)
    const pairingAfter = session.surface.nodes.map(seq => [
      toolPairingBalancedBefore(session, seq), toolPairingBalancedAfter(session, seq)])
    expect(session.surface.nodes).toHaveLength(pairingBefore.length)
    expect(pairingAfter).toEqual(pairingBefore)
    expect(pairingAfter.some(([, after]) => after === true)).toBe(true)
    expect(pairingAfter.some(([, after]) => after === false)).toBe(true)
    // Nothing but the observation bodies changed: every other model-visible message is deep-equal.
    const messagesAfter = session.deriveMessages()
    expect(messagesAfter).toHaveLength(messagesBefore.length)
    let changed = 0
    messagesAfter.forEach((message, index) => {
      const isObservation = message.content[0]?.type === 'tool-result'
      if (isObservation) {
        changed += 1
        expect(JSON.stringify(message)).toContain('[observation masked: bash, ok, 201 lines')
        expect(JSON.stringify(message)).not.toContain('line of build output')
      } else {
        expect(message).toEqual(messagesBefore[index])
      }
    })
    expect(changed).toBe(3)
  })

  it('A1 outside any open turn (idle `compactNow`): rejected by the session invariant', async () => {
    const ctx = await harness()
    const { session, observationSeqs } = conversation(ctx, false)
    expect(() => landInPlaceMask(ctx, session, observationSeqs)).toThrow(/outside any open turn/)
  })

  it.each([
    ['open turn', true, 4],
    ['idle', false, null],
  ] as const)('A2 (%s) region replacement, checkpoint provenance, bracket, prune instead of summary: rejected at compaction/end after the surface already changed', async (_label, open, turn) => {
    const ctx = await harness()
    const { session } = conversation(ctx, open)
    const generation = session.surface.replaceGeneration
    expect(() => landRegionWithPrune(ctx, session, { bracket: true, checkpointSource: true, turn }))
      .toThrow(/successful compaction\/end requires one compaction\/summary/)
    // The replacement had already committed: this is a partial mutation with an unclosed lock.
    expect(session.surface.replaceGeneration).toBeGreaterThan(generation)
    const tail = sequence(session, session.events.length - 3)
    expect(tail).toEqual(['compaction/start', 'compaction/prune', 'user/message(replace)'])
  })

  it.each([
    ['open turn', true],
    ['idle', false],
  ] as const)('A3 (%s) region replacement, checkpoint provenance, no bracket: rejected before it lands', async (_label, open) => {
    const ctx = await harness()
    const { session } = conversation(ctx, open)
    const generation = session.surface.replaceGeneration
    expect(() => landRegionWithPrune(ctx, session, { bracket: false, checkpointSource: true, turn: null }))
      .toThrow(/compaction checkpoint has no matching compaction\/start/)
    expect(session.surface.replaceGeneration).toBe(generation)
  })

  it('A4 region replacement, plain user message, no bracket: accounting is exact but it is not a compaction checkpoint', async () => {
    const ctx = await harness()
    const { session } = conversation(ctx, true)
    const before = accounting(ctx, session)
    const from = session.events.length
    landRegionWithPrune(ctx, session, { bracket: false, checkpointSource: false, turn: null })
    expect(sequence(session, from)).toEqual(['compaction/prune', 'user/message(replace)'])
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.total).toBeLessThan(before.total)
    // Lands, but outside the seam contract: no lock, and consumers cannot recognise it.
    const replacement = session.events.at(-1)!
    expect(replacement.type === 'user/message' && isCompactCheckpointSource(replacement.data.source)).toBe(false)
    expect(session.events.some(e => e.type === 'compaction/start')).toBe(false)
  })

  it('B summary path, unmarked, Maskpoint envelope, inside an open turn: legal through the real backend, accounting exact', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskOnlySummaryEngine, { auto: false })
    const { session } = conversation(ctx, true)
    const before = accounting(ctx, session)
    const from = session.events.length
    const { start, end } = closedRegion(session)

    const result: CompactionResult = await ctx.compaction.compactRegion(start, end, agentFor(session))

    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])
    const summary = session.events[result.summarySeq]!
    if (summary.type !== 'compaction/summary') throw new Error('expected compaction/summary')
    expect(summary.data.llmStreamCall).toBeUndefined()
    expect(summary.data.usage).toBeUndefined()
    expect({ provider: summary.data.provider, model: summary.data.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    const checkpointTokens = expectExactCheckpointLanding(ctx, session, before, result)
    const after = accounting(ctx, session)
    console.log(`[spike] B total ${before.total} -> ${after.total}; shadowed ${result.shadowedTokenCount}, replacement ${checkpointTokens}; `
      + `surface ${before.surface} -> ${after.surface}; breakdown ${before.breakdownMessages} -> ${after.breakdownMessages}`)
  })

  it('B summary path, unmarked, idle `compactNow`: the only shape that lands between turns and returns a CompactionResult', async () => {
    const ctx = await harness()
    await ctx.plugin(MaskOnlySummaryEngine, { auto: false })
    const { session } = conversation(ctx, false)
    const before = accounting(ctx, session)
    const from = session.events.length

    const result = await ctx.compaction.compactNow(agentFor(session), new AbortController().signal)

    expect(result).not.toBeNull()
    expect(sequence(session, from)).toEqual(['compaction/start', 'compaction/summary', 'user/message(replace)', 'compaction/end'])
    const start = session.events[result!.startSeq]!
    expect(start.type === 'compaction/start' && start.data.turn === null).toBe(true)
    expectExactCheckpointLanding(ctx, session, before, result!)
  })

  it('negative control: a replacement with NO shadow price makes replay accounting drift', async () => {
    const ctx = await harness()
    const { session, observationSeqs } = conversation(ctx, true)
    const before = accounting(ctx, session)
    const seq = observationSeqs[0]!
    const event = session.events[seq]
    if (event?.type !== 'tool/result') throw new Error('fixture')
    const original = event.data.message
    const block = original.content[0]
    session.append('tool/result', {
      ...event.data,
      message: freezeMessage<ToolResultMessage>({
        ...original,
        content: [{ ...block, content: [{ type: 'text', text: placeholderFor(original) }] }] as [typeof block],
      }),
    }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
    const after = accounting(ctx, session)
    // The meter (priced surface) shrank; the O(1) projection folded neutrally and still counts the old body.
    expect(after.surface).toBeLessThan(before.surface)
    expect(after.breakdownMessages).toBeGreaterThan(after.surface)
  })
})

// ---------------------------------------------------------------------------
// UNKNOWN 2 — packaging: in-tree sibling or external package
// ---------------------------------------------------------------------------

/** An out-of-tree-shaped backend: public seam entrypoints only, distinct package name. */
class MaskpointDshEngine extends CompactionEngine {
  compactIfNeeded(): Promise<CompactionResult | null> { return Promise.resolve(null) }
  compactNow(): Promise<CompactionResult | null> { return Promise.resolve(null) }
  compactRegion(): Promise<CompactionResult> { return Promise.reject(new Error('spike stub')) }
}

/** Mount the base bundle's compaction rows through the real Loader, with optional id-targeted patches. */
async function mountRows(patches: readonly Record<string, unknown>[]): Promise<{ context: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'maskpoint-spike-'))
  const context = new Context()
  const configPath = join(root, 'cordis.yml')
  // Same ids and names as packages/bundle/base/cordis.patch.yml.
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: token-meter',
    "  name: '@deepseek-ai/dsh-token-meter'",
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    auto: false',
    '',
  ].join('\n'))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
    ['maskpoint-dsh', MaskpointDshEngine],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await context.loader.await()
  return { context, root }
}

describe('Unknown 2: packaging', () => {
  it('control: the unpatched base rows mount the in-tree backend', async () => {
    const { context, root } = await mountRows([])
    try {
      expect(context.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a patch `name` is only a guard: it cannot retarget the row, so the built-in stays mounted', async () => {
    const { context, root } = await mountRows([{ id: 'compaction-basic', name: 'maskpoint-dsh' }])
    try {
      expect(context.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disabling the built-in row and inserting an external one mounts the external package as `ctx.compaction`', async () => {
    const { context, root } = await mountRows([
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
      { insert: [{ id: 'maskpoint', name: 'maskpoint-dsh' }] },
    ])
    try {
      expect(context.get('compaction')).toBeInstanceOf(MaskpointDshEngine)
      expect(context.get('compaction')).not.toBeInstanceOf(BasicCompactionEngine)
    } finally {
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('one backend per context: adding an external backend BESIDE the built-in one is rejected, so it must replace the row', async () => {
    const ctx = await harness()
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await expect(ctx.plugin(MaskpointDshEngine)).rejects.toThrow(/service "compaction" has been registered at <BasicCompactionEngine>/)
  })
})
