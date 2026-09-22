import { type Artifact, artifactCandidateText, type Renderer } from '@maskpoint/core'

/**
 * The artifact as plain markdown: the state carried from the previous compaction first, verbatim,
 * then the newly evicted history under the history framing, each item under its role label. This is
 * both what this adapter persists as `previousCheckpoint` for the next compaction and, wrapped by
 * `injectedContext`, what gets re-injected after Codex compacts.
 */
export const artifactRenderer: Renderer<string> = {
  render: (artifact: Artifact): string => artifactCandidateText(artifact),
}

/** Introduces the artifact when it is injected as fresh context after Codex's own compaction. */
const PREFACE =
  'Maskpoint (assisted augmentation — the summary above is Codex\'s own; this is supplementary ' +
  'context Maskpoint preserved and is not a replacement for it):'

/** The full injected string: preface plus the rendered artifact. */
export function injectedContext(rendered: string): string {
  return `${PREFACE}\n\n${rendered}`
}

/** A short pointer used instead, when the full injected string would risk exceeding a practical ceiling. */
export function injectedPointer(statePath: string, chars: number): string {
  return (
    `${PREFACE}\n\nThe full pre-compaction artifact (${chars} characters) did not fit the injection ` +
    `ceiling, so it was not inlined. It is saved at ${statePath}.`
  )
}

/**
 * Codex documents no character limit for a hook's `additionalContext` (unlike Claude Code's
 * documented 10,000-character `SessionStart` cap). This is a practical, undocumented ceiling this
 * adapter enforces on itself so a pathologically large artifact is never injected whole; it is not a
 * claimed host limit (docs/design.md, Open issue 7 names the analogous Claude Code channel as "real
 * but undocumented" — the same caution applies here, one level further: even its presence at all is
 * unconfirmed for Codex, so nothing about correctness depends on this number being right).
 *
 * The value is deliberately the Claude Code adapter's *documented* number, reused here only as a
 * reasonable starting point pending real calibration against Codex (docs/design.md, "Quality bars
 * and measurement" names estimator/meter calibration as ongoing work generally) — not because
 * anything ties the two hosts' limits together. `capabilities.injectionCapChars` in `compact.ts` is
 * deliberately left unset rather than mirroring this constant: that field means a host-*documented*
 * cap, and setting it here would overstate this number's certainty.
 */
export const PRACTICAL_INJECTION_CEILING = 10_000
