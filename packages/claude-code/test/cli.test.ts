import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendAudit } from '../src/state.js'
import { auditSummaryReport, writeStdout } from '../src/cli.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'maskpoint-cli-'))
  roots.push(root)
  return root
}

describe('writeStdout', () => {
  it('writes non-empty stdout through the given writer', () => {
    const written: string[] = []
    writeStdout('pre-compact', 'hello', (text) => written.push(text))
    expect(written).toEqual(['hello'])
  })

  it('writes nothing and reports nothing for empty stdout', () => {
    const written: string[] = []
    const errors: string[] = []
    writeStdout('post-compact', '', (text) => written.push(text), (text) => errors.push(text))
    expect(written).toEqual([])
    expect(errors).toEqual([])
  })

  it('names the undocumented steering channel when pre-compact stdout fails to write', () => {
    const errors: string[] = []
    writeStdout(
      'pre-compact',
      'steering line',
      () => {
        throw new Error('EPIPE')
      },
      (text) => errors.push(text),
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('undocumented steering channel')
    expect(errors[0]).toContain('EPIPE')
  })

  it('names the documented re-injection channel when session-start stdout fails to write', () => {
    const errors: string[] = []
    writeStdout(
      'session-start',
      '{"hookSpecificOutput":{}}',
      () => {
        throw new Error('closed')
      },
      (text) => errors.push(text),
    )
    expect(errors[0]).toContain('documented re-injection channel')
  })

  it('never throws outward: a write failure is reported, not propagated', () => {
    expect(() =>
      writeStdout(
        'pre-compact',
        'x',
        () => {
          throw new Error('boom')
        },
        () => {},
      ),
    ).not.toThrow()
  })
})

describe('auditSummaryReport', () => {
  it('renders the aggregated real-session numbers as JSON', () => {
    const dir = tmpDir()
    appendAudit(dir, { v: 1, sessionId: 's1', at: 't1', artifactChars: 10, hostSummaryChars: 5, salientTerms: 2, coveredTerms: 1, coverage: 0.5, steered: true })
    const report = JSON.parse(auditSummaryReport(dir))
    expect(report).toMatchObject({ compactions: 1, meanCoverage: 0.5, steeredCoverage: 0.5, steeringActiveRate: 1 })
  })

  it('renders a vacuous summary when nothing has been audited yet', () => {
    const report = JSON.parse(auditSummaryReport(tmpDir()))
    expect(report).toMatchObject({ compactions: 0, meanCoverage: 0 })
  })
})
