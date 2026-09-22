import { DEFAULT_BUDGET, run } from '@maskpoint/core'
import type { BudgetPolicy, CapabilityProfile } from '@maskpoint/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
// Type-only: makes the optional sibling pruner service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { hostCheckpointDeps } from './checkpoint.js'
import type { SummarizationInput, SummaryResult } from './host-types.js'
import { maskInPlace } from './inplace.js'
import { conversationRoute, PolicyError, resolveSummarizer, resolveTrigger } from './policy.js'
import type { TriggerSpec } from './policy.js'
import { selectRange } from './range.js'
import { assertCanCompactInTurn } from './session-state.js'
import { contentBlocks } from './render.js'
import { regionSnapshot } from './snapshot.js'

/** The envelope a model-free landing records: honest about who wrote the history. */
export const MASKPOINT_PROVIDER = 'maskpoint'
export const MASK_ONLY_MODEL = 'mask-only'

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

  /** The checkpoint trigger. Design default; a tuning parameter, not a derived constant. Configuration is a later ticket. */
  protected readonly budget: BudgetPolicy = DEFAULT_BUDGET

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
   * Masking alone may leave a session above the trigger. The automatic entry lands per observation
   * through the host's prune protocol (spike #9), which has no way to carry a model-authored
   * checkpoint, so it never makes the checkpoint call the explicit entries can (#11); an idle
   * `/compact` or explicit region compaction is what brings the session back down. Said once per
   * stretch above the line, so a stuck session is visible without a warning on every step.
   */
  private warnIfStillAbove(session: Session, totalTokens: number, thresholdTokens: number): void {
    if (totalTokens < thresholdTokens) {
      this.warnedAbove.delete(session)
    } else if (!this.warnedAbove.has(session)) {
      this.warnedAbove.add(session)
      this.ctx.logger.warn(`maskpoint: still above the ${thresholdTokens}-token threshold after masking; the automatic entry has no checkpoint path`)
    }
  }

  /**
   * Masked history for a region, or — over budget, or when the caller asked for one — a checkpoint:
   * one call through the host's LLM seam, condensing the accumulated masked history. A checkpoint
   * carries a real summarization-call marker and usage; the model-free landing carries neither.
   *
   * Rejection and fallback are exactly what the engine defines: any outcome other than an accepted
   * checkpoint returns masked history, never empty and never partial.
   */
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    signal?.throwIfAborted()
    const snapshot = regionSnapshot(input.messages)
    const routed = agent.session.requestHeader()?.config
    const conversation = conversationRoute(routed, agent.options)
    const summarizer = resolveSummarizer(this.config, conversation)
    const cancellation = signal ?? new AbortController().signal
    const { deps, accepted } = hostCheckpointDeps(this.ctx.llm, {
      route: summarizer.route,
      maxTokens: summarizer.maxTokens,
      signal: cancellation,
    })

    const outcome = await run(snapshot, this.budget, deps)
    if (outcome.kind === 'decline') {
      // A decline is the engine saying this region cannot be trusted or is empty. The host's
      // transaction closes the attempt and reports it as its `summary` failure, unchanged history.
      this.ctx.logger.warn(`maskpoint (explicit): declined — ${outcome.reason}`)
      throw new Error(`maskpoint: cannot mask this region (${outcome.reason})`)
    }

    if (outcome.kind === 'checkpoint') {
      const call = accepted()
      if (call === undefined) throw new Error('maskpoint: checkpoint accepted with no recorded call')
      const usage = call.usage === undefined ? '' : `, usage ${call.usage.inputTokens} in / ${call.usage.outputTokens} out`
      this.ctx.logger.info(
        `maskpoint (explicit): strategy checkpoint, candidate ~${outcome.stats.candidateTokens} tokens, ` +
          `checkpoint via ${call.provider}/${call.model}${usage}`,
      )
      return {
        summary: contentBlocks.render(outcome.artifact),
        provider: call.provider,
        model: call.model,
        maxTokens: summarizer.maxTokens,
        rawOutput: call.rawOutput,
        llmStreamCall: true,
        ...(call.usage === undefined ? {} : { usage: call.usage }),
      }
    }

    if (outcome.checkpointRejection !== undefined) {
      this.ctx.logger.warn(`maskpoint (explicit): checkpoint ${outcome.checkpointRejection}; falling back to masked history`)
    }
    const { stats } = outcome
    this.ctx.logger.info(
      `maskpoint (explicit): strategy mask, ${stats.observationsMasked} observations masked, ` +
        `${stats.charsOmitted} chars omitted, candidate ~${stats.candidateTokens} tokens, no checkpoint`,
    )
    return {
      summary: contentBlocks.render(outcome.artifact),
      provider: MASKPOINT_PROVIDER,
      model: MASK_ONLY_MODEL,
    }
  }
}

export default MaskpointCompactionEngine
