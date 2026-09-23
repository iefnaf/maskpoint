# @maskpoint/claude-code

Maskpoint for [Claude Code](https://code.claude.com): before Claude Code compacts, this generates a
masked-history artifact from the pre-compaction transcript and re-injects it as fresh context
immediately afterward.

**Tier: assisted augmentation, not native replacement.** Claude Code owns compaction end to end — a
hook cannot supply a replacement history — so the host's own summary is still produced and still
occupies context. This adapter never claims otherwise: `capabilities.replaceHistory` is `false`.

## Install

Ships as a Claude Code plugin: three hooks (`PreCompact`, `PostCompact`, `SessionStart`) plus the CLI
entrypoint they run.

```sh
npm ci && npm run build   # builds packages/core and this package's dist/
claude plugin install ./packages/claude-code
```

## What happens around a compaction

1. **`PreCompact`** reads the complete pre-compaction transcript, masks every observation into a
   placeholder (never only the ones the no-expansion rule would shrink — see below), accumulates it
   with whatever this adapter persisted last time, and writes the result to derived state on disk. It
   also prints a short, plain-text steering line to standard output. That channel is real but
   undocumented, so correctness never depends on it: turning it off with `MASKPOINT_NO_STEERING=1`
   changes nothing about the artifact path. The hook never blocks compaction and never exits nonzero,
   because the host's `PreCompact` payload cannot tell a proactive compaction from overflow recovery,
   and blocking the latter would surface the underlying request failure to the user.
2. Claude Code compacts on its own, exactly as it would with this adapter not installed.
3. **`SessionStart`** (`source: "compact"`) reads what `PreCompact` just persisted and re-injects it
   as `additionalContext`, prefaced with a note that this is supplementary, not a replacement. If the
   rendered artifact would not fit the host's 10,000-character injection cap, a short pointer at the
   persisted state file is injected instead — this adapter decides that itself rather than letting the
   host's own generic overflow-to-file handling apply, since Claude isn't asked to read that file.
4. **`PostCompact`** compares the artifact against the host's own compaction summary and appends a
   fidelity-coverage record to the audit log. It is a metric, never a correction: the host's summary
   is measured, not touched. The comparison is local and synchronous — no model call, no network —
   so it cannot delay the user's next turn. Each record also carries whether the steering channel was
   active for that compaction (`steered`), so a value decision can compare coverage with it on versus
   off rather than reading a single blended number.

Run `maskpoint-claude-code audit-summary` to aggregate everything `PostCompact` has recorded so far
— compaction count, mean coverage, the steered/unsteered coverage split, and the artifact's
duplication cost (`meanArtifactChars`, `meanHostSummaryChars`, `meanDuplicationRatio`: how large the
injected artifact is relative to what the host's own summary already produced, and
`duplicationRatioSamples`: how many compactions that ratio is actually drawn from, since a
zero-length host summary is excluded from it to avoid dividing by zero) — into the real-session
numbers the assisted-tier value decision needs (docs/design.md, Open issue 4). Each `audit.jsonl`
line already carries `artifactChars`/`hostSummaryChars` per compaction; the summary just aggregates
them.

## The steering channel

`PreCompact`'s stdout line is real but undocumented, so this adapter never lets its status go
unrecorded: every `PreCompact` run logs whether it emitted the line (`steering channel active` or
`inactive (disabled)`) and persists it (`steered`) alongside that compaction's state, and every
`PostCompact` audit record carries the same flag forward. If the channel disappears from Claude Code
entirely, that shows up as `steered: true` compactions no longer being logged rather than as silence.
Separately, if the *write itself* ever fails — a closed or broken stdout stream — the CLI reports it
by name (`undocumented steering channel unavailable on pre-compact: …`) to standard error instead of
letting it vanish into a generic top-level catch; the hook still exits 0 either way, since the
artifact path never depends on this channel.

## Why every observation is masked here, not just the ones that shrink

Everywhere else in Maskpoint, an observation is masked only when its placeholder is strictly smaller
(the no-expansion rule). This adapter's derived state is a genuine second copy of session content —
Pi and DSH persist their state inside the host's own, already-existing session store, but Claude Code
gives a hook no such place, so this adapter writes its own file. A one-line secret or a short "OK"
would pass the no-expansion rule unmasked, which is fine when it is already sitting in the host's
transcript at the same permissions, and a new exposure when it is not. So every tool-result body is
masked here, unconditionally; only the placeholder can ever reach disk.

## What is persisted

One JSON file per session under the state directory (`CLAUDE_PLUGIN_DATA/state` when installed as a
plugin, `~/.maskpoint/claude-code` otherwise), owner-only permissions (`0600` files, `0700`
directories):

```json
{
  "v": 1, "sessionId": "sess-0001",
  "detail": {
    "v": 1, "engine": "maskpoint", "strategy": "mask", "checkpoints": 0,
    "stats": { "observationsMasked": 4, "charsOmitted": 9120, "candidateTokens": 812 },
    "cursor": { "boundaryId": "__maskpoint_end__", "evictedThroughId": "…#0" }
  },
  "checkpointText": "…rendered masked history, never an observation body…",
  "steered": true,
  "updatedAt": "2026-09-21T10:30:00.000Z"
}
```

`checkpointText` is masked history: every observation body has already been replaced by a placeholder
before this is written, so nothing here is a second copy of raw tool output. A separate
`audit.jsonl` in the same directory holds one line per `PostCompact` fidelity record; neither file
ever contains an observation body, a credential, or an environment dump.

## Configuration

Settings live in Claude Code's own `settings.json`, not a new file: a `maskpoint` field, read
directly off disk rather than through the host's already-merged environment. Global
`~/.claude/settings.json`; project `.claude/settings.json`, overridden field-by-field by
`.claude/settings.local.json`. The project layer always applies here — a hook only runs after the
host's own directory-trust dialog has already been accepted for that project, so the trust gate
Maskpoint's config rule exists to enforce (docs/design.md, Security and privacy) has already run by
the time this code does.

```json
{
  "maskpoint": {
    "enabled": true,
    "compactBudgetTokens": 24000,
    "maskReasoning": false,
    "notificationLevel": "normal"
  }
}
```

- `enabled: false` makes `PreCompact` a pure no-op: no transcript read, no state written, no steering
  line — nothing for `SessionStart` or `PostCompact` to find on a later hook invocation either.
- `compactBudgetTokens` is the budget `decide()` compares the masked-history candidate against;
  lowering it flips `overBudget` from `false` to `true` in the persisted `details` and in the log line
  sooner. This adapter has no checkpoint call yet, so it never triggers one — see "Not yet" below.
- `checkpointModel` is accepted and validated, but unused: there is nothing to point it at until this
  adapter makes a model call of its own.
- `maskReasoning: true` masks assistant reasoning as well as observations, each becoming
  `[reasoning omitted: N lines, M chars]`. Off by default because it trades the rationale behind the
  work for context; the measurement is [`docs/reasoning-masking-evaluation.md`](../../docs/reasoning-masking-evaluation.md).
- `notificationLevel: "silent"` suppresses the routine `PreCompact`/`SessionStart`/`PostCompact` log
  lines; a decline is never suppressed.
- An invalid value (wrong type, out of range, an unrecognized key) warns to the adapter's own log and
  falls back to the documented default; it never fails the hook.

## When it steps aside

A pre-compaction run degrades to a silent no-op — no state written, no injection later — rather than
ever blocking or failing loudly, since correctness here never depends on this adapter:

| Reason | Meaning |
|---|---|
| `unreadable-snapshot` | The transcript file could not be opened at all. |
| `inconsistent-cursor` | Previously persisted state and its cursor disagree, so appending would risk double-counting or dropping history. |
| `nothing-to-compact` | There is nothing evicted and no previous state to carry forward. |
| `engine-failure` | An unexpected fault. Contained; nothing else in the session is affected. |

An over-budget candidate or a requested focus (`/compact <focus>`) is *not* a decline: this adapter
has no checkpoint call yet, so both still return the masked-history artifact, only flagged as such.

## Not yet

A budgeted checkpoint call: Claude Code's hook protocol gives a command process no documented seam to
call the session's model through, so this version never spends one. Until an adapter-native model
call exists, every compaction that crosses the budget or carries a focus still returns masked history.

## Tests

`npm test` from the repository root. Seam 1 (masking, accumulation, budget) is `packages/core/test`;
this package's own tests cover transcript normalization, the pre-compaction decision, derived-state
persistence and permissions, and the three hooks' stdin-to-stdout contract end to end.
