# @maskpoint/pi

Maskpoint for [Pi](https://github.com/earendil-works/pi): when Pi compacts, stale tool output is
replaced by short placeholders, and a model is called only when accumulated history crosses the
checkpoint budget or you asked `/compact` for a focus.

**Tier: native replacement.** Pi lets an extension return its own compaction result, so this
replaces Pi's summarize step rather than sitting beside it.

## Install

The extension is TypeScript source that Pi loads itself, so there is no build step for it.

```sh
pi install npm:@maskpoint/pi          # from npm
pi install ./packages/pi              # from a checkout (run `npm ci && npm run build` once first:
                                      # the workspace resolves @maskpoint/core through its built output)
pi -e ./packages/pi                   # or try it for one run
```

It handles all three triggers Pi has, through the one pre-compaction event: `/compact`, the
automatic threshold, and overflow recovery.

## What a compaction does

- Everything before Pi's cut point is rendered as **masked history**: user messages, assistant text,
  assistant reasoning and tool calls are kept word for word; each tool result becomes a placeholder
  such as `[tool result omitted: read, ok, 72 lines, 2201 chars]`. A result is only masked if the
  placeholder is smaller, images are always dropped, and a command you ran with `!` keeps the command
  and masks its output.
- Assistant reasoning is kept by default and masked too when `maskReasoning` is set, becoming
  `[reasoning omitted: 41 lines, 1203 chars]`. Reasoning is the part of a long session that exists
  only in prose, so it is the operator's call rather than a silent default; the measurement behind
  the trade-off is [`docs/reasoning-masking-evaluation.md`](../../docs/reasoning-masking-evaluation.md)
  (no cost to continuation, better state recall, prompt tokens down to a third — checkpoint summary
  quality untested, which is why the default is off).
- Pi's cut point (`firstKeptEntryId`) is returned **exactly as Pi prepared it**. Maskpoint never
  chooses what Pi keeps.
- The next compaction keeps the previous summary verbatim and appends only what has been evicted
  since, so a full observation never re-enters the summary. This survives Pi's own compactor running
  in between: the adapter reaches back to the latest compaction entry on the branch whose details it
  recognizes as its own, so a checkpoint count or file list is never lost to a summary Pi wrote.
- Context strictly shrinks: if the result would not be smaller than what it replaces, Maskpoint
  steps aside.
- Read, written and edited files Pi tracked for the span are merged into the earlier lists (union,
  first-seen order) and carried in `details.files`.
- When the accumulated candidate crosses the checkpoint budget, or you gave `/compact` a focus,
  Maskpoint makes exactly one model call — through Pi's own configured model, never a network
  destination of its own — to condense everything into a structured checkpoint. A call that errors,
  aborts, is cut off by its output cap, calls a tool, or comes back empty is discarded, and the
  masked history is returned instead; the entry's details and the interactive notice both say when
  that happened.

## What is recorded

The compaction entry's `details` holds the engine's state, never any observation content. A
mask-only compaction:

```json
{
  "v": 1, "engine": "maskpoint", "strategy": "mask", "checkpoints": 0,
  "stats": { "observationsMasked": 3, "charsOmitted": 3578, "candidateTokens": 367 },
  "cursor": { "boundaryId": "50aaf998#0", "evictedThroughId": "2d72180b#0" }
}
```

A compaction that ran a checkpoint has `"strategy": "checkpoint"` and a `checkpoints` count one
higher than the previous compaction's. `fromHook` is `true`, and `usage` on the entry is the
provider's own accounting for the checkpoint call — tokens and cost — handed back to Pi unchanged so
its session totals count the summarization work. To look at one:

```sh
jq -c 'select(.type=="compaction") | {fromHook, usage, details}' ~/.pi/agent/sessions/<project>/<session>.jsonl
```

In an interactive session Maskpoint also says what it did (`Maskpoint masked 3 observations (3578
chars omitted), ~367 tokens kept, no model call.`, or, when a checkpoint ran, `...condensed into a
checkpoint with one model call.`).

## When it steps aside

Returning nothing is Pi's documented fallback: Pi's own compactor runs, exactly as if this extension
were not installed. A session is never left without a compaction. Maskpoint steps aside, and says why,
when:

| Reason | Meaning |
|---|---|
| `unreadable-snapshot` | The history has a shape it does not recognize or cannot reconcile with what Pi prepared (an unknown message role or content block, a cut point that is not on the branch, a different message count than Pi's). |
| `inconsistent-cursor` | The previous compaction has no summary to build on, or where it left off cannot be trusted. |
| `no-size-reduction` | The result would not be smaller than what it replaces. |
| `engine-failure` | An unexpected fault. It is contained; Pi compacts. |

A checkpoint call that is attempted and not accepted (a provider error, an abort, a length stop, a
tool call, or an empty reply) is not a decline: Maskpoint still returns the masked history, with a
note on why no checkpoint ran.

## Configuration

Pi gives an extension no settings of its own: a real release supplies no `config` on the handler's
context — only its own `{ enabled, reserveTokens, keepRecentTokens }` at `event.preparation.settings`
— and unknown keys in `settings.json` are dropped before a hook ever sees them (issue #39). So
Maskpoint reads three channels, lowest precedence first:

1. **The host object** — `PiContext.config`, if a future Pi release ever supplies one. Kept first so
   that day needs no change here.
2. **The environment** — one variable per setting, for a preference you want on every run:

   ```sh
   export MASKPOINT_COMPACT_BUDGET_TOKENS=20000      # keep more compactions free of model calls
   # (MASKPOINT_CHECKPOINT_TRIGGER_TOKENS still works, with a deprecation warning)
   export MASKPOINT_NOTIFICATION_LEVEL=silent         # quiet notices; a decline still shows
   ```

3. **This extension's CLI flags** — they appear in `pi --help` and win for the run they were typed on:

   ```sh
   pi --maskpoint-checkpoint-trigger-tokens 20000
   pi --maskpoint-enabled false
   ```

| Setting | Environment | Flag | Default |
|---|---|---|---|
| `enabled` | `MASKPOINT_ENABLED` | `--maskpoint-enabled` | `true` |
| `compactBudgetTokens` | `MASKPOINT_COMPACT_BUDGET_TOKENS` | `--maskpoint-compact-budget-tokens` | a quarter of the model's window, clamped to [24000, 96000]; `24000` when the window is unknown |
| `checkpointModel` | `MASKPOINT_CHECKPOINT_MODEL` | `--maskpoint-checkpoint-model` | the session's model |
| `maskReasoning` | `MASKPOINT_MASK_REASONING` | `--maskpoint-mask-reasoning` | `false` |
| `notificationLevel` | `MASKPOINT_NOTIFICATION_LEVEL` | `--maskpoint-notification-level` | `normal` |

Boolean and numeric values are read as text from both channels, where `true`/`false`, `1`/`0`, and a
plain non-negative integer are the spellings that parse. Each field is validated on its own: an
invalid value warns through the UI (when there is one) and leaves the next-more-authoritative layer,
or the documented default, standing — never a failed compaction. With the settings in hand, the
behaviour is as described above: raising `compactBudgetTokens` moves the same conversation from a
checkpoint into a mask-only result with no model call, `enabled: false` skips compaction entirely
(the same as not being installed: no notification, no compaction entry), and
`notificationLevel: "silent"` suppresses the routine notice while a decline still shows one.

This package reads no file and imports no host SDK — its own test suite pins every source import to a
relative module or `@maskpoint/core` — so the channels above are the ones it can reach. Reading
`.pi/settings.json` directly would break that rule and needs a trust decision (what may an untrusted
repository influence), which is why it is not done; the repository's `docs/design.md` records the
trade-off as R9.

## Not yet

`maskReasoning` has not been measured on the checkpoint path: when a compaction runs a checkpoint
call, that call reads the same text the budget measured, so stubbing reasoning also stubs what the
summarizer sees. Until a checkpoint written from stubbed reasoning is compared with one written from
full reasoning, the default stays off.

There is no per-checkpoint model configuration yet: a checkpoint always uses the session's active
model, even when `checkpointModel` is set — it is accepted and validated, but nothing in Pi's
documented extension surface lets this package look up a model by id. Branch summaries for `/tree`
are a separate Pi mechanism and are not covered.

## Tests

`npm test` from the repository root. `test/recorded/` holds payloads recorded from a real Pi
session; see its README for how they were taken and how to re-record them for a new Pi release.
