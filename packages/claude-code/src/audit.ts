/**
 * Post-compaction fidelity audit: how much of what Maskpoint's artifact preserved also survived
 * into the host's own compaction summary. A metric, never a correction — the host's summary is
 * never touched, only measured (docs/design.md, Claude Code adapter).
 */
export interface DriftMetric {
  artifactChars: number
  hostSummaryChars: number
  /** Distinct salient terms found in the artifact: file paths, identifiers, and words of some length. */
  salientTerms: number
  /** How many of those terms also appear, as a substring, in the host's summary. */
  coveredTerms: number
  /** `coveredTerms / salientTerms`, or 1 when there were no salient terms to lose. */
  coverage: number
}

/** A path-like or identifier-like token worth checking for survival: not stray punctuation or short words. */
const SALIENT_TERM = /[\w./-]{4,}/g

function salientTermsOf(text: string): Set<string> {
  return new Set(text.match(SALIENT_TERM) ?? [])
}

/** Compare Maskpoint's rendered artifact against the host's own compaction summary. */
export function auditDrift(artifactText: string, hostSummary: string): DriftMetric {
  const terms = salientTermsOf(artifactText)
  const covered = [...terms].filter((term) => hostSummary.includes(term)).length
  return {
    artifactChars: artifactText.length,
    hostSummaryChars: hostSummary.length,
    salientTerms: terms.size,
    coveredTerms: covered,
    coverage: terms.size === 0 ? 1 : covered / terms.size,
  }
}

/** One record's worth of what `summarizeAudit` needs: a coverage ratio, plus whether steering ran. */
export interface AuditEntry {
  coverage: number
  /** Whether the undocumented PreCompact steering line was active for this compaction, when known. */
  steered?: boolean
  /** Size of the injected artifact, in characters — the second copy's own context cost, when known. */
  artifactChars?: number
  /** Size of the host's own compaction summary the artifact rides alongside, in characters, when known. */
  hostSummaryChars?: number
}

/**
 * Aggregate real per-compaction audit records into the numbers the assisted-tier value decision
 * (docs/design.md, Open issue 4) and the steering-channel stability question (Open issue 7) need:
 * whether coverage differs with the steering channel on versus off, how often it ran at all, and how
 * much context the artifact costs as a second copy alongside the host's own summary.
 */
export interface AuditSummary {
  compactions: number
  meanCoverage: number
  /** Mean coverage across compactions where steering was active, or undefined when none are known to be. */
  steeredCoverage: number | undefined
  /** Mean coverage across compactions where steering was inactive, or undefined when none are known to be. */
  unsteeredCoverage: number | undefined
  /** Fraction of compactions with a known steering status where it was active. 0 when none is known. */
  steeringActiveRate: number
  /** Mean size of the injected artifact, in characters. Undefined when no record reports it. */
  meanArtifactChars: number | undefined
  /** Mean size of the host's own compaction summary, in characters. Undefined when no record reports it. */
  meanHostSummaryChars: number | undefined
  /**
   * Mean, across compactions, of `artifactChars / hostSummaryChars`: how large the duplicated copy
   * is relative to what the host already produced on its own. This is the "duplication cost" the
   * assisted-tier value decision weighs against `meanCoverage` — a high ratio spent on coverage the
   * host already achieved on its own is the case for defaulting to audit-only. Undefined when no
   * compaction has both sizes recorded and a non-zero host summary to divide by. A zero-length host
   * summary is excluded here (it would divide by zero) even though it is the case where the artifact
   * plausibly adds the most value; see `duplicationRatioSamples` for how much this mean is actually
   * drawn from.
   */
  meanDuplicationRatio: number | undefined
  /** How many compactions `meanDuplicationRatio` is computed from, so a thin or skewed sample is visible rather than hidden behind the mean. */
  duplicationRatioSamples: number
}

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

/** Summarize a batch of audit records, e.g. everything `readAudit` returns for a session or a fleet. */
export function summarizeAudit(records: readonly AuditEntry[]): AuditSummary {
  const steered = records.filter((record) => record.steered === true).map((record) => record.coverage)
  const unsteered = records.filter((record) => record.steered === false).map((record) => record.coverage)
  const known = steered.length + unsteered.length

  // Each size mean is independent of the other: a record reporting only one of the two still
  // counts toward that one's mean, matching AuditEntry's independently optional fields.
  const artifactChars = records.map((record) => record.artifactChars).filter((value): value is number => typeof value === 'number')
  const hostSummaryChars = records.map((record) => record.hostSummaryChars).filter((value): value is number => typeof value === 'number')
  // The ratio needs both sizes on the same record, and a non-zero host summary to divide by.
  const ratios = records
    .filter(
      (record): record is AuditEntry & { artifactChars: number; hostSummaryChars: number } =>
        typeof record.artifactChars === 'number' && typeof record.hostSummaryChars === 'number' && record.hostSummaryChars > 0,
    )
    .map((record) => record.artifactChars / record.hostSummaryChars)

  return {
    compactions: records.length,
    meanCoverage: mean(records.map((record) => record.coverage)) ?? 0,
    steeredCoverage: mean(steered),
    unsteeredCoverage: mean(unsteered),
    steeringActiveRate: known === 0 ? 0 : steered.length / known,
    meanArtifactChars: mean(artifactChars),
    meanHostSummaryChars: mean(hostSummaryChars),
    meanDuplicationRatio: mean(ratios),
    duplicationRatioSamples: ratios.length,
  }
}
