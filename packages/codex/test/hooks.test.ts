import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compactPromptPath } from '../src/config.js'
import { scenario } from './support/scenario.js'
import { assistantText, bulky, functionCall, functionCallOutput, localCompactionSummary, remoteCompactionSummary, resetOrdinal, sessionMeta, user } from './support/transcript.js'

const SECRET = 'AWS_SECRET_ACCESS_KEY=do-not-persist-me'

function session() {
  resetOrdinal()
  return [user('Read config.ts and fix the bug.'), functionCall('call-1', 'read', { path: 'config.ts' }), functionCallOutput('call-1', bulky('CONFIG-BODY')), assistantText('Found and fixed it.')]
}

describe('the pre-compact hook', () => {
  it('writes derived state and reports wiring, never blocking', () => {
    const s = scenario()
    s.writeTranscript(session())
    const stdout = s.preCompact()

    expect(stdout).toBe('')
    expect(Object.keys(s.stateFiles())).toContain('sess-0001.json')
    expect(s.logs.at(-1)).toContain('assisted')
    expect(s.logs.at(-1)).toContain('compact-prompt')
  })

  it('writes the managed compact-prompt file under CODEX_HOME, regardless of wiring', () => {
    const s = scenario()
    s.writeTranscript(session())
    s.preCompact()
    expect(readFileSync(compactPromptPath(s.codexHome), 'utf8').length).toBeGreaterThan(0)
  })

  it('writes state at owner-only permissions, under the configured state directory', () => {
    const s = scenario()
    s.writeTranscript(session())
    s.preCompact()
    const path = join(s.stateDir, 'sess-0001.json')
    expect(s.mode(path)).toBe(0o600)
    expect(s.mode(s.stateDir)).toBe(0o700)
  })

  it('never persists an observation body, only placeholders and framed conversation text', () => {
    const s = scenario()
    const entries = session()
    entries.push(functionCall('call-2', 'bash', { command: 'printenv' }), functionCallOutput('call-2', SECRET))
    s.writeTranscript(entries)
    s.preCompact()
    for (const content of Object.values(s.stateFiles())) expect(content).not.toContain(SECRET)
  })

  it('is silent and writes no state when the rollout cannot be read', () => {
    const s = scenario()
    // No writeTranscript(): the file does not exist.
    const stdout = s.preCompact()
    expect(stdout).toBe('')
    expect(s.stateFiles()).toEqual({})
    expect(s.logs.at(-1)).toContain('declined')
  })

  it('never throws and always reports success to the host, even for malformed input', () => {
    const s = scenario()
    expect(() => s.preCompact({ transcript_path: undefined })).not.toThrow()
  })
})

describe('the session-start hook (source: compact)', () => {
  it('re-injects the artifact as additionalContext when there is state to inject', () => {
    const s = scenario()
    s.writeTranscript(session())
    s.preCompact()
    const stdout = s.sessionStart('compact')
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Found and fixed it.')
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('CONFIG-BODY')
  })

  it('says the summary was supplemented, not replaced', () => {
    const s = scenario()
    s.writeTranscript(session())
    s.preCompact()
    const { additionalContext } = JSON.parse(s.sessionStart('compact')).hookSpecificOutput
    expect(additionalContext).toMatch(/assisted|not a replacement/i)
  })

  it('injects nothing when no state was persisted for this session', () => {
    const s = scenario()
    expect(s.sessionStart('compact')).toBe('')
  })

  it('injects nothing on a source other than compact', () => {
    const s = scenario()
    s.writeTranscript(session())
    s.preCompact()
    expect(s.sessionStart('startup')).toBe('')
    expect(s.sessionStart('resume')).toBe('')
  })

  it('points at persisted state instead of inlining the artifact when it would risk the practical injection ceiling', () => {
    const s = scenario()
    resetOrdinal()
    const manyTurns = Array.from({ length: 120 }, (_, n) => [
      user(`Turn ${n}: please look at module ${n} and report what it does.`),
      functionCall(`call-${n}`, 'read', { path: `src/module-${n}.ts` }),
      functionCallOutput(`call-${n}`, bulky(`BODY-${n}`)),
      assistantText(`Turn ${n}: module ${n} looks fine, moving on to the next one.`),
    ]).flat()
    s.writeTranscript(manyTurns)
    s.preCompact()
    const { additionalContext } = JSON.parse(s.sessionStart('compact')).hookSpecificOutput
    expect(additionalContext.length).toBeLessThan(10_000)
    expect(additionalContext).toContain(join(s.stateDir, 'sess-0001.json'))
  })
})

describe('the post-compact hook (audit)', () => {
  it('reports readable and appends a coverage record when Codex\'s own compaction result is plaintext', () => {
    const s = scenario()
    const entries = session()
    s.writeTranscript(entries)
    s.preCompact()
    s.writeTranscript([...entries, localCompactionSummary('Found and fixed it. Read config.ts.')])
    const stdout = s.postCompact()
    expect(stdout).toBe('')
    const audit = readFileSync(join(s.stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ sessionId: 'sess-0001', providerCompaction: 'readable' })
    expect(s.logs.at(-1)).toContain('coverage')
  })

  it('reports opaque and logs it, with no coverage claim, when Codex compacted remotely', () => {
    const s = scenario()
    const entries = session()
    s.writeTranscript(entries)
    s.preCompact()
    s.writeTranscript([...entries, remoteCompactionSummary()])
    s.postCompact()
    const audit = JSON.parse(readFileSync(join(s.stateDir, 'audit.jsonl'), 'utf8').trim())
    expect(audit.providerCompaction).toBe('opaque')
    expect(audit.coverage).toBeUndefined()
    expect(s.logs.at(-1)).toContain('opaque')
  })

  it('pairs the finding with the session\'s own recorded model_provider, when the rollout carries one', () => {
    const s = scenario()
    const entries = [sessionMeta({ model_provider: 'openai' }), ...session()]
    s.writeTranscript(entries)
    s.preCompact()
    s.writeTranscript([...entries, remoteCompactionSummary()])
    s.postCompact()
    const audit = JSON.parse(readFileSync(join(s.stateDir, 'audit.jsonl'), 'utf8').trim())
    expect(audit.modelProvider).toBe('openai')
    expect(s.logs.at(-1)).toContain('provider: openai')
  })

  it('is a silent no-op when nothing was persisted to audit against', () => {
    const s = scenario()
    s.writeTranscript(session())
    expect(s.postCompact()).toBe('')
  })
})
