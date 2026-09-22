import { budgetOf, type EngineConfig, maskOptionsOf } from '@maskpoint/core'
import { auditDrift } from './audit.js'
import { capabilities, planCompaction } from './compact.js'
import { isRecord, type Rec } from './normalize.js'
import { injectedContext, injectedPointer } from './render.js'
import { appendAudit, readState, statePathFor, writeState } from './state.js'
import { readTranscript } from './transcript.js'

/** What a hook invocation needs from its environment, so the dispatcher is testable without real I/O. */
export interface HookPorts {
  stateDir: string
  now(): Date
  log(line: string): void
  /**
   * Whether to print the pre-compaction steering line. This channel is real but undocumented (see
   * docs/design.md, Open issue 7): turning it off must not change whether the artifact still gets
   * produced, persisted, and re-injected — only whether the host's own summarizer was nudged.
   */
  steering: boolean
  /** Resolved once per invocation by `config.ts` (issue #8): enablement, the checkpoint budget, notification level. */
  config: EngineConfig
}

export interface HookResult {
  stdout: string
  exitCode: number
}

export type HookName = 'pre-compact' | 'post-compact' | 'session-start'

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const STEERING =
  'Maskpoint: preserve exact file paths, identifiers, command lines, and the exact text of test ' +
  'failures when summarizing. Earlier history already has stale tool output replaced by placeholders.'

function preCompact(payload: Rec, ports: HookPorts): HookResult {
  // Disabled: behave exactly as if Maskpoint were not installed. No transcript read, no state
  // written, no steering — nothing for a later hook invocation to find (docs/spec.md, Configuration:
  // "disable Maskpoint per project and globally, so that I can fall back to the host's own behavior").
  if (!ports.config.enabled) {
    ports.log('maskpoint: disabled by configuration')
    return { stdout: '', exitCode: 0 }
  }

  const sessionId = str(payload.session_id)
  const transcriptPath = str(payload.transcript_path)
  if (sessionId === undefined || transcriptPath === undefined) {
    ports.log('maskpoint: pre-compact payload is missing session_id or transcript_path')
    return { stdout: '', exitCode: 0 }
  }

  const trigger = payload.trigger === 'manual' ? 'manual' : 'auto'
  const customInstructions = str(payload.custom_instructions)
  const entries = readTranscript(transcriptPath)
  const prior = readState(ports.stateDir, sessionId)
  const budget = budgetOf(ports.config)
  const maskOptions = maskOptionsOf(ports.config)
  const effect = planCompaction(entries, { trigger, ...(customInstructions === undefined ? {} : { customInstructions }) }, prior, budget, maskOptions)

  if (effect.kind === 'decline') {
    ports.log(`maskpoint: declined (${effect.reason}${effect.note === undefined ? '' : `: ${effect.note}`})`)
    return { stdout: '', exitCode: 0 }
  }

  writeState(ports.stateDir, {
    v: 1,
    sessionId,
    detail: effect.detail,
    checkpointText: effect.checkpointText,
    steered: ports.steering,
    updatedAt: ports.now().toISOString(),
  })
  if (ports.config.notificationLevel !== 'silent') {
    const { observationsMasked, charsOmitted } = effect.detail.stats
    const flags = [effect.overBudget && 'over budget', effect.focusRequested && 'focus requested'].filter(Boolean).join(', ')
    ports.log(`maskpoint: assisted (masked ${observationsMasked} observations, ${charsOmitted} chars omitted${flags === '' ? '' : `, ${flags}`})`)
    // Feature-detection of this undocumented channel is bounded by what a single hook invocation can
    // know: whether it was attempted here. Recording it explicitly, every time, is what lets the
    // channel's disappearance show up in the audit trail instead of reading as merely low coverage
    // (docs/design.md, Open issue 7).
    ports.log(`maskpoint: steering channel ${ports.steering ? 'active' : 'inactive (disabled)'}`)
  }

  // Never blocking, never JSON: this stdout is the undocumented steering channel, not the
  // documented re-injection one. See docs/design.md, Claude Code adapter.
  return { stdout: ports.steering ? STEERING : '', exitCode: 0 }
}

function sessionStart(payload: Rec, ports: HookPorts): HookResult {
  if (!ports.config.enabled) return { stdout: '', exitCode: 0 }
  if (payload.source !== 'compact') return { stdout: '', exitCode: 0 }
  const sessionId = str(payload.session_id)
  if (sessionId === undefined) return { stdout: '', exitCode: 0 }
  const prior = readState(ports.stateDir, sessionId)
  if (prior === undefined) return { stdout: '', exitCode: 0 }

  const cap = capabilities.injectionCapChars ?? Number.POSITIVE_INFINITY
  const full = injectedContext(prior.checkpointText)
  const fits = full.length <= cap
  const additionalContext = fits ? full : injectedPointer(statePathFor(ports.stateDir, sessionId), prior.checkpointText.length)
  if (ports.config.notificationLevel !== 'silent') {
    ports.log(`maskpoint: re-injected ${fits ? 'artifact' : 'pointer to persisted state'} (${additionalContext.length} chars)`)
  }

  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
    exitCode: 0,
  }
}

function postCompact(payload: Rec, ports: HookPorts): HookResult {
  if (!ports.config.enabled) return { stdout: '', exitCode: 0 }
  const sessionId = str(payload.session_id)
  if (sessionId === undefined) return { stdout: '', exitCode: 0 }
  const prior = readState(ports.stateDir, sessionId)
  if (prior === undefined) return { stdout: '', exitCode: 0 }

  const hostSummary = typeof payload.compact_summary === 'string' ? payload.compact_summary : ''
  // Local, synchronous, no model or network call: bounded by the artifact and summary's own size, so
  // this cannot delay the user's next turn (docs/design.md, Claude Code scenario).
  const drift = auditDrift(prior.checkpointText, hostSummary)
  appendAudit(ports.stateDir, { v: 1, sessionId, at: ports.now().toISOString(), ...drift, ...(prior.steered === undefined ? {} : { steered: prior.steered }) })
  if (ports.config.notificationLevel !== 'silent') {
    const steeredNote = prior.steered === undefined ? '' : `, steering ${prior.steered ? 'on' : 'off'}`
    ports.log(`maskpoint: audit coverage ${Math.round(drift.coverage * 100)}% (${drift.coveredTerms}/${drift.salientTerms} terms${steeredNote})`)
  }
  return { stdout: '', exitCode: 0 }
}

/**
 * Run one hook invocation. Never throws and never returns a non-zero exit code: a fault here must
 * never block compaction (docs/design.md, "Maskpoint never blocks compaction"), so every failure
 * path degrades to a quiet no-op instead.
 */
export function runHook(name: HookName, stdin: string, ports: HookPorts): HookResult {
  let payload: unknown
  try {
    payload = JSON.parse(stdin)
  } catch (error) {
    ports.log(`maskpoint: hook input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return { stdout: '', exitCode: 0 }
  }
  if (!isRecord(payload)) {
    ports.log('maskpoint: hook input is not a JSON object')
    return { stdout: '', exitCode: 0 }
  }

  try {
    switch (name) {
      case 'pre-compact':
        return preCompact(payload, ports)
      case 'post-compact':
        return postCompact(payload, ports)
      case 'session-start':
        return sessionStart(payload, ports)
    }
  } catch (error) {
    ports.log(`maskpoint: ${name} hook failed: ${error instanceof Error ? error.message : String(error)}`)
    return { stdout: '', exitCode: 0 }
  }
}
