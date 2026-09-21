/**
 * Recording tap for Pi's `session_before_compact` event. It writes each payload to
 * `$MASKPOINT_RECORD_DIR` and returns nothing, so it never changes what Pi does. Load it beside the
 * extension (or alone) to capture the payloads in `pi-<version>/`; see README.md in this directory.
 *
 * Development tooling: not part of the shipped package and not run by the test suite.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiExtensionApi } from '../../src/host.js'

let count = 0

export default function record(pi: PiExtensionApi): void {
  pi.on('session_before_compact', (event) => {
    const dir = process.env.MASKPOINT_RECORD_DIR
    if (dir === undefined) return undefined
    mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify(
      event,
      (key, value: unknown) => {
        if (key === 'signal') return undefined
        // Pi's file operations are Sets, which JSON would otherwise flatten to {}.
        return value instanceof Set ? [...value] : value
      },
      2,
    )
    writeFileSync(join(dir, `compact-${++count}.json`), `${payload}\n`)
    return undefined
  })
}
