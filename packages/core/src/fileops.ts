import type { FileOps } from './vocabulary.js'

const union = (earlier: readonly string[], later: readonly string[]): string[] => [...new Set([...earlier, ...later])]

/**
 * Merge, never replace: what earlier compactions recorded stays, and the host's newer operations
 * are added after it. Order is first-seen, duplicates are dropped, and inputs are never mutated.
 * Returns undefined when neither side has any, so that a session with no file tracking persists none.
 */
export function mergeFileOps(earlier: FileOps | undefined, later: FileOps | undefined): FileOps | undefined {
  if (earlier === undefined && later === undefined) return undefined
  return {
    read: union(earlier?.read ?? [], later?.read ?? []),
    written: union(earlier?.written ?? [], later?.written ?? []),
    edited: union(earlier?.edited ?? [], later?.edited ?? []),
  }
}
