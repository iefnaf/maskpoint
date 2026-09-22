import { type Artifact, artifactCandidateText, type Renderer } from '@maskpoint/core'

/**
 * The artifact as plain markdown: the state carried from the previous compaction first, verbatim,
 * then the newly evicted history under the history framing, each item under its role label. This is
 * both what this adapter persists as `previousCheckpoint` for the next compaction and, wrapped by
 * `injectedContext`, what gets re-injected after the host compacts.
 *
 * This is exactly the text the engine measured for the budget (`artifactCandidateText`), so a
 * persisted `candidateTokens` describes the size of what this function produced.
 */
export const artifactRenderer: Renderer<string> = {
  render: (artifact: Artifact): string => artifactCandidateText(artifact),
}

/** Introduces the artifact when it is injected as fresh context after the host's own compaction. */
const PREFACE =
  'Maskpoint (assisted augmentation — the summary above is the host\'s own; this is supplementary ' +
  'context Maskpoint preserved and is not a replacement for it):'

/** The full injected string: preface plus the rendered artifact. */
export function injectedContext(rendered: string): string {
  return `${PREFACE}\n\n${rendered}`
}

/** A short pointer used instead, when the full injected string would not fit the host's cap. */
export function injectedPointer(statePath: string, chars: number): string {
  return (
    `${PREFACE}\n\nThe full pre-compaction artifact (${chars} characters) did not fit the injection ` +
    `cap, so it was not inlined. It is saved at ${statePath}.`
  )
}
