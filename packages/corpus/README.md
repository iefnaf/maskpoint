# @maskpoint/corpus

The shared, sanitized conversation corpus, plus the tooling around it. Private: test and
development only. It drives Seam 1 (the engine over neutral snapshots) directly and, later,
Seam 2 (adapter conformance) through per-host recordings — see `docs/design.md`, "Testing design".

## Layout

- `fixtures/*.json` — one `ConversationSnapshot` per file, in the vocabulary of `@maskpoint/core`.
- `fixtures/manifest.json` — enumerates every fixture. The manifest and the directory must agree
  exactly; an unlisted or missing file fails the tests.
- `src/sanitize.ts` — flags anything resembling a credential or a contributor's real paths.
- `src/coverage.ts` — derives which content shapes a fixture exercises from its items (never from
  labels); the tests require the corpus to cover the shapes the design lists.
- `src/replay.ts` — prints masked history and statistics for a fixture.

## Commands

```sh
npm run replay -- <fixture>     # masked history + statistics for one fixture
npm run check:corpus            # validate the manifest and fixtures, and sanitize them
npx tsx packages/corpus/src/cli.ts list
npx tsx packages/corpus/src/cli.ts check <path>   # sanitize arbitrary files or directories
```

`replay` runs the real masking engine from `@maskpoint/core` (`maskingEngine`). A `ReplayEngine` that
does not mask, such as `passThroughEngine`, says so in its output so unmasked history is never
mistaken for masked history.

`test/masking.test.ts` is Seam 1 for masking: it applies `maskSpan` to every fixture and asserts
the invariants the design lists (order, only observation bodies removed, no-expansion,
idempotence, retained region untouched) plus shape-specific expectations.

`test/decision.test.ts` is Seam 1 for accumulation and the budget decision: it runs `decide` over
every fixture (the cursor, the appended span, the budget boundary, the persisted detail, a second
compaction fed the first one's artifact) and asserts that the estimator is conservative on the
`cjk` and `code-heavy` fixtures.

`src/model-double.ts` is the deterministic model double for the checkpoint call: it records every
request and answers with one scripted response (`responses.success`, `providerError`, `aborted`,
`lengthStop`, `toolCall`, `empty`) or throws. `test/checkpoint.test.ts` is Seam 1 for the checkpoint
path: `run` over every fixture and the double, asserting the number and contract of model calls,
acceptance, each rejection's fallback to masked history, cancellation, usage, and the next
compaction building on an accepted checkpoint. No network.

## Adding a fixture

1. Add `fixtures/<name>.json` and list it in `fixtures/manifest.json`.
2. Use neutral content only: paths under `/workspace/...`, the home-directory user `user`, no
   credentials. `npm run check:corpus` must pass; a fixture that trips it is rejected, not exempted.
3. Item ids are unique within a snapshot, and `boundary.id` names the first item the host retains.
   Do not put the cut between a tool call and its result.
