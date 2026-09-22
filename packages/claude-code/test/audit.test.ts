import { describe, expect, it } from 'vitest'
import { auditDrift, summarizeAudit } from '../src/audit.js'

describe('auditDrift — fidelity of the host summary against the artifact', () => {
  it('reports full coverage when every salient term survived', () => {
    const artifact = 'Changed src/parser.ts'
    const summary = 'Changed src/parser.ts to fix a bug.'
    const drift = auditDrift(artifact, summary)
    expect(drift.coverage).toBe(1)
    expect(drift.coveredTerms).toBe(drift.salientTerms)
  })

  it('reports partial coverage when the host summary dropped some terms', () => {
    const artifact = 'src/parser.ts src/lexer.ts src/emitter.ts'
    const summary = 'Changed src/parser.ts only.'
    const drift = auditDrift(artifact, summary)
    expect(drift.salientTerms).toBe(3)
    expect(drift.coveredTerms).toBe(1)
    expect(drift.coverage).toBeCloseTo(1 / 3)
  })

  it('reports zero coverage when nothing survived, without dividing by zero', () => {
    const drift = auditDrift('src/parser.ts', 'A completely different summary with no overlap word.')
    expect(drift.coverage).toBe(0)
  })

  it('reports full coverage (vacuously) when the artifact has no salient terms to lose', () => {
    const drift = auditDrift('ok', 'anything')
    expect(drift.salientTerms).toBe(0)
    expect(drift.coverage).toBe(1)
  })

  it('records the raw sizes alongside the ratio', () => {
    const drift = auditDrift('abcd', 'wxyz')
    expect(drift).toMatchObject({ artifactChars: 4, hostSummaryChars: 4 })
  })
})

describe('summarizeAudit — real-session numbers for the assisted-tier value decision', () => {
  it('reports zero compactions and vacuous coverage for an empty log', () => {
    expect(summarizeAudit([])).toEqual({
      compactions: 0,
      meanCoverage: 0,
      steeringActiveRate: 0,
      steeredCoverage: undefined,
      unsteeredCoverage: undefined,
      meanArtifactChars: undefined,
      meanHostSummaryChars: undefined,
      meanDuplicationRatio: undefined,
      duplicationRatioSamples: 0,
    })
  })

  it('averages coverage across every recorded compaction', () => {
    const summary = summarizeAudit([{ coverage: 1 }, { coverage: 0.5 }, { coverage: 0 }])
    expect(summary.compactions).toBe(3)
    expect(summary.meanCoverage).toBeCloseTo(0.5)
  })

  it('splits coverage by whether the steering channel was active, so a value decision can compare them', () => {
    const summary = summarizeAudit([
      { coverage: 0.9, steered: true },
      { coverage: 0.7, steered: true },
      { coverage: 0.4, steered: false },
    ])
    expect(summary.steeredCoverage).toBeCloseTo(0.8)
    expect(summary.unsteeredCoverage).toBeCloseTo(0.4)
    expect(summary.steeringActiveRate).toBeCloseTo(2 / 3)
  })

  it('leaves the steered/unsteered split undefined when no record says whether steering was active', () => {
    const summary = summarizeAudit([{ coverage: 1 }, { coverage: 0.5 }])
    expect(summary.steeredCoverage).toBeUndefined()
    expect(summary.unsteeredCoverage).toBeUndefined()
    expect(summary.steeringActiveRate).toBe(0)
  })

  it('leaves one side of the split undefined when every known record falls on the other side', () => {
    const summary = summarizeAudit([{ coverage: 1, steered: true }, { coverage: 0.6, steered: true }])
    expect(summary.steeredCoverage).toBeCloseTo(0.8)
    expect(summary.unsteeredCoverage).toBeUndefined()
    expect(summary.steeringActiveRate).toBe(1)
  })

  it('reports the duplication cost of the injected artifact against the host summary it rides alongside', () => {
    const summary = summarizeAudit([
      { coverage: 1, artifactChars: 200, hostSummaryChars: 100 },
      { coverage: 1, artifactChars: 100, hostSummaryChars: 50 },
    ])
    expect(summary.meanArtifactChars).toBeCloseTo(150)
    expect(summary.meanHostSummaryChars).toBeCloseTo(75)
    // Mean of the per-compaction ratios (2.0, 2.0), not the ratio of the means.
    expect(summary.meanDuplicationRatio).toBeCloseTo(2)
    expect(summary.duplicationRatioSamples).toBe(2)
  })

  it('leaves duplication-cost fields undefined when no record reports sizes', () => {
    const summary = summarizeAudit([{ coverage: 1 }, { coverage: 0.5 }])
    expect(summary.meanArtifactChars).toBeUndefined()
    expect(summary.meanHostSummaryChars).toBeUndefined()
    expect(summary.meanDuplicationRatio).toBeUndefined()
    expect(summary.duplicationRatioSamples).toBe(0)
  })

  it('counts a record toward one size mean even when it reports only that one field', () => {
    const summary = summarizeAudit([
      { coverage: 1, artifactChars: 200 },
      { coverage: 1, hostSummaryChars: 100 },
    ])
    expect(summary.meanArtifactChars).toBeCloseTo(200)
    expect(summary.meanHostSummaryChars).toBeCloseTo(100)
    // Neither record has both fields, so no ratio can be computed.
    expect(summary.meanDuplicationRatio).toBeUndefined()
    expect(summary.duplicationRatioSamples).toBe(0)
  })

  it('excludes a zero-length host summary from the ratio without dropping it from the size means', () => {
    const summary = summarizeAudit([
      { coverage: 1, artifactChars: 40, hostSummaryChars: 0 },
      { coverage: 1, artifactChars: 60, hostSummaryChars: 30 },
    ])
    expect(summary.meanArtifactChars).toBeCloseTo(50)
    expect(summary.meanHostSummaryChars).toBeCloseTo(15)
    // Only the second record's ratio (2.0) is defined; the first would divide by zero.
    expect(summary.meanDuplicationRatio).toBeCloseTo(2)
    expect(summary.duplicationRatioSamples).toBe(1)
  })
})
