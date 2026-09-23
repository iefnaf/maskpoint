<div align="center">

# Maskpoint

**Compress the noise. Keep the trail back.**

**English** · [简体中文](README.zh-CN.md)

Portable hybrid context compaction for coding agents: deterministic masking first, one
budgeted checkpoint only when needed, and verbatim recall where the host exposes a tool surface.

<img src="media/banner.svg" alt="Maskpoint replaces a large tool result with a small recallable placeholder while keeping the instruction and tool call intact" width="100%">

[![CI](https://img.shields.io/github/actions/workflow/status/iefnaf/maskpoint/ci.yml?branch=master&style=for-the-badge&label=checks)](https://github.com/iefnaf/maskpoint/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40maskpoint%2Fpi?style=for-the-badge&label=%40maskpoint%2Fpi)](https://www.npmjs.com/package/@maskpoint/pi)
[![Node](https://img.shields.io/badge/node-%3E%3D22-5fa04e?style=for-the-badge)](package.json)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

Coding-agent sessions are dominated by observations: file dumps, test logs, command output, diffs,
and images. Most compactors send that entire span to another model and ask it to rewrite the work as
prose. Maskpoint separates **the structure worth remembering** from **the payload that can be put
aside**:

1. **Mask first.** Old observation bodies become small, factual placeholders. User instructions,
   assistant text and tool calls stay intact; on native adapters, so does the host-retained recent
   window. This path is deterministic and makes zero model calls.
2. **Checkpoint only under pressure—or on explicit request.** Masked history accumulates until it
   crosses a token budget; an explicit compaction focus can request the same path sooner. Those are
   the only times Maskpoint may make one structured checkpoint call through the host's existing
   model stack.
3. **Leave a way back.** Every masked placeholder carries a stable `recall id`. In Pi today, the
   agent can use that id to fetch the original session entry verbatim when an exact error, path, or
   command matters again.

Maskpoint is not a vector database, a second memory system, or a new model provider. It is a compact,
host-aware layer over the session history the agent already has.

## What a compaction keeps

| History item | Masking path |
| --- | --- |
| User instructions and constraints | Kept verbatim |
| Assistant text | Kept verbatim |
| Assistant reasoning | Kept verbatim by default; optionally maskable |
| Tool name and arguments | Kept verbatim |
| Old tool-result body | Replaced by a smaller status-and-size placeholder |
| Images in old observations | Replaced by text metadata |
| Host-retained recent window (native adapters) | Left untouched |

A 31,304-character file read becomes something the model can understand at a glance:

```text
read({"path":"src/auth.ts"})
[tool result omitted: read, ok, 260 lines, 31304 chars (recall id:39f65e5a)]
```

The placeholder is deliberately honest: it records what happened, whether it succeeded, how much
was omitted, and where the original lives. Masking is idempotent, and native adapters only mask when
the placeholder is smaller than the body it replaces.

## Recall: the escape hatch

When later work depends on the exact omitted text, the agent can open the placeholder instead of
guessing:

```json
{ "id": "39f65e5a" }
```

The Pi adapter exposes this as the agent-facing `recall` tool. It reads the original entry from the
current session and returns it verbatim, with bounded output and a history-not-instructions preface.
A keyword query is also available for older placeholders whose id is unavailable.

Recovered content is **borrowed, not pinned**: it is ordinary context and may be masked again at the
next compaction. The source entry never moves, so the same anchor remains usable. Recall is wired for
Pi today; the lookup and rendering logic lives in the platform-free core so another adapter can add
the same capability when its host offers a safe tool surface.

The full design, threat model, budgets, and model-in-the-loop experiments are in
[`docs/recall-tool.md`](docs/recall-tool.md).

## Why the checkpoint still exists

Masking removes the largest low-density content, but instructions, decisions, actions, reasoning,
and placeholders still grow over a very long session. Maskpoint therefore treats an LLM summary as
a **pressure valve**, not the default compaction algorithm.

```text
candidate = previous compacted state + newly evicted masked history

candidate within budget  → return masked history       (0 model calls)
candidate over budget    → request one checkpoint      (1 model call)
explicit focus supplied  → request one checkpoint      (1 model call)
checkpoint rejected      → return the masked history   (work continues)
```

A checkpoint is accepted only when it is non-empty, complete, and tool-free. Provider errors,
cancellation, output truncation, empty responses, and tool calls all fall back to the already-built
masked history. In adapters that support it, checkpointing can be disabled entirely for a
predictable model-free compaction path.

## Host support

The integration tier is explicit because the four hosts do not expose equivalent compaction APIs.

| Host | Tier | What happens | Recall |
| --- | --- | --- | --- |
| **Pi** | **Native replacement** | Replaces Pi's summary for manual, threshold, and overflow compaction. Mask-only by default; one checkpoint over budget or for `/compact <focus>`. | **Available** |
| **DSH** | **Native replacement** | Automatic pressure handling masks in place with no model call. Manual and explicit-region compaction can use one budgeted checkpoint. | Core support; no host tool yet |
| **Claude Code** | **Assisted augmentation** | Claude Code still writes its own summary. Maskpoint builds a privacy-safe artifact, steers where possible, re-injects it, and audits fidelity. | No host tool yet |
| **Codex CLI** | **Assisted augmentation** | Codex still owns compaction. Maskpoint supplies preservation guidance, re-injects a masked artifact, and records whether the host result was readable, opaque, or undetermined. | No host tool yet |

**Native replacement** means Maskpoint's output becomes the compacted model-visible history.
**Assisted augmentation** means the host compactor remains authoritative; Maskpoint supplements it
and never claims otherwise.

## Quick start

### Pi

Mask-only compaction needs no additional API key. If a checkpoint is required, Maskpoint uses the
model already configured in Pi.

```sh
pi install npm:@maskpoint/pi
pi
```

Inside Pi:

```text
/maskpoint                  # inspect or change settings
/compact                    # compact using the normal budget policy
/maskpoint checkpoint off   # optional: deterministic masking only
```

Installing from a checkout:

```sh
npm ci
npm run build
pi install ./packages/pi
# or, for one run:
pi -e ./packages/pi
```

See [`packages/pi/README.md`](packages/pi/README.md) for configuration precedence, compaction
metadata, failure reasons, and recorded-host tests.

### DSH

```sh
dsh plugin add @maskpoint/dsh
```

DSH allows one compaction backend per context. Shipped agent presets therefore need a small preset
copy that replaces the `compaction-basic` row; the exact YAML and smoke procedure are in
[`packages/dsh/README.md`](packages/dsh/README.md).

### Claude Code and Codex CLI

These adapters are plugins in the assisted tier and need host-specific hook and trust setup:

- [Claude Code installation and hook lifecycle](packages/claude-code/README.md)
- [Codex CLI installation, prompt wiring, and provider-side compaction detection](packages/codex/README.md)

## Configuration model

The core policy is deliberately small. Which settings are user-configurable depends on the host and
its extension surface.

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Disable Maskpoint and leave the host's normal behavior in place |
| `compactBudgetTokens` | Adapter-derived; otherwise `24000` | Maximum accumulated masked history before a checkpoint is considered |
| `checkpointEnabled` | `true` | Permit the one checkpoint call where the adapter has a model seam |
| `checkpointModel` | Host/session model | Reserved model override; see the adapter note below |
| `maskReasoning` | `false` | Also replace old assistant reasoning with recallable placeholders |
| `notificationLevel` | `normal` | Control routine compaction reporting |

Pi exposes the active settings through `/maskpoint`, environment variables, and command-line flags.
DSH uses its existing backend row, and Claude Code uses its own `settings.json`. Codex currently runs
the engine defaults; its only host-side option is the compaction-prompt wiring in Codex's own config.
`checkpointModel` is parsed for forward compatibility, but Pi still uses the active session model,
DSH uses its existing summarization provider/model fields, and the assisted adapters make no
checkpoint call. Adapter READMEs document the exact surfaces and known limitations.

## Failure is boring by design

- **No expansion on native masking:** an observation stays verbatim if its placeholder would be
  larger, and a native compaction must strictly shrink what it replaces.
- **The host owns recency:** native adapters reuse the host's cut point and never invent a second
  recent window inside the compacted span.
- **Checkpoint failure is not session failure:** the deterministic masked candidate is already ready
  as the fallback.
- **A decline never corrupts the session:** Pi falls through to its own compactor; DSH leaves history
  unchanged and reports the host's compaction error.
- **No new network destination:** checkpoint calls use providers already configured in the host.
- **No second raw transcript:** assisted adapters mask every observation before writing derived state;
  raw observation bodies remain only in the host's session store.
- **Recall is read-only and bounded:** it cannot mutate the session or turn one old log into a new
  context bomb.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/design.md`](docs/design.md) | Architecture, algorithms, adapter contracts, failure matrix, and quality bars |
| [`docs/spec.md`](docs/spec.md) | Problem statement, user stories, implementation decisions, and non-goals |
| [`docs/budget-calibration.md`](docs/budget-calibration.md) | Evidence behind the checkpoint budget defaults |
| [`docs/calibration-report.md`](docs/calibration-report.md) | Internal estimator compared with DSH's token meter |
| [`docs/reasoning-masking-evaluation.md`](docs/reasoning-masking-evaluation.md) | Measured trade-off of masking assistant reasoning |
| [`docs/recall-tool.md`](docs/recall-tool.md) | Recall design, experiments, security model, and output bounds |

The research basis is
[*The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management*](https://arxiv.org/abs/2508.21433).
Maskpoint uses its own corpus, host fixtures, parity tests, and calibration reports for project-level
claims rather than borrowing the paper's parameters unchanged.

## Development

Node.js 22 or newer is required.

```sh
npm ci
npm run build
npm run typecheck
npm run check:corpus
npm test
```

| Path | Responsibility |
| --- | --- |
| [`packages/core`](packages/core) | Platform-free masking, accumulation, budgeting, checkpoint, configuration, and recall primitives |
| [`packages/pi`](packages/pi) | Pi native-replacement adapter and `recall` tool |
| [`packages/dsh`](packages/dsh) | DSH native compaction backend |
| [`packages/claude-code`](packages/claude-code) | Claude Code hooks, artifact injection, and fidelity audit |
| [`packages/codex`](packages/codex) | Codex hooks, preservation prompt, injection, and compaction-mode audit |
| [`packages/corpus`](packages/corpus) | Shared sanitized corpus and cross-adapter parity harness |

The test suite uses deterministic model doubles and recorded or synthetic host artifacts; it does
not require paid model calls. Releases run typechecking and the full suite, then publish core before
the adapters.

## License

[MIT](LICENSE)
