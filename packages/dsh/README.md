# @maskpoint/dsh

Maskpoint as a compaction backend for [DSH](https://github.com/deepseek-ai/deepseek-harness). It
replaces the host's built-in backend and masks observation bodies into placeholders instead of
asking a model to summarize them. Tier: **native replacement**. It makes no model call today; the
budgeted checkpoint path is issue #11. Design: [`docs/design.md`](../../docs/design.md), DSH adapter.

Supported host: the published `0.1.0-rc.8` family (`@deepseek-ai/dsh-*`). DSH is at release
candidate; every claim here needs re-verifying per host release, and the tests in this package are
how (see Drift guards).

## What it does

| Entry | What happens |
|---|---|
| Automatic (pressure, overflow) | Uses the host's own trigger (threshold and retained window from the same config). Masks observations outside the retained window **in place**, per observation, by the host's prune protocol: a `compaction/prune` shadow price then a content-only `tool/result` replacement. Returns `null` (no summary ran). |
| `/compact` (idle) and explicit region | The host's compaction transaction, with masked history as the summary under a `maskpoint` / `mask-only` envelope and no summarization-call marker. |

The host's token accounting stays exact under both: the meter total, the priced surface and both
replay projections agree, and the total falls by exactly the priced delta. Tool-call/result pairing
is preserved, region edges are validated with the host's pairing predicates, and expected failures
use the host's manual-compaction error codes.

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

## Composition with the host's pruner

Correct with it mounted or not, and in either order. Its output is recognized and left as the host
wrote it; a placeholder of ours is far below its threshold, so it never wraps one. With the built-in
backend replaced, this backend runs the pruner after masking, where the built-in did.

## Known limits

- Masking only until #11: an over-budget candidate is still returned as masked history, and if
  masking leaves the surface above the trigger it says so in the log and stops.
- Statistics are logged, not persisted (`capabilities.persistMetadata` is `false`).
- An explicit compaction with nothing worth masking fails with the host's `summary` error.
- The host's trigger arithmetic, range selection and two summarizer types are restated because the
  published package does not export them.

## Drift guards (run in CI, no host binary needed)

`npm test` mounts the real DSH session store, token meter, replay projections and the session and
compaction invariant companions (the executable seam contract; a shipped host does not mount them).
Beyond behaviour, it pins: the restated trigger and range selection to the built-in backend over a
matrix of configurations, and the pruner marker to the host's constant. The exact event sequences
each entry lands are asserted, so a host release that changes the protocol fails here first.

## Manual smoke procedure (needs a DSH install)

1. `dsh plugin add @maskpoint/dsh`, then start a session on a preset copy as above.
2. Fill context past the threshold, or lower `thresholdRatio` in the `maskpoint` row's config.
3. Confirm the session log shows `compaction/prune` + `tool/result` pairs and no `compaction/summary`.
4. Run `/compact` on an idle session; confirm a `compaction/summary` with provider `maskpoint`.
5. Confirm the context meter fell and agrees with the transcript view.
