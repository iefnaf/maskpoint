#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { runHook, type HookName } from './hooks.js'
import { defaultStateDir } from './state.js'

const HOOK_NAMES: readonly HookName[] = ['pre-compact', 'post-compact', 'session-start']

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

async function main(): Promise<void> {
  const name = process.argv[2]
  if (!HOOK_NAMES.includes(name as HookName)) {
    process.stderr.write(`usage: maskpoint-claude-code <${HOOK_NAMES.join('|')}>\n`)
    // Never a nonzero exit: an unrecognized invocation is not a reason to affect compaction.
    process.exitCode = 0
    return
  }

  const stateDir = defaultStateDir()
  const log = fileLogger(stateDir)
  const config = loadConfig({ homeDir: homedir(), cwd: process.cwd() }, (message) => log(`maskpoint: ${message}`))
  const stdin = await readStdin()
  const { stdout, exitCode } = runHook(name as HookName, stdin, {
    stateDir,
    now: () => new Date(),
    log,
    // An operator can turn off the undocumented steering line without disabling Maskpoint: the
    // artifact path is independent of it (docs/design.md, Claude Code adapter).
    steering: process.env.MASKPOINT_NO_STEERING !== '1',
    config,
  })

  if (stdout !== '') process.stdout.write(stdout)
  process.exitCode = exitCode
}

main().catch((error: unknown) => {
  // Whatever went wrong, the host must still see a clean exit: compaction is never blocked on us.
  try {
    process.stderr.write(`maskpoint-claude-code: ${error instanceof Error ? error.message : String(error)}\n`)
  } catch {
    // Nothing more to do.
  }
  process.exitCode = 0
})
