#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { summarizeAudit } from './audit.js'
import { loadConfig } from './config.js'
import { runHook, type HookName } from './hooks.js'
import { defaultStateDir, readAudit } from './state.js'

const HOOK_NAMES: readonly HookName[] = ['pre-compact', 'post-compact', 'session-start']
const COMMANDS = [...HOOK_NAMES, 'audit-summary'] as const

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/** Best-effort diagnostics under our own state directory. Never lets a logging failure affect the hook. */
function fileLogger(stateDir: string): (line: string) => void {
  return (line) => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      appendFileSync(join(stateDir, 'log.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    } catch {
      // Logging is a courtesy; it must never affect the hook's own outcome.
    }
  }
}

/** Which channel a hook's stdout travels through, for a diagnostic that names the actual failure. */
function channelFor(name: HookName): string {
  switch (name) {
    case 'pre-compact':
      return 'undocumented steering channel'
    case 'session-start':
      return 'documented re-injection channel'
    case 'post-compact':
      return 'output channel'
  }
}

/**
 * Write a hook's stdout, reporting rather than silently swallowing a failure of the channel that
 * carries it: PreCompact's is the undocumented steering line, whose stability is an open question
 * (docs/design.md, Open issue 7), and SessionStart's is the documented re-injection channel. Either
 * way the hook itself already succeeded — this can only ever affect what the host receives, never
 * whether compaction proceeds. `write`/`reportError` are injectable so this is testable without a
 * real stdout to break.
 */
export function writeStdout(
  name: HookName,
  stdout: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
  reportError: (text: string) => void = (text) => process.stderr.write(text),
): void {
  if (stdout === '') return
  try {
    write(stdout)
  } catch (error) {
    reportError(`maskpoint-claude-code: ${channelFor(name)} unavailable on ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** An operator-invoked report, not a hook: real-session numbers for the assisted-tier value decision (docs/design.md, Open issue 4). */
export function auditSummaryReport(stateDir: string): string {
  return `${JSON.stringify(summarizeAudit(readAudit(stateDir)), null, 2)}\n`
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    process.stderr.write(`usage: maskpoint-claude-code <${COMMANDS.join('|')}>\n`)
    // Never a nonzero exit: an unrecognized invocation is not a reason to affect compaction.
    process.exitCode = 0
    return
  }

  const stateDir = defaultStateDir()

  if (command === 'audit-summary') {
    process.stdout.write(auditSummaryReport(stateDir))
    process.exitCode = 0
    return
  }

  const name = command as HookName
  const log = fileLogger(stateDir)
  const config = loadConfig({ homeDir: homedir(), cwd: process.cwd() }, (message) => log(`maskpoint: ${message}`))
  const stdin = await readStdin()
  const { stdout, exitCode } = runHook(name, stdin, {
    stateDir,
    now: () => new Date(),
    log,
    // An operator can turn off the undocumented steering line without disabling Maskpoint: the
    // artifact path is independent of it (docs/design.md, Claude Code adapter).
    steering: process.env.MASKPOINT_NO_STEERING !== '1',
    config,
  })

  writeStdout(name, stdout)
  process.exitCode = exitCode
}

// Run only when executed directly (`node cli.js ...`), not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Whatever went wrong, the host must still see a clean exit: compaction is never blocked on us.
    try {
      process.stderr.write(`maskpoint-claude-code: ${error instanceof Error ? error.message : String(error)}\n`)
    } catch {
      // Nothing more to do.
    }
    process.exitCode = 0
  })
}
