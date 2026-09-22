# @maskpoint/codex

Maskpoint for [Codex CLI](https://developers.openai.com/codex): pushes a preservation directive into
Codex's own compaction prompt where its configuration allows, and re-injects a masked-history
artifact after Codex compacts.

**Tier: assisted augmentation, not native replacement.** Codex owns compaction end to end — `PreCompact`
can only block compaction (`continue: false`), never supply a replacement history — so Codex's own
summary is still produced and still occupies context. This adapter never claims otherwise:
`capabilities.replaceHistory` is `false`.

## Install

Ships as a Codex plugin: three hooks (`PreCompact`, `PostCompact`, `SessionStart`) plus the CLI
entrypoint they run, discovered from `hooks/hooks.json` inside the plugin root per Codex's plugin
convention (`.codex-plugin/plugin.json`).

```sh
npm ci && npm run build   # builds packages/core and this package's dist/
codex plugin add ./packages/codex
```

To let this adapter's preservation directive actually reach Codex's own compaction prompt (see
"Preservation instructions" below), add to your **global** `~/.codex/config.toml` (or
`$CODEX_HOME/config.toml`):

```toml
experimental_compact_prompt_file = "~/.codex/maskpoint/compact-prompt.md"
```

This step is optional: without it, everything else in this adapter (the artifact, its persistence,
and re-injection after compaction) still works, and `PreCompact` reports `wired: false` so the gap is
visible rather than silently assumed away.

## What happens around a compaction

1. **`PreCompact`** reads the complete pre-compaction rollout (Codex's session transcript, `.jsonl`
   under `transcript_path`), masks every observation into a placeholder (never only the ones the
   no-expansion rule would shrink — see below), accumulates it with whatever this adapter persisted
   last time, and writes the result to derived state on disk. It also writes (or repairs, if a
   previous run's file was deleted or hand-edited) a managed compaction-prompt file and checks
   whether Codex's own `config.toml` is actually configured to read it — the "wiring" check. The
   hook never blocks compaction and never exits nonzero: `PreCompact` fires before *both* local and
   remote compaction, and this adapter must remain correct whichever one Codex ends up running.
2. Codex compacts on its own, exactly as it would with this adapter not installed — either locally
   (a plaintext summary) or remotely (an opaque, provider-encrypted result; see "Provider-side
   compaction" below).
3. **`SessionStart`** (`source: "compact"`) reads what `PreCompact` just persisted and re-injects it
   as `additionalContext`, prefaced with a note that this is supplementary, not a replacement. Codex
   documents no character limit for this field (unlike Claude Code's documented 10,000-character
   cap); this adapter still enforces a practical, undocumented ceiling on itself
   (`PRACTICAL_INJECTION_CEILING`) so a pathologically large artifact is never injected whole —
   pointing at the persisted state file instead when it would be exceeded.
4. **`PostCompact`** re-reads the rollout and looks for the compaction result Codex just produced.
   When it is a plaintext summary, this adapter compares it against the artifact and appends a
   fidelity-coverage record to the audit log — a metric, never a correction. When it is an opaque
   remote-compaction item, no text comparison is possible; the audit log records that instead, so
   "no coverage number" is never confused with "zero coverage".

## Preservation instructions: pushed into Codex's own compaction prompt

Codex documents `experimental_compact_prompt_file` as a **full override** of its built-in compaction
prompt — not an addition to it — so this adapter cannot append a one-line steering directive into
Codex's existing prompt the way the Claude Code adapter nudges a summarizer through an undocumented
stdout channel. Instead, the managed file (`$CODEX_HOME/maskpoint/compact-prompt.md`) contains a
complete, reasonable compaction prompt: the same fixed structure the engine's own checkpoint call
uses (user context, completed/pending work, code and test state, decisions, next steps), with
Maskpoint's preservation directive appended. Shipping only the directive, with no summarization
instructions to carry it, would leave Codex's compaction worse than before this adapter was
installed — the opposite of "never worse than not installed".

The directive is **static**, not session-specific: it asks Codex to preserve exact paths,
identifiers, command lines and test-failure text, and to treat masked placeholders in earlier history
as deliberate omissions. The actual session content lives in the artifact, injected separately and
correctly per-session through `SessionStart` (step 3 above) — a shared global prompt file has no safe
way to carry per-session state across concurrent Codex sessions, so this adapter does not try.

Only the **global** config (`$CODEX_HOME/config.toml`) is consulted for the wiring check — never a
project's `.codex/config.toml` — so an untrusted repository's configuration can never affect what
this adapter reports or does (docs/design.md, "Threat: an untrusted repository"). The check only
resolves an absolute or `~/`-prefixed `experimental_compact_prompt_file` value with confidence — the
install snippet above uses `~/.codex/...` for exactly this reason. A bare relative path is reported
as `wired: false` (`reason: "ambiguous-relative-path"`) rather than guessed at: this adapter has no
confirmed evidence for what Codex resolves a relative path against.

## Provider-side compaction: opaque or readable

Codex has (at least) three compaction paths, selected by the host itself, not by this adapter:
a **remote v2** path (the default for OpenAI/Azure-Responses providers) that returns an encrypted,
provider-opaque result; an older **remote v1** path that returns a plaintext summary; and a **local**
path (non-OpenAI providers) that also returns a plaintext summary. This adapter does not predict
which one is active from auth mode or config ahead of time — it observes what actually happened, by
re-reading the rollout in `PostCompact` for the newest compaction result:

| What `PostCompact` finds | `providerCompaction` |
|---|---|
| A `compaction`/`compaction_summary` rollout item | `opaque` — Codex's own result is unreadable to this adapter |
| A plaintext summary message | `readable` — compared against the artifact for the coverage audit |
| Neither | `undetermined` |

Every audit record also carries `modelProvider`, read from the rollout's own `session_meta` line
(e.g. `"openai"`) — the closest reading available to a hook of "the current authentication mode",
since which compaction path Codex selects is a function of the active provider rather than of
ChatGPT-login-vs-API-key directly. Pairing `providerCompaction` with the provider it was actually
observed under is how this adapter reports honestly for "the current authentication mode": by
attaching the context a finding was made under, not by asserting a mode-to-behavior rule this
adapter has not verified across both authentication modes (docs/design.md, Open issue 3 remains
open — the next step there is measurement over real sessions in both modes, not more code).

The plaintext-summary detection is a best-effort match on wording Codex's local/remote-v1 path is
known to use, not a schema Codex publishes for it; a wording change on Codex's side degrades this to
`undetermined` rather than misreporting either other state.

## Why every observation is masked here, not just the ones that shrink

Everywhere else in Maskpoint, an observation is masked only when its placeholder is strictly smaller
(the no-expansion rule). This adapter's derived state is a genuine second copy of session content —
Pi and DSH persist their state inside the host's own, already-existing session store, but Codex gives
a hook no such place, so this adapter writes its own file. A one-line secret or a short "OK" would
pass the no-expansion rule unmasked, which is fine when it is already sitting in Codex's own rollout
at the same permissions, and a new exposure when it is not. So every tool-result body is masked here,
unconditionally; only the placeholder can ever reach disk.

## What is persisted

One JSON file per session under the state directory (`$PLUGIN_DATA/state` when installed as a plugin,
`$CODEX_HOME/maskpoint/state` otherwise), owner-only permissions (`0600` files, `0700` directories):

```json
{
  "v": 1, "sessionId": "0199...-session-uuid",
  "detail": {
    "v": 1, "engine": "maskpoint", "strategy": "mask", "checkpoints": 0,
    "stats": { "observationsMasked": 4, "charsOmitted": 9120, "candidateTokens": 812 },
    "cursor": { "boundaryId": "__maskpoint_end__", "evictedThroughId": "3#0" }
  },
  "checkpointText": "…rendered masked history, never an observation body…",
  "updatedAt": "2026-09-21T10:30:00.000Z"
}
```

`checkpointText` is masked history: every observation body has already been replaced by a placeholder
before this is written, so nothing here is a second copy of raw tool output. A separate
`audit.jsonl` in the same directory holds one line per `PostCompact` record; neither file ever
contains an observation body, a credential, or an environment dump. The managed compact-prompt file
(`$CODEX_HOME/maskpoint/compact-prompt.md`) carries no session content at all — see above.

## When it steps aside

A pre-compaction run degrades to a silent no-op — no state written, no injection later — rather than
ever blocking or failing loudly, since correctness here never depends on this adapter:

| Reason | Meaning |
|---|---|
| `unreadable-snapshot` | The rollout file could not be opened at all. |
| `inconsistent-cursor` | Previously persisted state and its cursor disagree, so appending would risk double-counting or dropping history. |
| `nothing-to-compact` | There is nothing evicted and no previous state to carry forward. |
| `engine-failure` | An unexpected fault. Contained; nothing else in the session is affected. |

An over-budget candidate or a requested focus (custom compaction instructions) is *not* a decline:
this adapter has no checkpoint call yet, so both still return the masked-history artifact, only
flagged as such. A missing or changed `experimental_compact_prompt_file` wiring degrades to
`wiring.wired: false`, never to a decline — the artifact and its re-injection are unaffected.

## Not yet

A budgeted checkpoint call: Codex's hook protocol gives a command process no documented seam to call
the session's model through, so this version never spends one. Until an adapter-native model call
exists, every compaction that crosses the budget or carries a focus still returns masked history.

## Evidence

Codex's `PreCompact`/`PostCompact`/`SessionStart` hook shapes, the plugin discovery convention
(`hooks/hooks.json`, `PLUGIN_ROOT`/`PLUGIN_DATA` environment variables), and the
`experimental_compact_prompt_file`/`compact_prompt` configuration keys are drawn from Codex's own
hooks and configuration documentation. The rollout `response_item` shape (`type`, `payload.type`,
`payload.role`, `payload.content`) was checked against a real local Codex session file. The
remote-v2/remote-v1/local compaction path distinction, the `compaction`/`compaction_summary` item
type with `encrypted_content`, and the `remote_compaction_v2` feature flag are drawn from third-party
technical analysis of Codex's compaction behaviour, not from a primary schema Codex publishes for it
— hence this adapter's detection degrading to `undetermined` rather than asserting a wrong answer
when the evidence it looks for is not where it expects (docs/design.md, Open issue 3, remains open:
this adapter observes what happened per compaction rather than resolving the question in general).

## Tests

`npm test` from the repository root. Seam 1 (masking, accumulation, budget) is `packages/core/test`;
this package's own tests cover rollout normalization, the pre-compaction decision, compact-prompt
wiring detection, provider-compaction detection, derived-state persistence and permissions, and the
three hooks' stdin-to-stdout contract end to end.
