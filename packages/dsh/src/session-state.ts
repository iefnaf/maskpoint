import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Whether a turn is open, and whether another compaction holds the session lock, read from the
 * log the way the host backend reads it: the newest `turn/*` and `compaction/*` markers, with a
 * `session/end-seed` boundary proving an unmatched start belongs to an earlier session lifecycle.
 */
function inspect(session: Session): { openTurn: number | null; lockHeld: boolean } {
  let openTurn: number | null = null
  let turnKnown = false
  let lifecycleKnown = false
  let unmatchedStart: number | undefined
  let seedSeq: number | undefined
  const { events } = session
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (seedSeq === undefined && event.type === 'session/end-seed') seedSeq = event.seq
    if (!lifecycleKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event.seq
        lifecycleKnown = true
      } else if (event.type === 'compaction/end') lifecycleKnown = true
    }
    if (!turnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        turnKnown = true
      } else if (event.type === 'turn/end') turnKnown = true
    }
    if (turnKnown && lifecycleKnown && seedSeq !== undefined) break
  }
  return { openTurn, lockHeld: unmatchedStart !== undefined && !(seedSeq !== undefined && seedSeq > unmatchedStart) }
}

/**
 * An automatic compaction lands events that must sit inside a turn, and must not overlap another
 * compaction. Expected refusals use the host's manual-compaction vocabulary.
 */
export function assertCanCompactInTurn(session: Session): void {
  const { openTurn, lockHeld } = inspect(session)
  if (lockHeld) {
    throw new ManualCompactionError('busy', 'automatic compaction: a compaction already holds the session lock')
  }
  if (openTurn === null) {
    throw new Error('compactIfNeeded: no open turn — automatic compaction events must be enclosed in a turn')
  }
}
