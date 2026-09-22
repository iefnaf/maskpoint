import { describe, expect, it } from 'vitest'
import { auditDrift, findCompactionResult, findModelProvider } from '../src/audit.js'
import { assistantText, eventMsg, localCompactionSummary, remoteCompactionSummary, resetOrdinal, sessionMeta, user } from './support/transcript.js'

describe('findCompactionResult', () => {
  it('reports opaque when the rollout carries a remote-v2 compaction item', () => {
    resetOrdinal()
    const finding = findCompactionResult([user('hi'), remoteCompactionSummary()])
    expect(finding).toEqual({ providerCompaction: 'opaque' })
  })

  it('reports readable, with the summary text, for a local-style plaintext compaction message', () => {
    resetOrdinal()
    const finding = findCompactionResult([user('hi'), localCompactionSummary('Working on the parser bug in config.ts.')])
    expect(finding.providerCompaction).toBe('readable')
    expect(finding.hostSummaryText).toContain('Working on the parser bug in config.ts.')
  })

  it('reports undetermined when no compaction marker is found at all', () => {
    resetOrdinal()
    const finding = findCompactionResult([user('hi'), assistantText('just chatting'), eventMsg('task_complete')])
    expect(finding).toEqual({ providerCompaction: 'undetermined' })
  })

  it('uses the most recent compaction when a rollout carries more than one', () => {
    resetOrdinal()
    const finding = findCompactionResult([localCompactionSummary('first summary'), user('more turns'), remoteCompactionSummary()])
    expect(finding.providerCompaction).toBe('opaque')
  })

  it('ignores session_meta and other bookkeeping lines', () => {
    resetOrdinal()
    expect(findCompactionResult([sessionMeta()])).toEqual({ providerCompaction: 'undetermined' })
  })
})

describe('findModelProvider', () => {
  it('reads model_provider from the rollout\'s own session_meta line', () => {
    resetOrdinal()
    expect(findModelProvider([sessionMeta({ model_provider: 'openai' }), user('hi')])).toBe('openai')
  })

  it('returns undefined when there is no session_meta line', () => {
    resetOrdinal()
    expect(findModelProvider([user('hi')])).toBeUndefined()
  })
})

describe('auditDrift', () => {
  it('reports full coverage when every salient term from the artifact survives into the host summary', () => {
    const drift = auditDrift('src/config.ts', 'We read src/config.ts and fixed the bug.')
    expect(drift.coverage).toBe(1)
  })

  it('reports partial coverage when some terms are missing', () => {
    const drift = auditDrift('src/config.ts src/utils.ts', 'Only src/config.ts was mentioned.')
    expect(drift.coverage).toBeCloseTo(0.5)
  })

  it('reports coverage of 1 when the artifact has no salient terms to lose', () => {
    expect(auditDrift('ok', 'anything').coverage).toBe(1)
  })
})
