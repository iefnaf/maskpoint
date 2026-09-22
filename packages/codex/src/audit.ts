import { isRecord, type Rec } from './normalize.js'

/**
 * What this adapter could determine about Codex's own compaction path for one event, by reading the
 * rollout after compaction rather than by inferring it from config or auth mode beforehand — the
 * same "observe what actually happened" approach the design's other audits use (docs/design.md,
 * Open issue 3: "run both authentication modes, inspect a rollout, and compare").
 *
 * `opaque`: the rollout carries a `compaction`/`compaction_summary` item whose body is an encrypted
 * blob — Codex's remote compaction path (feature `remote_compaction_v2`), provider-opaque even to
 * this adapter. `readable`: a plaintext compaction summary was found (local compaction, or the
 * older remote-v1 path, both of which return readable text). `undetermined`: no compaction marker
 * was found at all in the rollout this adapter re-read.
 */
export type ProviderCompaction = 'opaque' | 'readable' | 'undetermined'

export interface CompactionFinding {
  providerCompaction: ProviderCompaction
  /** The readable host summary text, when `providerCompaction` is `'readable'`. */
  hostSummaryText?: string
}

const COMPACTION_ITEM_TYPES = new Set(['compaction', 'compaction_summary'])

/**
 * The `model_provider` a rollout's own `session_meta` line records for the session, e.g. `"openai"`.
 * This is the closest thing this adapter can read to "the current authentication mode": which
 * compaction path Codex selects is a function of the provider (and feature-flag defaults) rather
 * than of ChatGPT-vs-API-key auth directly, so pairing the observed `providerCompaction` finding
 * with the provider that was actually active is how this adapter reports "for the current
 * authentication mode" honestly — by attaching the context it was observed under, not by predicting
 * it ahead of time (see `CompactionFinding` above and docs/design.md, Open issue 3).
 */
export function findModelProvider(entries: readonly Rec[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === 'session_meta' && isRecord(entry.payload) && typeof entry.payload.model_provider === 'string') {
      return entry.payload.model_provider
    }
  }
  return undefined
}

/**
 * A distinctive fragment of the message Codex's local (and remote-v1) compaction path prepends to
 * its plaintext summary. Best-effort: sourced from observed Codex behaviour, not from a primary
 * schema Codex publishes for it, so a wording change on Codex's side degrades this to
 * `'undetermined'` rather than misreporting `'readable'` or `'opaque'`.
 */
const LOCAL_SUMMARY_MARKER = 'compacted into the following summary'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Scan a (post-compaction) rollout's `response_item` entries for the last compaction result, and
 * report what this adapter could tell about it. Order matters: a rollout can carry more than one
 * compaction over a long session, and only the most recent one describes what just happened.
 */
export function findCompactionResult(entries: readonly Rec[]): CompactionFinding {
  let finding: CompactionFinding = { providerCompaction: 'undetermined' }
  for (const entry of entries) {
    if (entry.type !== 'response_item' || !isRecord(entry.payload)) continue
    const payload = entry.payload
    if (typeof payload.type === 'string' && COMPACTION_ITEM_TYPES.has(payload.type)) {
      finding = { providerCompaction: 'opaque' }
      continue
    }
    if (payload.type === 'message') {
      const text = textOf(payload.content)
      if (text.toLowerCase().includes(LOCAL_SUMMARY_MARKER)) finding = { providerCompaction: 'readable', hostSummaryText: text }
    }
  }
  return finding
}

/**
 * Post-compaction fidelity audit: how much of what Maskpoint's artifact preserved also survived
 * into Codex's own compaction summary. Only meaningful when that summary is readable; a metric,
 * never a correction — Codex's own summary is never touched, only measured (mirrors the Claude Code
 * adapter's `audit.ts`).
 */
export interface DriftMetric {
  artifactChars: number
  hostSummaryChars: number
  /** Distinct salient terms found in the artifact: file paths, identifiers, and words of some length. */
  salientTerms: number
  /** How many of those terms also appear, as a substring, in Codex's own summary. */
  coveredTerms: number
  /** `coveredTerms / salientTerms`, or 1 when there were no salient terms to lose. */
  coverage: number
}

/** A path-like or identifier-like token worth checking for survival: not stray punctuation or short words. */
const SALIENT_TERM = /[\w./-]{4,}/g

function salientTermsOf(text: string): Set<string> {
  return new Set(text.match(SALIENT_TERM) ?? [])
}

export function auditDrift(artifactText: string, hostSummary: string): DriftMetric {
  const terms = salientTermsOf(artifactText)
  const covered = [...terms].filter((term) => hostSummary.includes(term)).length
  return {
    artifactChars: artifactText.length,
    hostSummaryChars: hostSummary.length,
    salientTerms: terms.size,
    coveredTerms: covered,
    coverage: terms.size === 0 ? 1 : covered / terms.size,
  }
}
