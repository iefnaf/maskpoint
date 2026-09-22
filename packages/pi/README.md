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

- Everything before Pi's cut point is rendered as **masked history**: user messages, assistant text
  and reasoning, and tool calls are kept word for word; each tool result becomes a placeholder such as
  `[tool result omitted: read, ok, 72 lines, 2201 chars]`. A result is only masked if the placeholder
  is smaller, images are always dropped, and a command you ran with `!` keeps the command and masks
  its output.
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
higher than the previous compaction's. `fromHook` is `true`; `usage` on the compaction entry itself
is not yet populated for a Maskpoint-run checkpoint. To look at one:

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

## Not yet

There is no per-checkpoint model configuration yet: a checkpoint always uses the session's active
model. Branch summaries for `/tree` are a separate Pi mechanism and are not covered.

## Tests

`npm test` from the repository root. `test/recorded/` holds payloads recorded from a real Pi
session; see its README for how they were taken and how to re-record them for a new Pi release.
