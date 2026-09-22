import { auditDrift, findCompactionResult, findModelProvider } from './audit.js'
import { planCompaction } from './compact.js'
import { isRecord, type Rec } from './normalize.js'
import { injectedContext, injectedPointer, PRACTICAL_INJECTION_CEILING } from './render.js'
import { appendAudit, readState, statePathFor, writeState } from './state.js'
import { readTranscript } from './transcript.js'

/** What a hook invocation needs from its environment, so the dispatcher is testable without real I/O. */
export interface HookPorts {
  stateDir: string
  codexHome: string
  now(): Date
  log(line: string): void
}

export interface HookResult {
  stdout: string
  exitCode: number
}

export type HookName = 'pre-compact' | 'post-compact' | 'session-start'

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function preCompact(payload: Rec, ports: HookPorts): HookResult {
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
  const effect = planCompaction(
    entries,
    { trigger, ...(customInstructions === undefined ? {} : { customInstructions }) },
    prior,
    ports.codexHome,
  )

  if (effect.kind === 'decline') {
    ports.log(`maskpoint: declined (${effect.reason}${effect.note === undefined ? '' : `: ${effect.note}`})`)
    return { stdout: '', exitCode: 0 }
  }

  writeState(ports.stateDir, {
    v: 1,
    sessionId,
    detail: effect.detail,
    checkpointText: effect.checkpointText,
    updatedAt: ports.now().toISOString(),
  })
  const { observationsMasked, charsOmitted } = effect.detail.stats
  const flags = [effect.overBudget && 'over budget', effect.focusRequested && 'focus requested'].filter(Boolean).join(', ')
  ports.log(
    `maskpoint: assisted (masked ${observationsMasked} observations, ${charsOmitted} chars omitted${flags === '' ? '' : `, ${flags}`}, ` +
      `compact-prompt ${effect.wiring.wired ? 'wired' : `not wired: ${effect.wiring.reason}`})`,
  )

  // Never blocking: PreCompact's own output has no documented steering field (see config.ts /
  // COMPACT_PROMPT for the actual, documented steering channel). This hook only reports.
  return { stdout: '', exitCode: 0 }
}

function sessionStart(payload: Rec, ports: HookPorts): HookResult {
  if (payload.source !== 'compact') return { stdout: '', exitCode: 0 }
  const sessionId = str(payload.session_id)
  if (sessionId === undefined) return { stdout: '', exitCode: 0 }
  const prior = readState(ports.stateDir, sessionId)
  if (prior === undefined) return { stdout: '', exitCode: 0 }

  const full = injectedContext(prior.checkpointText)
  const fits = full.length <= PRACTICAL_INJECTION_CEILING
  const additionalContext = fits ? full : injectedPointer(statePathFor(ports.stateDir, sessionId), prior.checkpointText.length)
  ports.log(`maskpoint: re-injected ${fits ? 'artifact' : 'pointer to persisted state'} (${additionalContext.length} chars)`)

  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
    exitCode: 0,
  }
}

function postCompact(payload: Rec, ports: HookPorts): HookResult {
  const sessionId = str(payload.session_id)
  const transcriptPath = str(payload.transcript_path)
  if (sessionId === undefined) return { stdout: '', exitCode: 0 }
  const prior = readState(ports.stateDir, sessionId)
  if (prior === undefined) return { stdout: '', exitCode: 0 }

  const entries = transcriptPath === undefined ? undefined : readTranscript(transcriptPath)
  const finding = entries === undefined ? { providerCompaction: 'undetermined' as const } : findCompactionResult(entries)
  const modelProvider = entries === undefined ? undefined : findModelProvider(entries)
  const providerNote = modelProvider === undefined ? '' : ` (provider: ${modelProvider})`

  if (finding.providerCompaction === 'readable' && finding.hostSummaryText !== undefined) {
    const drift = auditDrift(prior.checkpointText, finding.hostSummaryText)
    appendAudit(ports.stateDir, {
      v: 1,
      sessionId,
      at: ports.now().toISOString(),
      providerCompaction: 'readable',
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...drift,
    })
    ports.log(`maskpoint: audit coverage ${Math.round(drift.coverage * 100)}% (${drift.coveredTerms}/${drift.salientTerms} terms); provider compaction readable${providerNote}`)
  } else {
    appendAudit(ports.stateDir, {
      v: 1,
      sessionId,
      at: ports.now().toISOString(),
      providerCompaction: finding.providerCompaction,
      ...(modelProvider === undefined ? {} : { modelProvider }),
      artifactChars: prior.checkpointText.length,
    })
    ports.log(`maskpoint: provider compaction ${finding.providerCompaction}${providerNote} — no readable host summary to audit against`)
  }
  return { stdout: '', exitCode: 0 }
}

/**
 * Run one hook invocation. Never throws and never returns a non-zero exit code: a fault here must
 * never block compaction, so every failure path degrades to a quiet no-op instead (mirrors the
 * Claude Code adapter's `hooks.ts`).
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
