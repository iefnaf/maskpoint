import { readFileSync } from 'node:fs'
import { isRecord, type Rec } from './normalize.js'

/**
 * Parse a Codex rollout file into its entries, in order. Blank lines are skipped; a line that is
 * not valid JSON, or not a JSON object, is skipped too — the rollout is appended to across a long
 * session, and one damaged line must not cost the rest of the history. Returns undefined only when
 * the file itself cannot be opened at all.
 */
export function readTranscript(path: string): Rec[] | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const entries: Rec[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isRecord(parsed)) entries.push(parsed)
    } catch {
      // A damaged line is skipped, not fatal to the rest of the transcript.
    }
  }
  return entries
}
