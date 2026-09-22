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
