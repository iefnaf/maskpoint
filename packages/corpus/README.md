# @maskpoint/corpus

The shared, sanitized conversation corpus, plus the tooling around it. Private: test and
development only. It drives Seam 1 (the engine over neutral snapshots) directly, Seam 2 (adapter
conformance) through per-host recordings, and cross-platform parity by synthetically encoding
every fixture for both native-replacement adapters — see `docs/design.md`, "Testing design".

## Layout

- `fixtures/*.json` — one `ConversationSnapshot` per file, in the vocabulary of `@maskpoint/core`.
- `fixtures/manifest.json` — enumerates every fixture. The manifest and the directory must agree
  exactly; an unlisted or missing file fails the tests.
- `src/sanitize.ts` — flags anything resembling a credential or a contributor's real paths.
- `src/coverage.ts` — derives which content shapes a fixture exercises from its items (never from
  labels); the tests require the corpus to cover the shapes the design lists.
- `src/replay.ts` — prints masked history and statistics for a fixture.
- `src/calibration.ts` — compares the internal estimator against DSH's own token meter (issue #16).
- `src/quality-bars.ts` — reports the design's quality bars (zero-LLM ratio, usable-result rate,
  context-decrease, checkpoint safety) over the corpus (issue #16).

## Commands

```sh
npm run replay -- <fixture>     # masked history + statistics for one fixture
npm run check:corpus            # validate the manifest and fixtures, and sanitize them
npx tsx packages/corpus/src/cli.ts list
npx tsx packages/corpus/src/cli.ts check <path>   # sanitize arbitrary files or directories
npx tsx packages/corpus/src/cli.ts calibration    # estimator vs. DSH's own token meter, per fixture
npx tsx packages/corpus/src/cli.ts quality-bars   # zero-LLM ratio, usable-result rate, context-decrease, checkpoint safety
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

`test/parity.test.ts` is the cross-platform parity harness (issue #12): every fixture, synthetically
encoded as the artifact each adapter's own boundary and cursor accounting expects
(`test/support/pi-encoding.ts`, `src/dsh-encoding.ts`), driven through the Pi and DSH
adapters' real exported entry points, and compared on outcome, statistics, and rendered
masked-history text. A fixture is compared by default; excluding one needs a named reason in the
test's `EXCLUDED` map (checked by a test of its own) plus a dedicated pair of tests pinning the
current, documented divergence — never a silent skip. See `docs/design.md`, "Testing design",
"As built (#12)".

`test/calibration.test.ts` and `test/quality-bars.test.ts` cover `src/calibration.ts` and
`src/quality-bars.ts` (issue #16). See [`docs/calibration-report.md`](../../docs/calibration-report.md)
for the numbers they produce over the current corpus and how to read them.

## Adding a fixture

1. Add `fixtures/<name>.json` and list it in `fixtures/manifest.json`.
2. Use neutral content only: paths under `/workspace/...`, the home-directory user `user`, no
   credentials. `npm run check:corpus` must pass; a fixture that trips it is rejected, not exempted.
3. Item ids are unique within a snapshot, and `boundary.id` names the first item the host retains.
   Do not put the cut between a tool call and its result.
