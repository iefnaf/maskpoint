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
})
