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
}

/**
 * Aggregate real per-compaction audit records into the numbers the assisted-tier value decision
 * (docs/design.md, Open issue 4) and the steering-channel stability question (Open issue 7) need:
 * whether coverage differs with the steering channel on versus off, and how often it ran at all.
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
}

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

/** Summarize a batch of audit records, e.g. everything `readAudit` returns for a session or a fleet. */
export function summarizeAudit(records: readonly AuditEntry[]): AuditSummary {
  const steered = records.filter((record) => record.steered === true).map((record) => record.coverage)
  const unsteered = records.filter((record) => record.steered === false).map((record) => record.coverage)
  const known = steered.length + unsteered.length
  return {
    compactions: records.length,
    meanCoverage: mean(records.map((record) => record.coverage)) ?? 0,
    steeredCoverage: mean(steered),
    unsteeredCoverage: mean(unsteered),
    steeringActiveRate: known === 0 ? 0 : steered.length / known,
  }
}
