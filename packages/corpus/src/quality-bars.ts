import {
  type BudgetPolicy,
  type CheckpointRejection,
  DEFAULT_BUDGET,
  type DeclineReason,
  type EngineDeps,
  run,
} from '@maskpoint/core'
import { rawRegionTokens } from './calibration.js'
import type { CorpusFixture } from './corpus.js'
import { modelDouble, responses, type Script } from './model-double.js'

/** Forces the checkpoint path regardless of a fixture's tiny size, to exercise every rejection shape. */
const TINY_BUDGET: BudgetPolicy = { checkpointTriggerTokens: 1 }

function deps(script: Script): EngineDeps {
  return {
    complete: modelDouble(script).complete,
    newRoutingId: () => 'quality-bars-routing',
    signal: { aborted: false },
    checkpoint: { maxOutputTokens: 2000 },
  }
}

const CHECKPOINT_TEXT = '## State\nQuality-bars report run.'

/**
 * The mask-vs-checkpoint split and decline reasons over the corpus at the real default budget
 * (docs/design.md "Quality bars": zero-LLM ratio, usable-result rate). A checkpoint call, if one is
 * requested (customInstructions or over budget), answers with `responses.success` so the run
 * completes rather than exercising rejection paths -- that is `checkpointSafetyOverCorpus`'s job.
 */
export interface UsageReport {
  fixtures: number
  maskedHistory: number
  checkpoint: number
  decline: number
  declineReasons: Partial<Record<DeclineReason, number>>
  /** `maskedHistory / (maskedHistory + checkpoint)`; `undefined` when nothing compacted. */
  zeroLlmRatio: number | undefined
}

export async function usageOverCorpus(corpus: readonly CorpusFixture[], budget: BudgetPolicy = DEFAULT_BUDGET): Promise<UsageReport> {
  const report: UsageReport = { fixtures: corpus.length, maskedHistory: 0, checkpoint: 0, decline: 0, declineReasons: {}, zeroLlmRatio: undefined }
  for (const fixture of corpus) {
    const outcome = await run(fixture.snapshot, budget, deps(responses.success(CHECKPOINT_TEXT)))
    if (outcome.kind === 'masked-history') report.maskedHistory++
    else if (outcome.kind === 'checkpoint') report.checkpoint++
    else {
      report.decline++
      report.declineReasons[outcome.reason] = (report.declineReasons[outcome.reason] ?? 0) + 1
    }
  }
  const compacted = report.maskedHistory + report.checkpoint
  report.zeroLlmRatio = compacted === 0 ? undefined : report.maskedHistory / compacted
  return report
}

/**
 * Context-decrease (docs/design.md "Quality bars"): before/after token estimates per compaction.
 * "Before" is `rawRegionTokens` -- the same pre-mask reading `calibration.ts` compares against
 * DSH's meter -- and "after" is the outcome's own `candidateTokens`. A fixture with nothing to
 * compact contributes no comparison. Reports every fixture that does NOT strictly decrease, so the
 * bar is "zero violations", not a percentage that could hide one.
 */
export async function contextDecreaseViolations(
  corpus: readonly CorpusFixture[],
  budget: BudgetPolicy = DEFAULT_BUDGET,
): Promise<string[]> {
  const violations: string[] = []
  for (const fixture of corpus) {
    const before = rawRegionTokens(fixture.snapshot)
    if (before === undefined) continue
    const outcome = await run(fixture.snapshot, budget, deps(responses.success(CHECKPOINT_TEXT)))
    if (outcome.kind === 'decline') continue
    if (outcome.stats.candidateTokens >= before) violations.push(fixture.name)
  }
  return violations
}

/**
 * Checkpoint safety (docs/design.md "Quality bars": zero persisted truncated or empty checkpoints).
 * Forces the checkpoint path on every fixture for each of the six ways a model call can end
 * (`model-double.ts`'s `responses`), and counts what actually got persisted: an accepted checkpoint
 * always carries the scripted text; every rejection always falls back to non-empty masked history
 * with a `checkpointRejection` naming why. `truncatedOrEmptyPersisted` is the bar itself -- it must
 * stay zero.
 */
export interface CheckpointSafetyReport {
  attempts: number
  accepted: number
  rejections: Partial<Record<CheckpointRejection, number>>
  truncatedOrEmptyPersisted: number
}

const SCRIPTS: Record<string, Script> = {
  success: responses.success(CHECKPOINT_TEXT),
  providerError: responses.providerError('rate limited'),
  aborted: responses.aborted(),
  lengthStop: responses.lengthStop('cut off mid'),
  toolCall: responses.toolCall(),
  empty: responses.empty(),
}

export async function checkpointSafetyOverCorpus(corpus: readonly CorpusFixture[]): Promise<CheckpointSafetyReport> {
  const report: CheckpointSafetyReport = { attempts: 0, accepted: 0, rejections: {}, truncatedOrEmptyPersisted: 0 }
  for (const fixture of corpus) {
    for (const script of Object.values(SCRIPTS)) {
      const outcome = await run(fixture.snapshot, TINY_BUDGET, deps(script))
      if (outcome.kind === 'decline') continue // nothing to checkpoint; not an attempt
      report.attempts++
      if (outcome.kind === 'checkpoint') {
        report.accepted++
        const text = outcome.artifact.sections.find((section) => section.kind === 'checkpoint')?.text
        if (text === undefined || text.trim() === '') report.truncatedOrEmptyPersisted++
      } else if (outcome.checkpointRejection !== undefined) {
        report.rejections[outcome.checkpointRejection] = (report.rejections[outcome.checkpointRejection] ?? 0) + 1
      }
    }
  }
  return report
}
