import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationSnapshot } from '@maskpoint/core'

export const corpusDir = join(import.meta.dirname, '..', 'fixtures')

export interface CorpusFixture {
  name: string
  file: string
  description: string
  snapshot: ConversationSnapshot
}

const MANIFEST = 'manifest.json'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, problem: string): never {
  throw new Error(`${path}: ${problem}`)
}

function checkKeys(rec: Rec, path: string, allowed: string[]): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) fail(path, `unknown key "${key}"`)
  }
}

function requireString(rec: Rec, key: string, path: string): string {
  const value = rec[key]
  if (typeof value !== 'string') fail(`${path}.${key}`, 'expected a string')
  return value
}

function checkOptionalString(rec: Rec, key: string, path: string): void {
  if (rec[key] !== undefined) requireString(rec, key, path)
}

function checkOptionalInteger(rec: Rec, key: string, path: string): void {
  const value = rec[key]
  if (value !== undefined && !Number.isInteger(value)) fail(`${path}.${key}`, 'expected an integer')
}

function validateItem(value: unknown, path: string): void {
  if (!isRecord(value)) return fail(path, 'expected an item object')
  const id = requireString(value, 'id', path)
  if (id === '') fail(`${path}.id`, 'must not be empty')
  const kind = requireString(value, 'kind', path)
  switch (kind) {
    case 'user':
    case 'assistant-text':
    case 'assistant-reasoning':
    case 'checkpoint':
      checkKeys(value, path, ['id', 'kind', 'text'])
      requireString(value, 'text', path)
      return
    case 'tool-call':
      checkKeys(value, path, ['id', 'kind', 'name', 'callId', 'args'])
      requireString(value, 'name', path)
      requireString(value, 'args', path)
      checkOptionalString(value, 'callId', path)
      return
    case 'tool-result': {
      checkKeys(value, path, ['id', 'kind', 'name', 'callId', 'status', 'exitCode', 'text', 'media', 'masked'])
      if (value.status !== 'ok' && value.status !== 'error') fail(`${path}.status`, 'expected "ok" or "error"')
      if (!Number.isInteger(value.media) || (value.media as number) < 0) {
        fail(`${path}.media`, 'expected a non-negative integer media count')
      }
      checkOptionalString(value, 'name', path)
      checkOptionalString(value, 'callId', path)
      checkOptionalString(value, 'text', path)
      checkOptionalInteger(value, 'exitCode', path)
      if (value.masked !== undefined && typeof value.masked !== 'boolean') {
        fail(`${path}.masked`, 'expected a boolean')
      }
      return
    }
    case 'host-context':
      checkKeys(value, path, ['id', 'kind', 'label', 'text'])
      requireString(value, 'label', path)
      requireString(value, 'text', path)
      return
    case 'opaque':
      checkKeys(value, path, ['id', 'kind', 'note'])
      requireString(value, 'note', path)
      return
    default:
      return fail(`${path}.kind`, `unknown item kind "${kind}"`)
  }
}

function checkStringList(rec: Rec, key: string, path: string): void {
  const value = rec[key]
  if (!Array.isArray(value) || value.some((each) => typeof each !== 'string')) {
    fail(`${path}.${key}`, 'expected a list of strings')
  }
}

function checkFileOps(value: unknown, path: string): void {
  if (!isRecord(value)) return fail(path, 'expected an object')
  checkKeys(value, path, ['read', 'written', 'edited'])
  for (const key of ['read', 'written', 'edited']) checkStringList(value, key, path)
}

function checkCount(rec: Rec, key: string, path: string): void {
  const value = rec[key]
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${path}.${key}`, 'expected a non-negative integer')
}

/** The persisted state of the previous compaction. Strict, and never a place for observation text. */
function checkEngineDetail(value: unknown, path: string): void {
  if (!isRecord(value)) return fail(path, 'expected an object')
  checkKeys(value, path, ['v', 'engine', 'strategy', 'checkpoints', 'stats', 'files', 'cursor'])
  if (value.v !== 1) fail(`${path}.v`, 'expected version 1')
  if (value.engine !== 'maskpoint') fail(`${path}.engine`, 'expected "maskpoint"')
  if (value.strategy !== 'mask' && value.strategy !== 'checkpoint') fail(`${path}.strategy`, 'expected "mask" or "checkpoint"')
  checkCount(value, 'checkpoints', path)
  if (!isRecord(value.stats)) return fail(`${path}.stats`, 'expected an object')
  const statKeys = ['observationsMasked', 'charsOmitted', 'candidateTokens']
  checkKeys(value.stats, `${path}.stats`, statKeys)
  for (const key of statKeys) checkCount(value.stats, key, `${path}.stats`)
  if (value.files !== undefined) checkFileOps(value.files, `${path}.files`)
  if (value.cursor !== undefined) {
    if (!isRecord(value.cursor)) return fail(`${path}.cursor`, 'expected an object')
    checkKeys(value.cursor, `${path}.cursor`, ['boundaryId', 'evictedThroughId'])
    requireString(value.cursor, 'boundaryId', `${path}.cursor`)
    requireString(value.cursor, 'evictedThroughId', `${path}.cursor`)
  }
}

/** Validate untrusted JSON as a ConversationSnapshot. Strict: unknown keys are errors, so typos surface. */
export function parseSnapshot(value: unknown): ConversationSnapshot {
  if (!isRecord(value)) return fail('snapshot', 'expected an object')
  checkKeys(value, 'snapshot', [
    'items',
    'boundary',
    'previousCheckpoint',
    'evictedThrough',
    'previousDetail',
    'fileOps',
    'customInstructions',
    'reason',
  ])

  if (!Array.isArray(value.items)) fail('snapshot.items', 'expected an array')
  const ids = new Set<string>()
  value.items.forEach((item: unknown, index: number) => {
    const path = `snapshot.items[${index}]`
    validateItem(item, path)
    const id = (item as Rec).id as string
    if (ids.has(id)) fail(`${path}.id`, `duplicate item id "${id}"`)
    ids.add(id)
  })

  if (!isRecord(value.boundary)) fail('snapshot.boundary', 'expected an object')
  checkKeys(value.boundary, 'snapshot.boundary', ['id'])
  const boundaryId = requireString(value.boundary, 'id', 'snapshot.boundary')
  if (!ids.has(boundaryId)) fail('snapshot.boundary.id', `boundary names no item: "${boundaryId}"`)

  if (value.reason !== 'manual' && value.reason !== 'threshold' && value.reason !== 'overflow') {
    fail('snapshot.reason', 'expected "manual", "threshold" or "overflow"')
  }
  if (value.previousDetail !== undefined) checkEngineDetail(value.previousDetail, 'snapshot.previousDetail')
  if (value.fileOps !== undefined) checkFileOps(value.fileOps, 'snapshot.fileOps')
  checkOptionalString(value, 'previousCheckpoint', 'snapshot')
  checkOptionalString(value, 'customInstructions', 'snapshot')
  if (value.evictedThrough !== undefined) {
    const evictedThrough = requireString(value, 'evictedThrough', 'snapshot')
    if (!ids.has(evictedThrough)) fail('snapshot.evictedThrough', `names no item: "${evictedThrough}"`)
  }
  return value as unknown as ConversationSnapshot
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Load the corpus a manifest enumerates. The manifest and the directory must agree exactly: a
 * missing file or an unlisted fixture is an error, so the corpus is always what the manifest says.
 */
export function loadCorpus(dir: string = corpusDir): CorpusFixture[] {
  const manifest = readJson(join(dir, MANIFEST))
  if (!isRecord(manifest) || !Array.isArray(manifest.fixtures)) {
    return fail(MANIFEST, 'expected { "fixtures": [...] }')
  }

  const names = new Set<string>()
  const listed = new Set<string>([MANIFEST])
  const fixtures = manifest.fixtures.map((entry: unknown, index: number): CorpusFixture => {
    const path = `${MANIFEST} fixtures[${index}]`
    if (!isRecord(entry)) return fail(path, 'expected an object')
    checkKeys(entry, path, ['name', 'file', 'description'])
    const name = requireString(entry, 'name', path)
    const file = requireString(entry, 'file', path)
    const description = requireString(entry, 'description', path)
    if (names.has(name)) fail(path, `duplicate fixture name "${name}"`)
    names.add(name)
    listed.add(file)
    if (!existsSync(join(dir, file))) fail(path, `fixture "${name}" names missing file ${file}`)
    try {
      return { name, file, description, snapshot: parseSnapshot(readJson(join(dir, file))) }
    } catch (error) {
      throw new Error(`fixture "${name}" (${file}): ${(error as Error).message}`)
    }
  })

  for (const file of readdirSync(dir)) {
    if (file.endsWith('.json') && !listed.has(file)) {
      fail(MANIFEST, `${file} exists on disk but the manifest does not enumerate it`)
    }
  }
  return fixtures
}
