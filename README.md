# Maskpoint

Portable hybrid context compaction for coding agents: **deterministic observation masking first, one
LLM checkpoint as a last resort.**

When a host compacts, Maskpoint replaces stale tool output with short placeholders instead of asking
a model to summarize it. A model is called only when the accumulated masked history crosses a token
budget, or when you asked `/compact` for a focus.

```
read, 260 lines            →  [tool result omitted: read, ok, 260 lines, 31304 chars]
```

Nothing about the result depends on a model's willingness to preserve a file path: masking is
deterministic, and the placeholder is a smaller, honest summary of what was there.

## Tiers, per host — stated, not implied

The integration differs by host, and every adapter says which one it is rather than implying
equivalence:

| Host | Tier | What that means |
| --- | --- | --- |
| **Pi** | native replacement | Pi lets an extension return its own compaction result, so Maskpoint replaces Pi's summarize step for manual, threshold, and overflow compactions |
| **DSH** | native replacement | the backend lands a model-free replacement behind the host's compaction seam, with shadow pricing so the host's token accounting stays exact |
| **Claude Code** | assisted augmentation | a hook cannot supply replacement history, so Claude Code still writes its own summary; Maskpoint masks, steers, and re-injects an artifact beside it |
| **Codex CLI** | assisted augmentation | as above, plus a preservation directive pushed into Codex's own compaction prompt where its configuration allows |

## Install

Runtime dependencies are production dependencies; Pi installs packages with development dependencies
omitted, so nothing here needs a build step at install time.

**Pi** — native replacement:

```sh
pi install npm:@maskpoint/pi
# or from a checkout:
npm ci && npm run build && pi install ./packages/pi
# or for one run only:
npm ci && npm run build && pi -e ./packages/pi
```

**DSH** — native replacement. The backend replaces the built-in one (a context allows one), so it
ships as a bundle patch that disables the `compaction-basic` row and inserts ours:

```sh
dsh plugin add @maskpoint/dsh
```

Agents running in a shipped `standard`/`code`/`cordis` preset need a preset copy with the row's
`name` changed to `@maskpoint/dsh`; see [`packages/dsh/README.md`](packages/dsh/README.md).

**Claude Code** and **Codex CLI** — assisted augmentation. Both hosts install plugins from a plugin
*marketplace*, and this repository does not yet ship a marketplace manifest for either, so the
install path is the one each package documents:
[`packages/claude-code/README.md`](packages/claude-code/README.md),
[`packages/codex/README.md`](packages/codex/README.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/spec.md`](docs/spec.md) | Problem, user stories, implementation decisions, testing decisions, out of scope |
| [`docs/design.md`](docs/design.md) | Interfaces, algorithms, per-adapter designs, failure matrix, quality bars, open issues |
| [`docs/calibration-report.md`](docs/calibration-report.md) | The internal token estimator against DSH's own meter, over the shared corpus |

The research basis is *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM
Summarization for Agent Context Management* (arXiv:2508.21433); this project's own numbers, not the
paper's, are what its quality bars are measured against.

## Development

```sh
npm ci
npm run typecheck
npm test                       # engine, adapters, conformance fixtures
npm run check:corpus           # sanitization + fixture integrity
npm run replay text-observations
```

Releases: `npm run release` typechecks, tests, then publishes `@maskpoint/core` first and the
adapters after it. Each adapter's `prepack` builds what it ships (`@maskpoint/pi` ships TypeScript
source that Pi loads itself, so it has no build step).

## License

MIT — see [LICENSE](LICENSE).
