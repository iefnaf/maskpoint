import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHook } from '../src/hooks.js'
import { scenario } from './support/scenario.js'
import { assistantText, bulky, toolResult, toolUse, user } from './support/transcript.js'

const SECRET = 'AWS_SECRET_ACCESS_KEY=do-not-persist-me'

const SESSION = [
  user('Read config.ts and fix the bug.'),
  toolUse('call-1', 'read', { path: 'config.ts' }),
  toolResult('call-1', bulky('CONFIG-BODY')),
  assistantText('Found and fixed it.'),
]

describe('the pre-compact hook', () => {
  it('writes derived state and prints the steering line, never blocking', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
    const stdout = s.preCompact()

    expect(stdout).toContain('Maskpoint')
    expect(Object.keys(s.stateFiles())).toEqual(['sess-0001.json'])
    expect(s.logs.some((line) => line.includes('assisted'))).toBe(true)
  })

  it('records that the steering channel was active, in both the persisted state and the log', () => {
    const s = scenario({ steering: true })
    s.writeTranscript(SESSION)
    s.preCompact()
    expect(JSON.parse(s.stateFile('sess-0001.json'))).toMatchObject({ steered: true })
    expect(s.logs.some((line) => /steering channel.*active/i.test(line))).toBe(true)
  })

  it('records that the steering channel was inactive, in both the persisted state and the log, when disabled', () => {
    const s = scenario({ steering: false })
    s.writeTranscript(SESSION)
    s.preCompact()
    expect(JSON.parse(s.stateFile('sess-0001.json'))).toMatchObject({ steered: false })
    expect(s.logs.some((line) => /steering channel.*inactive/i.test(line))).toBe(true)
  })

  it('writes state at owner-only permissions, under the configured state directory', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
    s.preCompact()
    const path = join(s.stateDir, 'sess-0001.json')
    expect(s.mode(path)).toBe(0o600)
    expect(s.mode(s.stateDir)).toBe(0o700)
  })

  it('never persists an observation body, only placeholders and framed conversation text', () => {
    const s = scenario()
    s.writeTranscript([...SESSION, toolUse('call-2', 'bash', { command: 'printenv' }), toolResult('call-2', SECRET)])
    s.preCompact()
    for (const content of Object.values(s.stateFiles())) expect(content).not.toContain(SECRET)
  })

  it('is silent and writes no state when the transcript cannot be read', () => {
    const s = scenario()
    // No writeTranscript(): the file does not exist.
    const stdout = s.preCompact()
    expect(stdout).toBe('')
    expect(s.stateFiles()).toEqual({})
    expect(s.logs.at(-1)).toContain('declined')
  })

  it('produces no steering text when the steering channel is turned off, without affecting the artifact', () => {
    const s = scenario({ steering: false })
    s.writeTranscript(SESSION)
    const stdout = s.preCompact()
    expect(stdout).toBe('')
    expect(Object.keys(s.stateFiles())).toHaveLength(1)
  })

  it('never throws and always reports success to the host, even for malformed input', () => {
    const s = scenario()
    expect(() => s.preCompact({ transcript_path: undefined })).not.toThrow()
  })
})

describe('the session-start hook (source: compact)', () => {
  it('re-injects the artifact as additionalContext when there is state to inject', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
    s.preCompact()
    const stdout = s.sessionStart('compact')
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Found and fixed it.')
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('CONFIG-BODY')
  })

  it('says the host summary was supplemented, not replaced', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
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
    s.writeTranscript(SESSION)
    s.preCompact()
    expect(s.sessionStart('startup')).toBe('')
    expect(s.sessionStart('resume')).toBe('')
  })

  it('points at persisted state instead of inlining the artifact when it would not fit the injection cap', () => {
    const s = scenario()
    // Every observation collapses to a short placeholder, so no single body can cross the cap; many
    // turns of framing and role labels can. A long session pushes the rendered candidate well past it.
    const manyTurns = Array.from({ length: 120 }, (_, n) => [
      user(`Turn ${n}: please look at module ${n} and report what it does.`),
      toolUse(`call-${n}`, 'read', { path: `src/module-${n}.ts` }),
      toolResult(`call-${n}`, bulky(`BODY-${n}`)),
      assistantText(`Turn ${n}: module ${n} looks fine, moving on to the next one.`),
    ]).flat()
    s.writeTranscript(manyTurns)
    s.preCompact()
    const { additionalContext } = JSON.parse(s.sessionStart('compact')).hookSpecificOutput
    expect(additionalContext.length).toBeLessThan(10_000)
    expect(additionalContext).toContain(join(s.stateDir, 'sess-0001.json'))
  })

  it('stays within the documented 10,000-character injection cap even for a normal artifact', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
    s.preCompact()
    const { additionalContext } = JSON.parse(s.sessionStart('compact')).hookSpecificOutput
    expect(additionalContext.length).toBeLessThanOrEqual(10_000)
  })
})

describe('the post-compact hook (audit)', () => {
  it('appends a coverage record comparing the artifact against the host summary', () => {
    const s = scenario()
    s.writeTranscript(SESSION)
    s.preCompact()
    const stdin = JSON.stringify({
      session_id: 'sess-0001',
      transcript_path: s.transcriptPath,
      cwd: '/workspace/app',
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      compact_summary: 'Found and fixed it. Read config.ts.',
    })
    const stdout = runPostCompact(s, stdin)
    expect(stdout).toBe('')
    const audit = readFileSync(join(s.stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ sessionId: 'sess-0001', steered: true })
    expect(s.logs.at(-1)).toContain('coverage')
    expect(s.logs.at(-1)).toMatch(/steering (on|off)/)
  })

  it('is a silent no-op when nothing was persisted to audit against', () => {
    const s = scenario()
    const stdin = JSON.stringify({
      session_id: 'sess-0001',
      transcript_path: s.transcriptPath,
      cwd: '/workspace/app',
      hook_event_name: 'PostCompact',
      trigger: 'auto',
      compact_summary: 'anything',
    })
    expect(runPostCompact(s, stdin)).toBe('')
  })
})

// The Scenario helper wraps pre-compact and session-start; post-compact is exercised directly
// against the same ports, since it never takes the transcript path as an input to re-parse.
function runPostCompact(s: ReturnType<typeof scenario>, stdin: string): string {
  return runHook('post-compact', stdin, {
    stateDir: s.stateDir,
    now: () => new Date('2026-09-21T10:31:00.000Z'),
    log: (line) => s.logs.push(line),
    steering: true,
  }).stdout
}
