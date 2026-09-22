import { type Artifact, artifactCandidateText, type Renderer } from '@maskpoint/core'

/**
 * Pi's summary text. Sections keep their order: the state carried from the previous compaction
 * comes first, verbatim, and the newly evicted history follows under the history framing, each
 * item under its role label.
 *
 * This is exactly the text the engine measured for the budget (`artifactCandidateText`), so
 * `candidateTokens` in the persisted detail is the size of what Pi was given.
 */
export const summaryRenderer: Renderer<string> = {
  render: (artifact: Artifact): string => artifactCandidateText(artifact),
}
