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
  const override = config.modelPolicies.find((policy) => policy.provider === target.provider && policy.model === target.model)
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
