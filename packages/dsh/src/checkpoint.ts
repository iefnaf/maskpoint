import { randomUUID } from 'node:crypto'
import type { EngineDeps, ModelRequest, ModelResponse } from '@maskpoint/core'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Route } from './policy.js'

/** What the host must record about the call that wrote an accepted checkpoint. */
export interface CheckpointCall extends Route {
  /** The provider's complete output, before it was projected to safe summary text. */
  rawOutput: ContentBlock[]
  usage?: TokenUsage
}

/**
 * The engine's model call, made through the host's LLM seam (`ctx.llm.stream`, the seam the host's
 * own summarizer uses) so the host's routing, retries, adapters and credentials apply and Maskpoint
 * adds no network destination. Everything a one-off summarization must not inherit is set here:
 *
 * - a fresh routing identity (`sessionId`) instead of the session's, so the call does not share the
 *   main loop's request cursor or cache. The seam has no cache-retention switch, so this and
 *   sending no replayed prefix are how "no prompt-cache retention" is expressed;
 * - the host's cancellation signal, forwarded as given;
 * - `tools: []`, so nothing in the call can act;
 * - `purpose: 'compaction'`, which is how the host classifies an auxiliary call.
 *
 * Only a complete, text-only answer is reported as one; everything else is reported as what it was,
 * and the engine falls back to masked history.
 */
export function hostCheckpointDeps(
  llm: Context['llm'],
  options: { route: Route | undefined; maxTokens: number; signal: AbortSignal },
): { deps: EngineDeps; accepted(): CheckpointCall | undefined } {
  let last: CheckpointCall | undefined

  async function complete(request: ModelRequest): Promise<ModelResponse> {
    last = undefined
    const { route } = options
    // No configured summarizer and no conversation route: a missing model degrades to masking,
    // reported through the same rejection vocabulary as every other outcome below, not thrown.
    if (route === undefined) return { stopReason: 'error', text: '', error: 'no provider/model available for a checkpoint' }

    const assembler = new BlockAssembler()
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: request.instructions,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: request.input }],
          source: { kind: 'plugin', plugin: 'maskpoint' },
        }),
      ],
      tools: [],
      maxTokens: request.maxOutputTokens,
      sessionId: SessionId(request.routingId),
      purpose: 'compaction',
      signal: options.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)

    const { finish, usage } = assembler
    const blocks = assembler.blocks()
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const reported = usage === undefined ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }

    switch (finish.kind) {
      case 'error':
        return { stopReason: 'error', text: '', error: finish.failure.message }
      case 'aborted':
        return { stopReason: 'aborted', text: '' }
      case 'max-tokens':
        return { stopReason: 'length', text, ...reported }
      case 'tool-calls':
        return { stopReason: 'tool-call', text: '', ...reported }
      default:
        break
    }
    // A call the model made anyway, or output that cannot be summary text, is not a checkpoint.
    if (blocks.some((block) => block.type === 'tool-call')) return { stopReason: 'tool-call', text: '', ...reported }
    if (blocks.some((block) => block.type === 'image')) {
      return { stopReason: 'error', text: '', error: 'compaction summary cannot contain image output' }
    }
    last = { ...route, rawOutput: blocks, ...(usage === undefined ? {} : { usage }) }
    return { stopReason: 'stop', text, ...reported }
  }

  return {
    deps: {
      complete,
      newRoutingId: () => randomUUID(),
      signal: options.signal,
      checkpoint: { maxOutputTokens: options.maxTokens },
    },
    /** The call behind the answer the engine accepted, for the host's durable record. */
    accepted: () => last,
  }
}
