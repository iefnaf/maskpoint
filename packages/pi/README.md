# @maskpoint/pi

Maskpoint for [Pi](https://github.com/earendil-works/pi): when Pi compacts, stale tool output is
replaced by short placeholders and no model is called.

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
  since, so a full observation never re-enters the summary.
- Context strictly shrinks: if the result would not be smaller than what it replaces, Maskpoint
  steps aside.

## What is recorded

The compaction entry's `details` holds the engine's state, never any observation content:

```json
{
  "v": 1, "engine": "maskpoint", "strategy": "mask", "checkpoints": 0,
  "stats": { "observationsMasked": 3, "charsOmitted": 3578, "candidateTokens": 367 },
  "cursor": { "boundaryId": "50aaf998#0", "evictedThroughId": "2d72180b#0" }
}
```

`fromHook` is `true` and `usage` is empty, because no model was used. To look at one:

```sh
jq -c 'select(.type=="compaction") | {fromHook, usage, details}' ~/.pi/agent/sessions/<project>/<session>.jsonl
```

In an interactive session Maskpoint also says what it did (`Maskpoint masked 3 observations (3578
chars omitted), ~367 tokens kept, no model call.`).

## When it steps aside

Returning nothing is Pi's documented fallback: Pi's own compactor runs, exactly as if this extension
were not installed. A session is never left without a compaction. Maskpoint steps aside, and says why,
when:

| Reason | Meaning |
|---|---|
| `unreadable-snapshot` | The history has a shape it does not recognize or cannot reconcile with what Pi prepared (an unknown message role or content block, a cut point that is not on the branch, a different message count than Pi's). |
| `inconsistent-cursor` | The previous compaction has no summary to build on, or where it left off cannot be trusted. |
| `no-size-reduction` | The result would not be smaller than what it replaces. |
| `checkpoint-unavailable` | You gave `/compact` instructions. Focusing a summary needs a model, and this version makes no model call, so Pi's compactor applies them. |
| `engine-failure` | An unexpected fault. It is contained; Pi compacts. |

## Not yet

The next Pi work is budgeted checkpoints, `/compact <focus>` handled by Maskpoint (Pi's compactor
applies it today), and carrying Pi's read and modified file lists across compactions. Until then
those paths still appear in the masked history as tool-call arguments, but Pi's own file tracking
does not see them once Maskpoint has compacted. Branch summaries for `/tree` are a separate Pi
mechanism and are not covered.

## Tests

`npm test` from the repository root. `test/recorded/` holds payloads recorded from a real Pi
session; see its README for how they were taken and how to re-record them for a new Pi release.
