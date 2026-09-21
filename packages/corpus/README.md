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

`replay` uses a pass-through engine and says so in its output; nothing is masked until the
masking engine lands and is wired in as a `ReplayEngine`.

## Adding a fixture

1. Add `fixtures/<name>.json` and list it in `fixtures/manifest.json`.
2. Use neutral content only: paths under `/workspace/...`, the home-directory user `user`, no
   credentials. `npm run check:corpus` must pass; a fixture that trips it is rejected, not exempted.
3. Item ids are unique within a snapshot, and `boundary.id` names the first item the host retains.
   Do not put the cut between a tool call and its result.
