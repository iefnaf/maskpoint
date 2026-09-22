import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** The pressure and retention budgets, in tokens, for one routed model. */
export interface TriggerSpec {
  /** Compact when the meter's total reaches this. */
  thresholdTokens: number
  /** Keep at least this much recent context verbatim. */
  retainTokens: number
}

/** The host's compaction policy cannot be applied to this model; the message says why. */
export class PolicyError extends Error {
  override readonly name = 'PolicyError'
}

/** A provider route and model, as the host's log and LLM seam name them. */
export interface Route {
  provider: string
  model: string
}

/** Whether a possibly-partial route has both a non-empty provider and model. */
function usable(route: { provider?: string | undefined; model?: string | undefined } | undefined): route is Route {
  return route?.provider !== undefined && route.provider.length > 0 && route.model !== undefined && route.model.length > 0
}

/** The exact-target policy override for `target`, or `undefined` when none applies or `target` is unknown. */
function modelPolicyFor(config: ResolvedConfig, target: Route | undefined) {
  return target === undefined ? undefined : config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model)
}

/**
 * The route the conversation is on: the latest durably routed request, else the agent's own
 * options. It selects the host's per-model policy override, and is the checkpoint's default model.
 */
export function conversationRoute(
  routed: Route | undefined,
  options: { provider?: string | undefined; model?: string | undefined },
): Route | undefined {
  if (usable(routed)) return { provider: routed.provider, model: routed.model }
  return usable(options) ? { provider: options.provider, model: options.model } : undefined
}

/** Who writes a checkpoint and how much they may write. */
export interface SummarizerPolicy {
  /** The configured summarizer, else the conversation's own route; absent when neither exists. */
  route: Route | undefined
  /** The generation cap; a response cut off by it is rejected. */
  maxTokens: number
}

/**
 * The host backend's own choice of summarizer, applied to the same resolved configuration: an exact
 * provider/model override wins over the defaults; a configured summarization provider and model
 * (always set together) win over the conversation's route; the cap is `maxTokens`. Restated because
 * the host does not export its resolver; a parity test compares the request this makes with the one
 * the host's own summarizer makes.
 */
export function resolveSummarizer(config: ResolvedConfig, conversation: Route | undefined): SummarizerPolicy {
  const override = modelPolicyFor(config, conversation)
  const provider = override?.summarizationProvider ?? config.summarizationProvider
  const model = override?.summarizationModel ?? config.summarizationModel
  return {
    route: provider.length === 0 ? conversation : { provider, model },
    maxTokens: override?.maxTokens ?? config.maxTokens,
  }
}

/**
 * The host backend's own threshold and retention arithmetic, applied to the same resolved
 * configuration: an exact provider/model override wins over the defaults; `retainTokens` wins over
 * `retainRatio`; both scale by the model's context window. Restated because the host does not
 * export its resolver. A parity test drives this and the host backend over the same configurations,
 * so a change upstream is a red test rather than a silent difference in when compaction fires.
 */
export function resolveTrigger(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
  contextWindow: number,
): TriggerSpec {
  const key = `${target.provider}/${target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new PolicyError(`${key}: contextWindow (${contextWindow}) must be a positive integer`)
  }
  const override = modelPolicyFor(config, target)
  const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio
  const retainTokens =
    override?.retainTokens ??
    (override?.retainRatio === undefined ? undefined : Math.floor(contextWindow * override.retainRatio)) ??
    config.retainTokens ??
    Math.floor(contextWindow * config.retainRatio!)
  const thresholdTokens = Math.floor(contextWindow * thresholdRatio)
  if (retainTokens >= thresholdTokens) {
    throw new PolicyError(`${key}: retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }
  return { thresholdTokens, retainTokens }
}
