/**
 * Seam 2 harness for the DSH adapter: real DSH session store, token meter, replay projections, and
 * the session and compaction invariant companions. Those companions are the executable form of the
 * host's seam contract (a shipped host does not mount them, see docs/spikes), so every test here
 * runs with them: a landing that violates the contract fails loudly instead of landing silently.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'

export const MODEL = 'test-model'

/** A model route that only reports its context window: compaction never calls a model here. */
class WindowAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  // eslint-disable-next-line require-yield
  override async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('the masking path must never call a model')
  }
}

export async function harness(contextWindow = 10_000): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(CompactionInvariant)
  ctx.llm.registerAdapter([MODEL], new WindowAdapter(contextWindow))
  return ctx
}

export const observationBody = (n: number): string => `line of build output ${n}\n`.repeat(200)

/**
 * One closed turn: prompt, a `bash` call with one observation of `body`, and a closing message.
 * Returns the observation's seq. `usage` anchors the meter's total on a provider figure.
 */
export function appendClosedTurn(
  session: Session,
  turn: number,
  body: string | ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number },
  options: { isError?: boolean; name?: string } = {},
): number {
  const name = options.name ?? 'bash'
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `please run step ${turn} and report` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
  }
  const callId = CallId(`call-${turn}`)
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: '{"cmd":"make"}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name, arguments: '{"cmd":"make"}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: typeof body === 'string' ? [{ type: 'text', text: body }] : body,
      isError: options.isError === true,
    }),
  }, { surfaceOp: 'append' })
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
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

export interface Conversation {
  session: Session
  /** Surface seqs of the tool observations, in order. */
  observationSeqs: number[]
}

/**
 * Three closed turns, each a user prompt, one tool call producing one large observation, and a
 * closing assistant message. The last message reports provider usage so the meter's total is
 * anchored on a provider figure as in a live session. `openTurn` leaves a fourth turn open (where
 * automatic compaction runs); otherwise the session is idle (where manual compaction runs).
 */
export function conversation(ctx: Context, options: { openTurn: boolean; body?: (n: number) => string } = { openTurn: false }): Conversation {
  const body = options.body ?? observationBody
  const session = ctx.sessions.create(SessionId(options.openTurn ? 'open' : 'idle'))
  const observationSeqs: number[] = []
  for (let turn = 1; turn <= 3; turn += 1) {
    observationSeqs.push(appendClosedTurn(session, turn, body(turn), turn === 3 ? { inputTokens: 9_000, outputTokens: 40 } : undefined))
  }
  if (options.openTurn) {
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'now compact and continue' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return { session, observationSeqs }
}

/** What the host's token accounting says right now, from its independent readers. */
export interface Accounting {
  /** `measure().totalTokens`: the pressure figure compaction and the UI act on. */
  total: number
  /** `measure().surfaceTokens`: the priced-surface authority. */
  surface: number
  /** `contextBreakdown` replay projection (the O(1) shadow-price fold). */
  breakdownMessages: number
  /** `contextPressure` replay projection: the usage sample carried forward by surface movement. */
  projected: number | undefined
}

export function accounting(ctx: Context, session: Session): Accounting {
  const measured = ctx.tokenMeter.measure(session)
  const { contextBreakdown, contextPressure } = ctx.sessionProjections.snapshot(session).values
  if (contextBreakdown === undefined || contextPressure === undefined) throw new Error('replay projections are not mounted')
  return {
    total: measured.totalTokens,
    surface: measured.surfaceTokens,
    breakdownMessages: contextBreakdown.messageTokens,
    projected: contextPressure.projectedTokens,
  }
}

/** Event types appended since `from`, replacements marked, for exact-sequence assertions. */
export function sequence(session: Session, from: number): string[] {
  return session.events.slice(from).map((event) => {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    return `${event.type}${typeof op === 'object' && op !== null ? '(replace)' : ''}`
  })
}

/** The minimal agent the compaction seam needs: a session, routing options, and idle-task scheduling. */
export function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  } as unknown as Agent
}

/** Every text fragment the model would see on the surface, tool results included. */
export function surfaceText(session: Session): string {
  const collect = (blocks: readonly ContentBlock[]): string =>
    blocks.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? collect(block.content) : '')).join('\n')
  return session.deriveMessages().map((message) => collect(message.content)).join('\n')
}

/**
 * After a landing, every reader agrees and the total fell by exactly the priced delta
 * (replacement minus shadowed). The three readers moving together is what "the host's own
 * accounting stays correct" means.
 */
export function expectedAfter(before: Accounting, shadowed: number, replacement: number): Accounting {
  const delta = replacement - shadowed
  return {
    total: before.total + delta,
    surface: before.surface + delta,
    breakdownMessages: before.surface + delta,
    projected: before.projected === undefined ? undefined : before.projected + delta,
  }
}
