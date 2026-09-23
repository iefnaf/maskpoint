# Compact budget calibration

Measured on 2026-09-23 against 1,764 usable real Pi sessions (the same corpus as the reasoning
evaluation, minus sessions under 8 messages) and the **42 real compaction events** recorded in
them. It answers one question: **what should the compact budget be, so the mask-only path is
actually used — and how should it scale with the model's context window?**

Work anchor: issue #46. The budget knob it renames (`checkpointTriggerTokens` →
`compactBudgetTokens`) is specified there; this document supplies the measured numbers.

## 1. What the corpus says about real compaction

### Host behavior, measured from the 42 events

- **Trigger size** (`tokensBefore`): median **185k** tokens (p25 143k, p75 232k).
- **Retained window**: median **25k** tokens (p25 22k, p75 29k).
- The trigger is **not window-relative**. Bucketed by the event's model window (windows resolved
  from the local Pi catalog, `models-store.json`):

  | window class | events | `tokensBefore` p25/p50/p75 | p50 as % of window |
  |---|---:|---|---:|
  | ≤ 300k | 32 | 143k / 178k / 218k | **139 %** |
  | ≥ 800k | 11 | 160k / 259k / 395k | 26 % |

  On 200k-class models the host compacts only after context already exceeds the window; on
  1M-class models it compacts at a quarter of it. Either way the trigger sits in the same absolute
  band (~180k), so the evicted span — and with it the masked candidate — is **bounded by host
  behavior, not by the window**.

### Candidate size at real events (the ground truth)

The candidate the engine would compare against the budget at each real event: previous artifact +
masked evicted span, in the engine's own units (labels and framing included, the same estimator
the budget uses):

| p10 | p25 | p50 | p75 | p90 | max |
|---:|---:|---:|---:|---:|---:|
| 16.5k | 29k | **41.5k** | 72k | 129k | 309k |

## 2. Coverage: which budget buys which mask-only rate

Coverage = share of the 42 real events whose candidate fits the budget (no model call). Flat
budgets:

| budget | 12k (current) | 24k | 32k | 48k | 64k | 96k | 128k |
|---|---:|---:|---:|---:|---:|---:|---:|
| coverage | **7 %** | 17 % | 31 % | 60 % | 74 % | 83 % | 88 % |

Window-relative `clamp(f × window, min, max)` on the events' true windows (1000k × 10,
272k × 14, 200k × 18):

| policy | coverage |
|---|---:|
| 16 % [24k, 96k] | 40 % |
| 20 % [24k, 96k] | 48 % |
| **25 % [24k, 96k]** | **62 %** |
| 30 % [24k, 96k] | 79 % |
| 35 % [24k, 128k] | 86 % |

Small fractions (1–4 % of the window) cover almost nothing: candidates at real events are already
20–40 % of the window on 200k-class models, because the host trigger is absolute.

## 3. Recommendation

`budget = clamp(0.25 × contextWindow, 24k, 96k)`, with a **24k flat fallback** when the window is
unknown.

- 200k window → 50k, 272k → 68k, 1M → 96k (the ceiling binds): coverage 62 % overall, versus 7 %
  for today's flat 12k — **a ninefold reduction in checkpoint calls on real events**.
- The ceiling forces distillation of pathological sessions (the 309k candidate — a marathon
  debugging session — must not ride around as holed history).
- The floor keeps small-window models from a budget that mask-only could never reach anyway.
- Burden stays bounded: at most 25 % of the window on mid-size models, ≤ 10 % on 1M windows.

What this does *not* claim: downstream quality at larger artifacts is unmeasured (the A/B harness
compared reasoning masking, not artifact size); and the corpus is one machine's usage — 42 events,
three window classes. The knobs exist precisely so this can be retuned without a release.

## 4. Interaction with reasoning masking

The reasoning evaluation measured reasoning at 36.8 % of the residual over **all** sessions — but
that average is diluted by small sessions. At the 42 real compaction events, which are by
selection long sessions on thinking models, reasoning is the **dominant residual bucket: a median
68 %** of the candidate (largest event: thinking 102.8k of a 152k residual). Re-measuring the same
events with reasoning masked under the engine's rules:

| window class | LLM trigger, reasoning kept | LLM trigger, reasoning masked |
|---|---:|---:|
| 1M (glm-5.3 class) | 60 % | **0 %** |
| 272k | 29 % | **0 %** |
| 200k/128k | 33 % | **0 %** |
| all 42 events | 38 % | **0 %** |

Every real event's candidate fits even the 24k floor budget once reasoning is masked (median
candidate ≈ 13k, p75 ≈ 17k). This materially strengthens the case for `maskReasoning` — and
weakens the original reason it ships off (checkpoint quality from stubbed reasoning is untested,
but with a 0 % trigger rate that path is simply not taken). The downstream-continuation risk was
measured as nil in the A/B. Flipping the default is issue-tracked, not done here.

## 5. Correction to an earlier number

`docs/reasoning-masking-evaluation.md` reported "the default budget of 12,000 makes 50.4 % of
first compactions mask-only". That number came from a one-shot simulation that forces **every**
session — including small ones the host would never compact — through a single compaction. Real
events tell a different story: at the point compaction actually fires, the candidate median is
41.5k and only **7 %** fit 12k. The mask-only path at the current default is nearly unused in
practice; that is the gap this calibration closes.

## How it was measured

Three passes over `~/.pi/agent/sessions` (pass scripts under `/tmp/budget-calib/` on the
measurement machine; the numbers, not the scripts, are the artifact):

1. **Extract** (`extract.mts`): per session, per-message tokens in the engine's units both
   verbatim and observations-masked (placeholders under the no-expansion and idempotence rules,
   images priced at 1200), the session's model, and every real compaction event's `tokensBefore`
   and retained-window size.
2. **Loop simulation** (`sweep.mts`): replays sessions through a compaction loop parameterized by
   the measured host trigger/retention defaults. Used to sanity-check shapes, discarded as the
   basis for the recommendation — 159 simulated events over-weight hypothetical compactions of
   sessions that never really compacted.
3. **Ground truth** (`real-events.mts`): the 42 real events; candidate = previous event's summary
   tokens + framing + masked span before the recorded boundary. Windows from the local Pi catalog.
   The reasoning-masked variant re-measures each event with thinking blocks replaced under the
   engine's placeholder and no-expansion rules.
