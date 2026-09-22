import { describe, expect, it } from 'vitest'
import { auditDrift } from '../src/audit.js'

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
