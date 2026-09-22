# @maskpoint/dsh

Maskpoint as a compaction backend for [DSH](https://github.com/deepseek-ai/deepseek-harness). It
replaces the host's built-in backend and masks observation bodies into placeholders instead of
asking a model to summarize them. Tier: **native replacement**. Automatic compaction stays
model-free; `/compact` and explicit region compaction fall back to one budgeted checkpoint call,
through the host's own LLM seam, when masking alone is not enough. Design:
[`docs/design.md`](../../docs/design.md), DSH adapter.

Supported host: the published `0.1.0-rc.8` family (`@deepseek-ai/dsh-*`). DSH is at release
candidate; every claim here needs re-verifying per host release, and the tests in this package are
how (see Drift guards).

## What it does

| Entry | What happens |
|---|---|
| Automatic (pressure, overflow) | Uses the host's own trigger (threshold and retained window from the same config). Masks observations outside the retained window **in place**, per observation, by the host's prune protocol: a `compaction/prune` shadow price then a content-only `tool/result` replacement. Returns `null` (no summary ran). Model-free, always — the prune protocol has no way to carry a model-authored checkpoint. |
| `/compact` (idle) and explicit region | The host's compaction transaction. Masks, then returns masked history as the summary under a `maskpoint` / `mask-only` envelope with no summarization-call marker — unless the candidate is over budget, in which case one checkpoint call condenses it through the host's LLM seam and is recorded with a real envelope (provider, model, generation cap) and usage. A rejected call (provider error, abort, output truncated, tool call, empty text) falls back to the masked-history landing; a checkpoint is never left empty or partial. |

The host's token accounting stays exact under both: the meter total, the priced surface and both
replay projections agree, and the total falls by exactly the priced delta. Tool-call/result pairing
is preserved, region edges are validated with the host's pairing predicates, and expected failures
use the host's manual-compaction error codes.

The checkpoint call uses the session's own routed model by default, or a configured summarization
provider/model when set; a fresh routing identity per call (never the session id); the host's own
cancellation signal; and no agent tools.

## Install

The backend must replace the built-in one (a context allows one backend), so there are two ways in.

**Host plane (a profile).** Install the package into a profile and add its bundle:

```sh
dsh plugin add @maskpoint/dsh
```

The bundle patch (`cordis.patch.yml`) disables the `compaction-basic` row and inserts ours. Any
`config` you gave `compaction-basic` moves to the `maskpoint` row unchanged; it reads the same
settings.

**Agent presets.** The shipped `standard`, `code` and `cordis` presets mount the built-in backend
inside their own isolated `compaction` realm, which a bundle patch does not reach. Copy a preset
and change one row's `name`:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@maskpoint/dsh'        # was '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner        # optional; keep it if you had it
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

A preset row's bare package name resolves from the host base (the profile directory), which is where
`dsh plugin add` installs it.

## Configuration

Three fields on the row's own `config:` — no new file, the same block `compaction-basic` already
reads:

```yaml
- id: compaction-basic
  name: '@maskpoint/dsh'
  config:
    enabled: true
    checkpointTriggerTokens: 12000
    maskReasoning: false
    notificationLevel: normal
    # host fields, unchanged: thresholdRatio, retainRatio/retainTokens, summarizationProvider,
    # summarizationModel, maxTokens, compactionRetries, maxOverflowRetries, modelPolicies, auto
```

- `enabled: false` makes both `compactIfNeeded` and `summarize` delegate straight to `super` — the
  unmodified built-in backend this class extends, with no masking, no checkpoint, and nothing of
  Maskpoint's left in session state.
- `checkpointTriggerTokens` is `decide()`'s budget for the explicit paths (`/compact`, region
  compaction): lower it and the same conversation crosses from a masked-history landing into a
  checkpoint call.
- `maskReasoning: true` masks assistant reasoning as well as observations, each becoming
  `[reasoning omitted: N lines, M chars]`. Off by default because it trades the rationale behind the
  work for context; the measurement is [`docs/reasoning-masking-evaluation.md`](../../docs/reasoning-masking-evaluation.md).
- There is no separate `checkpointModel` here: the host's own `summarizationProvider` /
  `summarizationModel` already say who writes a checkpoint, and this backend reads them unchanged.
- `notificationLevel: "silent"` suppresses the routine per-compaction `info` log lines; warnings are
  never suppressed.
- These three are declared loosely on purpose, not type-checked by cordis's own loader: an invalid
  value warns once through the host's logger and the field falls back to its default, rather than
  refusing to load the whole backend over one bad setting.
- Only one config layer reaches this plugin (cordis hands a row's `config:` to it already merged),
  so — unlike Claude Code — there is no global-versus-project distinction or trust rule to apply here;
  see Known limits.

## Composition with the host's pruner

Correct with it mounted, absent, or already run earlier in the session. Its output is recognized by
its exact marker and left as the host wrote it; a placeholder of ours is far below its threshold,
so it never wraps one. With the built-in backend replaced, this backend runs the pruner after
masking, where the built-in ran it before compacting.

## Known limits

- Automatic (pressure/overflow) compaction is masking-only, permanently: the prune protocol it lands
  through cannot express a model-authored checkpoint. If masking alone leaves the surface above the
  trigger, it says so in the log; an idle `/compact` or explicit region compaction is what brings a
  stuck session back down.
- Statistics are logged for every compaction, not persisted (`capabilities.persistMetadata` is
  `false`); the checkpoint's provider, model, generation cap and usage are durable on the host's own
  `compaction/summary` event, independent of that flag.
- An explicit compaction with nothing worth masking fails with the host's `summary` error.
- The host's trigger arithmetic, range selection and two summarizer types are restated because the
  published package does not export them.
- No global-versus-project configuration trust rule: cordis hands this plugin one already-merged
  `config:` object with no signal for which layer set a field, so a project-local preset copy is
  trusted the same as the host-plane profile that installed the plugin at all. Treat a project-local
  preset with the same care as installing the plugin (docs/design.md, Configuration — "As built #8").

## Drift guards (run in CI, no host binary needed)

`npm test` mounts the real DSH session store, token meter, replay projections and the session and
compaction invariant companions (the executable seam contract; a shipped host does not mount them).
Beyond behaviour, it pins: the restated trigger and range selection to the built-in backend over a
matrix of configurations (comparing which observations each masks), the pruner marker to the host's
constant, and the rendered text's size to what the engine's budget measured. The exact event sequences
each entry lands are asserted, so a host release that changes the protocol fails here first.

## Manual smoke procedure (needs a DSH install)

1. `dsh plugin add @maskpoint/dsh`, then start a session on a preset copy as above.
2. Fill context past the threshold, or lower `thresholdRatio` in the `maskpoint` row's config.
3. Confirm the session log shows `compaction/prune` + `tool/result` pairs and no `compaction/summary`.
4. Run `/compact` on an idle session with modest history; confirm a `compaction/summary` with
   provider `maskpoint`, model `mask-only`, no usage.
5. Repeat `/compact` after enough turns that the accumulated masked history passes the 12,000-token
   checkpoint budget (or force it via a large single observation); confirm a `compaction/summary`
   with the session's own provider/model, `usage` present, and the checkpoint text — not a
   placeholder list — as the session's new context.
6. Confirm the context meter fell and agrees with the transcript view after each.
