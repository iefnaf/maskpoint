import { decide } from '@maskpoint/core'
import type { BudgetPolicy, CapabilityProfile, ConversationSnapshot, Item } from '@maskpoint/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
// Type-only: makes the optional sibling pruner service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { SummarizationInput, SummaryResult } from './host-types.js'
import { maskInPlace } from './inplace.js'
import { normalizeMessages } from './normalize.js'
import { PolicyError, resolveTrigger } from './policy.js'
import type { TriggerSpec } from './policy.js'
import { selectRange } from './range.js'
import { assertCanCompactInTurn } from './session-state.js'
import { contentBlocks } from './render.js'

/** The envelope a model-free landing records: honest about who wrote the history. */
export const MASKPOINT_PROVIDER = 'maskpoint'
export const MASK_ONLY_MODEL = 'mask-only'

/** Design default; a tuning parameter, not a derived constant. Configuration is a later ticket. */
export const DEFAULT_BUDGET: BudgetPolicy = { checkpointTriggerTokens: 12_000 }

/**
 * What this adapter can actually do, published so the tier is never overstated. It replaces the
 * host's compactor, but it persists no metadata of its own (statistics are logged; the host's
 * compaction events are the durable record), and steers/re-injects nothing.
 */
export const capabilities: CapabilityProfile = {
  replaceHistory: true,
  steerSummarizer: false,
  reinjectContext: false,
  persistMetadata: false,
  honestCancellation: true,
}

/** Overflow keeps no tail and has no threshold: it forces one useful reduction. */
const NO_TAIL: TriggerSpec = { thresholdTokens: 0, retainTokens: 0 }

/** Marks the end of the compacted region for the engine, which is handed a boundary, not a region. */
const REGION_END: Item = { id: '\u0000maskpoint:region-end', kind: 'opaque', note: 'end of compacted region' }

/**
 * Maskpoint as a DSH compaction backend.
 *
 * It replaces the host's built-in backend (one backend per context), so it extends it: the explicit
 * entries (`compactNow`, `compactRegion`) then run through the host's own compaction transaction —
 * lock, stability check, pairing validation, manual-compaction error classification, flush — and
 * only the documented `summarize()` hook is ours.
 */
export class MaskpointCompactionEngine extends BasicCompactionEngine {
  private readonly warnedTargets = new Set<string>()
  private readonly warnedAbove = new WeakSet<Session>()

  /**
   * Automatic compaction (step-boundary pressure, or one provider-confirmed context overflow).
   *
   * The host's surface already is the accumulated state, so there is no candidate to assemble and no
   * cursor to keep: observations outside the host's retained window are masked in place, by the
   * host's prune protocol, and the call returns `null` because no summary ran. Trigger policy is the
   * host's own (threshold and retention from the same configuration); only the reduction differs.
   * Overflow bypasses the threshold and the retained tail, exactly as the host backend does, so it
   * can force one useful reduction; the surface's `replaceGeneration` advancing is its proof.
   */
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const { session } = agent
    const routed = session.requestHeader()?.config
    if (routed === undefined || routed.provider.length === 0 || routed.model.length === 0) return null
    const meter = this.ctx.tokenMeter

    // Overflow bypasses the threshold and the retained tail; pressure needs the model's capacity.
    const spec = trigger === 'pressure' ? await this.triggerSpec({ provider: routed.provider, model: routed.model }, signal) : NO_TAIL
    if (spec === undefined) return null
    // Everything below lands synchronously, so this is the last point a cancellation can stop it.
    signal.throwIfAborted()
    assertCanCompactInTurn(session)

    let measurement = meter.measure(session)
    if (trigger === 'pressure' && measurement.totalTokens < spec.thresholdTokens) return null

    const range = selectRange(session, measurement, spec.retainTokens)
    const masked = range === null ? { observationsMasked: 0, charsOmitted: 0 } : maskInPlace(session, meter, range)
    // The host's own pruner, if mounted, is a safety net enabling this backend must not remove: the
    // built-in backend runs it before compacting, so with the built-in gone, this is who does.
    this.ctx.get('toolResultPruner')?.pruneSession(session)

    measurement = meter.measure(session)
    if (masked.observationsMasked > 0) {
      this.ctx.logger.info(
        `maskpoint (${trigger}): strategy mask, ${masked.observationsMasked} observations masked, ` +
          `${masked.charsOmitted} chars omitted, ~${measurement.totalTokens} tokens now, no checkpoint`,
      )
    }
    if (trigger === 'pressure') this.warnIfStillAbove(session, measurement.totalTokens, spec.thresholdTokens)
    return null
  }

  /**
   * The host's threshold and retention for the routed model, or `undefined` (after one warning per
   * model) when its policy cannot be applied: the session is then left alone, never made worse.
   */
  private async triggerSpec(target: { provider: string; model: string }, signal: AbortSignal): Promise<TriggerSpec | undefined> {
    const { context } = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    try {
      if (context === undefined) {
        throw new PolicyError(`no context capacity for ${target.provider}/${target.model}; configure contextWindow on that adapter model`)
      }
      return resolveTrigger(this.config, target, context.contextWindow)
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error
      const key = `${target.provider}/${target.model}`
      if (!this.warnedTargets.has(key)) {
        this.warnedTargets.add(key)
        this.ctx.logger.warn(`maskpoint: cannot apply compaction policy — ${error.message}; not compacting`)
      }
      return undefined
    }
  }

  /**
   * Masking alone may leave a session above the trigger, and until the checkpoint path exists (#11)
   * nothing else will shrink it. Said once per stretch above the line, so a stuck session is visible
   * without a warning on every step.
   */
  private warnIfStillAbove(session: Session, totalTokens: number, thresholdTokens: number): void {
    if (totalTokens < thresholdTokens) {
      this.warnedAbove.delete(session)
    } else if (!this.warnedAbove.has(session)) {
      this.warnedAbove.add(session)
      this.ctx.logger.warn(`maskpoint: still above the ${thresholdTokens}-token threshold after masking; no checkpoint path is enabled`)
    }
  }

  /**
   * Masked history for a region, in place of a model-written summary. Model-free: the returned
   * envelope carries no summarization-call marker and no usage.
   */
  protected override summarize(input: SummarizationInput, _agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    signal?.throwIfAborted()
    const items = normalizeMessages(input.messages)
    // State heading the region is what an earlier compaction left (as the host names it, a
    // checkpoint; it may be masked history): continue from it, do not re-mask or re-frame it.
    const head = items[0]
    const previous = head?.kind === 'checkpoint' && head.text !== '' ? head : undefined
    const snapshot: ConversationSnapshot = {
      items: [...items, REGION_END],
      boundary: { id: REGION_END.id },
      reason: 'manual',
      ...(previous === undefined ? {} : { previousCheckpoint: previous.text, evictedThrough: previous.id }),
    }
    const decision = decide(snapshot, DEFAULT_BUDGET)
    // Until the checkpoint path lands (#11) an over-budget candidate is still returned as masked
    // history: the fallback the engine defines for a rejected checkpoint.
    const outcome = decision.kind === 'checkpoint-requested' ? decision.fallback : decision
    if (outcome.kind !== 'masked-history') {
      // A decline is the engine saying this region cannot be trusted or is empty. The host's
      // transaction closes the attempt and reports it as its `summary` failure, unchanged history.
      const reason = outcome.kind === 'decline' ? outcome.reason : outcome.kind
      this.ctx.logger.warn(`maskpoint (explicit): declined — ${reason}`)
      return Promise.reject(new Error(`maskpoint: cannot mask this region (${reason})`))
    }
    const { stats } = outcome
    this.ctx.logger.info(
      `maskpoint (explicit): strategy mask, ${stats.observationsMasked} observations masked, ` +
        `${stats.charsOmitted} chars omitted, candidate ~${stats.candidateTokens} tokens, no checkpoint`,
    )
    return Promise.resolve({
      summary: contentBlocks.render(outcome.artifact),
      provider: MASKPOINT_PROVIDER,
      model: MASK_ONLY_MODEL,
    })
  }
}

export default MaskpointCompactionEngine
