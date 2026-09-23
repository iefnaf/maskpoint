# Calibration and quality-bar report

**Status:** done · **Work anchor:** issue #16 · **Canonical detail:** [`docs/design.md`](design.md), "Quality bars and measurement" and Open issues #5 · **Evidence code:** `packages/corpus/src/calibration.ts`, `packages/corpus/src/quality-bars.ts`, rerunnable via `npx tsx packages/corpus/src/cli.ts calibration` and `... quality-bars`

## Scope and an honest limit up front

No live session data exists anywhere in this repository or on the machine building it: no `~/.maskpoint/*` logs, no exported telemetry, no recorded Pi/Claude Code/Codex sessions. Every number below is measured over the shared, hand-authored fixture corpus (`packages/corpus/fixtures`, 9 fixtures), the same corpus the parity harness (#12) already treats as the project's one source of cross-adapter truth. That makes these numbers real, reproducible, and driven through the real engine and (for the meter comparison) a real host library — not synthetic assumptions — but they are corpus-scale, not production-volume. Where a design target (the ≥70% zero-LLM bar, the ≥50%-warning line) is meant to describe live usage, that is called out explicitly below rather than implied.

This mirrors how issue #14 (Claude Code drift audit) closed the same kind of acceptance criterion: it built the aggregation and reporting mechanism and ran it against what was available, rather than claiming production telemetry that does not exist.

## 1. Estimator versus host-meter comparison

### Method

DSH ships a real, importable token meter (`@deepseek-ai/dsh-token-meter`), independent of Maskpoint, used to gate the host's own compaction. Its `estimateMessage(message)` is a pure function — no session or cordis context touches it (confirmed against the compiled source: the instance method is a bare delegate to a module-scope function) — so it is called directly against the same message shapes `packages/corpus/src/dsh-encoding.ts` already builds for the parity harness. That gives a real, offline, CI-runnable comparison against an actual host, not a stand-in.

The comparison prices the **same raw region on both sides**: the items a compaction would evict, before masking. The first attempt at this compared the internal estimator's *post-mask* candidate size (placeholders already substituted) against DSH's *pre-mask* reading of the raw region — which mostly measures how aggressively masking shrinks content, a question the existing `charsOmitted`/`observationsMasked` stats already answer, not whether `estimateTokens`'s per-character weighting is accurate. Comparing both sides on the identical raw region is closer to the actual question this issue asks, but it is not a pure per-character comparison either: `candidateTokens` (the internal side, via `candidateText`) prepends `HISTORY_FRAMING` (a fixed 58-token block) and a short `roleLabel` per item, while `buildDshMessages`/DSH's meter adds its own, different fixed cost per message (4 tokens of role overhead + 4 tokens of block overhead each, `estimate.ts`'s `ROLE_OVERHEAD`/`BLOCK_OVERHEAD`). Both are real costs each system actually carries in production, so the headline numbers below are honest "what each system would really compute" figures — but they are **not** isolated per-character-weighting numbers, and the Verification subsection below checks how much of the gap survives once both sides' framing/overhead is stripped out.

### Results

| Fixture | Estimator (raw region) | DSH host meter | Divergence | Features |
|---|---:|---:|---:|---|
| text-observations | 898 | 765 | −17.4% | code-heavy |
| shell-execution | 847 | 708 | −19.6% | shell-execution, split-turn |
| image-observations | 352 | 327 | −7.6% | image-observation |
| parallel-tool-calls | 390 | 330 | −18.2% | parallel-tool-calls |
| split-turn | 992 | 822 | −20.7% | split-turn |
| host-context | 918 | 772 | −18.9% | host-context, previous-checkpoint, code-heavy |
| **cjk** | 607 | 302 | **−101.0%** | cjk |
| **code-heavy** | 3874 | 3217 | −20.4% | code-heavy |
| pre-masked | 356 | 315 | −13.0% | pre-masked |

Divergence is `(hostMeter − estimator) / hostMeter`; negative means the internal estimator reads *higher* (more conservative) than DSH's own meter. Rerun with `npx tsx packages/corpus/src/cli.ts calibration`.

### Interpretation

Two distinct patterns, not one:

- **Every non-CJK fixture: the internal estimator reads 8–21% higher than DSH's meter**, consistently. This is the estimator's documented design intent (`estimate.ts`: "deliberately conservative — it overestimates rather than under") holding up against an independent, real second opinion, not a random spread — the margin is stable across very different content shapes (shell output, split turns, host-injected context, dense code).
- **The `cjk` fixture: the internal estimator reads roughly double DSH's own meter.** This is expected and, on the evidence, correct to keep: DSH's own package documentation says plainly that its fixed 4-characters-per-token heuristic "underprice[s] badly" on CJK text. Maskpoint's estimator prices CJK at 6 quarter-tokens per character (1.5 tokens/char) against DSH's flat 4 chars/token (0.25 tokens/char) — six times the per-character cost, which is what produces the ~101% divergence. That direction is the safe one: a real BPE tokenizer typically prices CJK far worse than 4 chars/token, so pricing it *higher* than a heuristic that is known to underprice it is corrective, not an error to fix.

No fixture shows the internal estimator reading *lower* than DSH's meter, which is the direction that would actually be dangerous (an under-conservative estimate risking a missed no-size-reduction guard or a checkpoint budget decision made on too small a number).

### Verification: does the gap survive stripping framing?

Redone with `HISTORY_FRAMING`/`roleLabel` removed from the internal side (summing `estimateTokens(payloadOf(item))` per item directly) and DSH's own per-message/per-block overhead removed from the host side (character-count-only pricing) — the smallest, most framing-sensitive fixture first:

| Fixture | Estimator, no framing | DSH meter, char-only | Divergence |
|---|---:|---:|---:|
| parallel-tool-calls | 264 | 238 | −10.9% |
| image-observations | 200 | 203 | +1.5% |
| pre-masked | 214 | 199 | −7.5% |
| host-context | 802 | 692 | −15.9% |
| text-observations | 737 | 629 | −17.2% |
| shell-execution | 706 | 600 | −17.7% |
| split-turn | 852 | 718 | −18.7% |
| code-heavy | 3733 | 3105 | −20.2% |
| **cjk** | 475 | 202 | **−135.1%** |

Framing accounted for a real slice of the headline numbers — `parallel-tool-calls` drops from −18.2% to −10.9%, and `image-observations` flips from −7.6% to +1.5% (i.e. DSH's char-only reading is marginally *higher* there once neither side's overhead is counted, on a fixture whose evicted text is otherwise almost empty) — but it does not explain the pattern away. On 7 of 9 fixtures the internal estimator still reads meaningfully higher (roughly 11–20%) than DSH's own character-level pricing, and the CJK gap *widens* to −135% once DSH's already-small per-message overhead is no longer partially offsetting it. The two headline conclusions in the Interpretation above — stable, moderate conservatism on non-CJK content; large, corrective conservatism on CJK — hold under this stricter, overhead-free test. `image-observations` is the one fixture where removing overhead erases the gap; see §3 (Context-decrease) for why that fixture's numbers are unusual for an unrelated, already-documented reason (the estimator does not price images at all).

### Constants: not adjusted

**Acceptance criteria "constants adjusted where the comparison shows material divergence" and "defaults updated if the evidence says the initial values were wrong": evaluated, no change made.** The comparison shows real, stable divergence, but in the safe (conservative) direction on every fixture, and the one fixture that isolates CJK weighting specifically shows the existing weight already correcting for a bias DSH's own docs admit to, in roughly the right ballpark for real tokenizers. Changing `QUARTERS_CJK` or the other weights in `packages/core/src/estimate.ts` downward on this evidence would remove a margin the comparison shows is doing its job; changing them upward has no supporting evidence at all. `checkpointTriggerTokens` (the 12,000-token budget default) is a separate tuning parameter this comparison does not speak to: every corpus fixture is far below it regardless of which estimator prices it, so no fixture here exercises the threshold itself. Recorded here rather than silently closed, matching the parity harness's own "never a silent skip" convention.

## 2. Zero-LLM compaction ratio and usable-result rate

Run via `npx tsx packages/corpus/src/cli.ts quality-bars`, driving every corpus fixture through the real engine (`@maskpoint/core`'s `run`) at the then-default budget of 12,000 tokens (since renamed `compactBudgetTokens` and recalibrated — `docs/budget-calibration.md`):

- **8 of 9 fixtures mask with zero model calls; 1 requests a checkpoint** (the `cjk` fixture, which carries `customInstructions` — the same reason the parity harness excludes it from the cross-adapter comparison, docs/design.md "Testing design"). **Zero-LLM ratio: 88.9%.**
- **0 of 9 fixtures decline.** **Usable-result rate: 100%** (every fixture produces masked history or a checkpoint; no decline reasons fired).

The design's ≥70% zero-LLM target and 100% usable-result target are both met on this corpus. This is evidence the decision logic behaves as designed on a variety of shapes, not evidence about production compaction volume — the corpus has no fixture that is naturally over budget by size alone (every fixture is a short, hand-authored conversation), so this 88.9% says more about how the corpus is composed than about what a real long-running session would show. Measuring the real ratio needs the live telemetry that #14 built the mechanism for on Claude Code (`audit.jsonl` / `audit-summary`) and that Pi/DSH do not yet have an equivalent of (Pi's compaction-entry `EngineDetail.stats` accumulate per-session but nothing currently aggregates across sessions; DSH's own adapter logs statistics but persists none, docs/design.md, DSH adapter section).

## 3. Context-decrease

Compares each fixture's raw pre-mask region (the same reading used in the calibration comparison above) against its post-compaction `candidateTokens`, over the whole corpus at the default budget.

**1 named exception, explained; 0 unexplained.** `image-observations` is the one fixture where the post-mask reading is nominally larger than the pre-mask one, entirely because `packages/core/src/mask.ts` prices only text — its own comment: "the estimator only sees text, and images are the worst context-per-information item in a session" — so an image is dropped unconditionally "whatever its text costs." A tool result that is nothing but an image (no accompanying text) therefore goes from 0 estimated tokens before masking (the estimator never counted the image at all) to the handful of tokens in its placeholder's descriptive text (`[tool result omitted: ok, 1 image]`) after. The image itself — the actual context cost — is still gone; only the text-only estimator's accounting of an unpriced thing going to a small priced placeholder looks like growth. This is `mask.ts`'s existing, deliberate design (images are dropped regardless of what the estimator says), not new evidence from this report, and pricing images is a larger, separate question already partially addressed at the adapter level (Pi's own `IMAGE_TOKENS = 1200` constant, `packages/pi/src/compact.ts`) rather than in the shared estimator.

Every other fixture strictly decreases, with no exceptions.

## 4. Checkpoint safety

Forces the checkpoint path (a 1-token trigger budget) on every corpus fixture, crossed with each of the six ways a model call can end (`packages/corpus/src/model-double.ts`'s `responses`):

| | count |
|---|---:|
| Attempts (9 fixtures × 6 response shapes) | 54 |
| Accepted (`success`) | 9 |
| Rejected — `provider-error` | 9 |
| Rejected — `aborted` | 9 |
| Rejected — `truncated` (length-stopped) | 9 |
| Rejected — `tool-call` | 9 |
| Rejected — `empty` | 9 |
| **Truncated or empty checkpoints persisted** | **0** |

Every rejection shape, for every fixture, falls back to non-empty masked history with a named `checkpointRejection`; nothing truncated or empty is ever returned as a checkpoint. The design's bar ("Zero persisted truncated or empty checkpoints") holds across every fixture × rejection-shape combination this corpus can construct.

## 5. Parity drift

The existing cross-platform parity harness (#12, `packages/corpus/test/parity.test.ts`) is the project's drift signal between the two native-replacement adapters. As of this report: **7 of 9 fixtures compare with zero unexplained divergence; 2 are named exclusions**, each pinned by its own dedicated test rather than silently skipped — `cjk` (Pi attempts a checkpoint call from `customInstructions` and declines no-size-reduction on the fallback; DSH's checkpoint path does not yet read `customInstructions` at all and masks normally — a genuine different-paths divergence, not a rendering difference) and `parallel-tool-calls` (Pi's and DSH's respective no-size-reduction guards, measured by two different estimators, disagree close to their break-even points for this fixture's small observations; docs/design.md, "Testing design", "As built (#12)"). No new divergence; both exclusions predate this issue and are unchanged by it.

## Summary against the acceptance criteria

| Criterion | Result |
|---|---|
| Estimator vs. host-meter comparison, incl. CJK and code-heavy | Done — real comparison against DSH's own meter, §1 |
| Constants adjusted where divergence is material | Evaluated — no adjustment warranted, reasoning recorded, §1 |
| Zero-LLM ratio reported | 88.9% over the corpus (not live usage — none exists), §2 |
| Usable-result rate + decline reasons | 100%, 0 declines, §2 |
| Context-decrease and checkpoint-safety counters | 1 named non-regression exception; 0/54 unsafe checkpoints, §3–4 |
| Parity drift reported | 7/9 clean, 2 pre-existing named exclusions, unchanged, §5 |
| Defaults updated if evidence says they were wrong | No — evidence supports the existing values, §1 |
