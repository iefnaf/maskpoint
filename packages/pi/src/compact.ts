import {
  type Artifact,
  type BudgetPolicy,
  type CapabilityProfile,
  type CheckpointRejection,
  type ConversationSnapshot,
  DEFAULT_BUDGET,
  type DeclineReason,
  type EngineDeps,
  type EngineDetail,
  estimateTokens,
  type ModelRequest,
  type ModelResponse,
  payloadOf,
  run,
  type Usage,
} from '@maskpoint/core'
import type { PiAssistantMessage, PiBeforeCompactEvent, PiCompactionResult, PiContext } from './host.js'
import { summaryRenderer } from './render.js'
import { buildSnapshot, isDecline } from './snapshot.js'

/** What Pi's adapter can do: it replaces the host's summarize step, and its state rides in the compaction entry. */
export const capabilities: CapabilityProfile = {
  replaceHistory: true,
  steerSummarizer: false,
  reinjectContext: false,
  persistMetadata: true,
  honestCancellation: true,
}

/**
 * What the adapter decided. `native` is a replacement Pi will persist as its compaction result;
 * `decline` returns nothing, so Pi's own compactor runs. `note` says what was structurally wrong,
 * never what the conversation contained.
 */
export type PiEffect =
  | {
      kind: 'native'
      artifact: Artifact
      /** The artifact rendered as Pi's summary text. */
      summary: string
      /** Pi's own cut point, passed through unchanged. */
      boundary: { id: string }
      detail: EngineDetail
      tokensBefore: number
      /** Present only when a checkpoint call produced this result. */
      usage?: Usage
      /** Set when a checkpoint was attempted and not accepted, so the caller can say why none ran. */
      checkpointRejection?: CheckpointRejection
    }
  | { kind: 'decline'; reason: DeclineReason; note?: string }

const decline = (reason: DeclineReason, note?: string): PiEffect => ({
  kind: 'decline',
  reason,
  ...(note === undefined ? {} : { note }),
})

/** What Pi charges for one image (4,800 characters at four per token): the estimator cannot see an image. */
const IMAGE_TOKENS = 1200

/**
 * What the replaced span cost before: the earlier summary plus the newly evicted history as Pi
 * held it, bodies included, and the images tool results carried. An image the user attached is
 * already a text note by now and is not counted, which only errs toward declining.
 */
function tokensReplaced(snapshot: ConversationSnapshot): number {
  const { items, boundary, evictedThrough } = snapshot
  const from = evictedThrough === undefined ? 0 : items.findIndex((item) => item.id === evictedThrough) + 1
  const to = items.findIndex((item) => item.id === boundary.id)
  const evicted = items.slice(from, to).reduce((total, item) => {
    const images = item.kind === 'tool-result' ? item.media : 0
    return total + estimateTokens(payloadOf(item)) + images * IMAGE_TOKENS
  }, 0)
  return evicted + estimateTokens(snapshot.previousCheckpoint ?? '')
}

/** The generation cap for a checkpoint call. A tuning parameter, not a derived constant. */
export const CHECKPOINT_MAX_OUTPUT_TOKENS = 4_000

/** Pi's `StopReason` values a completed (non-streaming) `complete()` call can return. */
function stopReasonOf(stopReason: PiAssistantMessage['stopReason']): ModelResponse['stopReason'] {
  switch (stopReason) {
    case 'stop':
    case 'length':
    case 'error':
    case 'aborted':
      return stopReason
    case 'toolUse':
      return 'tool-call'
    default:
      // 'pending' and 'deferred' describe a streaming response; `complete()` never returns one, so a
      // host that did anyway is treated the same as a provider error rather than narrowed further.
      return 'error'
  }
}

const textOf = (content: PiAssistantMessage['content']): string =>
  content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

/**
 * The engine's one checkpoint call, translated into Pi's `modelRegistry.complete`. Absent
 * `deps.checkpoint.model` always means the session's active model in this version: there is no
 * per-checkpoint model configuration yet.
 */
async function completeWith(ctx: PiContext, request: ModelRequest): Promise<ModelResponse> {
  const model = ctx.model
  if (model === undefined) throw new Error('no model is configured for this session')
  const reply = await ctx.modelRegistry.complete(
    model,
    { systemPrompt: request.instructions, messages: [{ role: 'user', content: request.input, timestamp: Date.now() }] },
    { maxTokens: request.maxOutputTokens, signal: request.signal as AbortSignal, cacheRetention: 'none', sessionId: request.routingId },
  )
  return {
    stopReason: stopReasonOf(reply.stopReason),
    text: textOf(reply.content),
    usage: { inputTokens: reply.usage.input, outputTokens: reply.usage.output },
  }
}

function buildDeps(event: PiBeforeCompactEvent, ctx: PiContext): EngineDeps {
  return {
    complete: (request) => completeWith(ctx, request),
    newRoutingId: () => crypto.randomUUID(),
    signal: event.signal ?? { aborted: false },
    checkpoint: { maxOutputTokens: CHECKPOINT_MAX_OUTPUT_TOKENS },
  }
}

async function plan(event: PiBeforeCompactEvent, ctx: PiContext, budget: BudgetPolicy): Promise<PiEffect> {
  const snapshot = buildSnapshot(event)
  if (isDecline(snapshot)) return decline(snapshot.reason, snapshot.note)

  const outcome = await run(snapshot, budget, buildDeps(event, ctx))
  if (outcome.kind === 'decline') return decline(outcome.reason)

  const summary = summaryRenderer.render(outcome.artifact)
  // Context must strictly shrink: framing and role labels cost something, so a span with little to
  // mask can render larger than it was.
  if (!(estimateTokens(summary) < tokensReplaced(snapshot))) return decline('no-size-reduction')

  return {
    kind: 'native',
    artifact: outcome.artifact,
    summary,
    boundary: { id: event.preparation.firstKeptEntryId },
    detail: outcome.detail,
    tokensBefore: event.preparation.tokensBefore,
    ...(outcome.kind === 'checkpoint' && outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    ...(outcome.kind === 'masked-history' && outcome.checkpointRejection !== undefined
      ? { checkpointRejection: outcome.checkpointRejection }
      : {}),
  }
}

/**
 * Decide what to do with Pi's pre-compaction event. It never throws: a fault becomes a decline, so
 * a session is never left without a compaction result.
 */
export async function planCompaction(
  event: PiBeforeCompactEvent,
  ctx: PiContext,
  options: { budget?: BudgetPolicy } = {},
): Promise<PiEffect> {
  try {
    return await plan(event, ctx, options.budget ?? DEFAULT_BUDGET)
  } catch (error) {
    return decline('engine-failure', error instanceof Error ? error.message : String(error))
  }
}

/** The result Pi persists as its compaction entry. The cut point is exactly the one Pi prepared. */
export function toPiResult(effect: Extract<PiEffect, { kind: 'native' }>): PiCompactionResult {
  return {
    compaction: {
      summary: effect.summary,
      firstKeptEntryId: effect.boundary.id,
      tokensBefore: effect.tokensBefore,
      details: effect.detail,
    },
  }
}
