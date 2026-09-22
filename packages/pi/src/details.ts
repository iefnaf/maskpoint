import type { EngineDetail, FileOps } from '@maskpoint/core'
import { isRecord, type Rec } from './normalize.js'

/** The paths in one of Pi's file sets. Sets at runtime, arrays once recorded; anything else is none. */
const pathsIn = (value: unknown): string[] =>
  value instanceof Set || Array.isArray(value) ? [...value].filter((path): path is string => typeof path === 'string') : []

/**
 * The read, written and edited paths Pi tracked for the span being compacted. Absent when Pi
 * tracked none (or sent something that is not a file-operations record), so that a session with no
 * file tracking persists no lists.
 */
export function fileOpsOf(value: unknown): FileOps | undefined {
  if (!isRecord(value)) return undefined
  const ops = { read: pathsIn(value.read), written: pathsIn(value.written), edited: pathsIn(value.edited) }
  return ops.read.length + ops.written.length + ops.edited.length === 0 ? undefined : ops
}

const isNonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

function statsOf(value: unknown): EngineDetail['stats'] | undefined {
  if (!isRecord(value)) return undefined
  const { observationsMasked, charsOmitted, candidateTokens } = value
  if (!isFiniteNumber(observationsMasked) || !isFiniteNumber(charsOmitted) || !isFiniteNumber(candidateTokens)) return undefined
  return { observationsMasked, charsOmitted, candidateTokens }
}

function persistedFilesOf(value: unknown): FileOps | undefined {
  if (!isRecord(value)) return undefined
  const { read, written, edited } = value
  if (!isStringArray(read) || !isStringArray(written) || !isStringArray(edited)) return undefined
  return { read: [...read], written: [...written], edited: [...edited] }
}

function cursorOf(value: unknown): EngineDetail['cursor'] | undefined {
  if (!isRecord(value)) return undefined
  const { boundaryId, evictedThroughId } = value
  if (typeof boundaryId !== 'string' || typeof evictedThroughId !== 'string') return undefined
  return { boundaryId, evictedThroughId }
}

/**
 * Validate an unknown value as `EngineDetail`, our own compaction entry's `details`. Reconstructed
 * field by field rather than cast, so a shape this adapter did not write — Pi's own `details`, an
 * older or newer version, a foreign engine, an unrelated object — comes back absent rather than
 * partially parsed, and a field this version does not know about is dropped rather than carried
 * forward (docs/design.md, Pi adapter: "Foreign or older details are treated as absent").
 */
export function engineDetailOf(value: unknown): EngineDetail | undefined {
  if (!isRecord(value)) return undefined
  if (value.v !== 1 || value.engine !== 'maskpoint') return undefined
  if (value.strategy !== 'mask' && value.strategy !== 'checkpoint') return undefined
  if (!isNonNegativeInt(value.checkpoints)) return undefined
  const stats = statsOf(value.stats)
  if (stats === undefined) return undefined

  let files: FileOps | undefined
  if (value.files !== undefined) {
    files = persistedFilesOf(value.files)
    if (files === undefined) return undefined
  }

  let cursor: EngineDetail['cursor']
  if (value.cursor !== undefined) {
    cursor = cursorOf(value.cursor)
    if (cursor === undefined) return undefined
  }

  return {
    v: 1,
    engine: 'maskpoint',
    strategy: value.strategy,
    checkpoints: value.checkpoints,
    stats,
    ...(files === undefined ? {} : { files }),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

/**
 * The most recent compaction entry on the branch whose `details` this adapter recognizes as its
 * own, however many compactions — by Pi, by an older version, by this one — sit between it and the
 * cut. Because Pi does not fold a hook-produced compaction's details into the next preparation
 * (docs/design.md, Pi adapter), this is the only way a checkpoint count or file list survives a
 * compaction that Pi's own compactor made in between.
 */
export function latestEngineDetail(entries: readonly Rec[]): EngineDetail | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.type !== 'compaction') continue
    const detail = engineDetailOf(entry.details)
    if (detail !== undefined) return detail
  }
  return undefined
}
