# Masking assistant reasoning: corpus and A/B evaluation

Measured on 2026-09-22 against 1,997 real Pi sessions (994 MB, 167,762 messages, 323.5 M
conversation characters) and a model-in-the-loop A/B run on glm-5.3. It answers one question:
**what does Maskpoint leave behind, and what would masking assistant reasoning cost?**

Every number below is reproducible with the method in "How it was measured".

## 1. What a session is made of

Share of the conversation text, by estimated tokens where noted (the estimator in
`packages/core/src/estimate.ts`, the same one the budget uses).

| Part | Weighted share (chars) | Median share in one session | Small sessions (5k–100k) | Large (400k+) |
|---|---|---|---|---|
| `tool-result` | **63.3 %** | **71.4 %** | 70.3 % | 58.6 % |
| `assistant-reasoning` | 14.9 % | 4.4 % | 8.7 % | **17.0 %** |
| `tool-call-args` | 14.6 % | 7.8 % | 8.4 % | **18.2 %** |
| `assistant-text` | 3.6 % | 3.5 % | 5.4 % | 2.9 % |
| `user` | 1.9 % | 0.8 % | 5.3 % | 0.9 % |
| summaries, unknown blocks | 1.7 % | 0.7 % | — | — |

Reasoning-heavy and reasoning-light sessions differ by more than an order of magnitude, so a single
session is not a sample: on the session this work started from, reasoning was 37.6 % and tool
results 37.6 %.

## 2. What a compaction actually returns

Simulated on 985 sessions as one first-time compaction each, at Pi's default cut
(`keepRecentTokens = 20,000`), measuring the engine's own unit: estimated tokens including the
history framing and one role label per item.

| Part | Evicted span (input) | Candidate (what is returned) |
|---|---|---|
| `tool-result` | 62.6 % | 3.5 % (placeholders) |
| `tool-call-args` | 16.6 % | **42.7 %** |
| `assistant-reasoning` | 14.3 % | **36.8 %** |
| `assistant-text` | 5.0 % | 12.9 % |
| `user` | 1.5 % | 3.9 % |

Masking removes 62.6 % of the input and leaves **79.5 % of what survives** in the two buckets it
deliberately does not touch: tool-call arguments and assistant reasoning.

Other measurements from the same run:

- Compression: **2.6x** on tokens (2.7x on characters, 3.9x median per session).
- Candidate size: median **11k tokens** (p25 2k, p75 40k, p90 81k); the evicted span's median is
  50k tokens. The default budget of 12,000 therefore makes **50.4 %** of *simulated first*
  compactions mask-only, 65.0 % at 26,214 and 83.1 % at 60,000 — the last two are 10 % and 23 % of
  glm-5.3's 262,144-token window. **Correction (2026-09-23):** that rate is a one-shot simulation
  that forces every session through one compaction; at the 42 *real* compaction events the
  candidate median is 41.5k and only **7 %** fit 12k — see [`budget-calibration.md`](budget-calibration.md).
- Of 54,356 tool results in evicted spans, 88.9 % were masked and 11.1 % were left verbatim by the
  no-expansion rule.
- Tool results by tool: `read` 51.5 %, `bash` 29.5 %, `fabric_exec` 6.2 %, `grep` 5.6 %.
- Tool-call arguments by tool: `write` 29.9 %, `bash` 23.5 %, `edit` 16.7 %, `fabric_exec` 13.5 %,
  `subagent` 7.6 % — that is, the bulk is file bodies and command text, not the "index of what
  happened".
- Masking reasoning would cut the candidate by a further **33 %** (2.5x → 3.6x) and lift the
  mask-only rate at the default budget from 46.5 % to 52.8 %.

## 3. Redundancy and uniqueness of reasoning

Offline, over reasoning blocks of at least 200 characters inside evicted spans (400 sessions,
5,590 blocks, 4.0 M tokens):

- **74.1 %** of blocks contain at least one lookup-worthy identifier (path, symbol, CLI flag,
  quoted literal) that appears **nowhere else** in what survives masking; the median block holds
  six such identifiers, **half of them unique to it**. Examples pulled from the corpus:
  `gvisor/system`, `data/appsettings.db`, `support/app.hiddify.com/data/…log`.
- A lexical test — 5-gram overlap between a reasoning block and its own turn's assistant text and
  tool-call arguments — reads **0 %** and is **not** evidence of redundancy: reasoning is prose and
  the outcome is code, JSON or another language, so the metric is structurally zero. It is reported
  here only to record that this measurement does not work.

So reasoning is not a restatement of the outcome. That is an upper bound on loss, not a
demonstration of harm: an identifier mentioned only in passing may never have mattered.

## 4. A/B: does masking reasoning change what a model can do?

Method. Forty cut points from real sessions, filtered to continuations that are *derivable* — the
next action's target already appears in the last user instruction or the retained region, so a
correct answer is possible without guessing. For each cut point the real artifact is built twice
with the shipped code (`maskItems` then `artifactCandidateText`): arm **A** as shipped, arm **B**
with each reasoning block replaced by `[reasoning omitted: N chars]`. The same prompt asks for the
next tool call, its arguments, the files already changed, and up to three state bullets. Grading is
lexical and deterministic against the real trajectory; paired wins are counted with an exact McNemar
or a bootstrap of the paired difference.

Calls go to the same endpoint, model and request shape Pi uses for this provider (`zai-coding-cn`,
`glm-5.3`, and the `thinking: { type: 'disabled' }` field its `thinkingFormat: "zai"` compat
implies). Omitting that field leaves the provider's default in place, which spends the whole output
budget on reasoning and returns an empty answer — the first version of this experiment did exactly
that, and its numbers are superseded (see "Corrections").

40 of 40 pairs completed (80 calls, 322k tokens, 4.5 minutes):

| Metric | A | B | Paired result |
|---|---|---|---|
| Next tool choice | 50.0 % | 47.5 % | 5 vs 4 discordant, p = 1.00 |
| Next target (path or command) | 47.5 % | 37.5 % | 4 vs 0 discordant, p = 0.13 |
| State recall (entities from the record) | 8.1 % | 8.6 % | A−B = −0.005, 95 % CI [−0.032, 0.017] |
| Changed-file recall (control) | 9.1 % | 7.8 % | A−B = +0.013, 95 % CI [0.000, 0.036] |
| Reasoning-only identifiers in the answer | 1.00 | 0.57 | A−B = +0.43, 95 % CI [−0.48, 1.28] |
| Prompt tokens per call | 4,425 mean (3,220 median) | 3,192 mean (2,397 median) | 1.39x |

Reading:

- **No task metric separates the arms.** Tool choice is 5 vs 4 discordant pairs, target choice 4 vs
  0 (p = 0.13), and state recall differs by half a percentage point with a confidence interval that
  spans zero. At this sample size, masking reasoning neither helps nor hurts the resume in a way this
  test can see.
- **Information is still lost, but the test cannot resolve it.** Identifiers that exist only in
  reasoning appear twice as often in arm A's answers (1.00 vs 0.57 per answer), in the same direction
  as the offline uniqueness measurement, yet the paired interval includes zero.
- **The control behaves.** Changed-file recall — readable from kept tool-call arguments in both arms
  — is the one metric with no plausible reason to differ, and it does not.
- **Cost is the one unambiguous difference**: keeping reasoning costs 39 % more prompt tokens on
  average here, and 2.5x in reasoning-heavy cut points (median artifact 7.7k vs 2.1k tokens in the
  run recorded in "Corrections").
- A third of the calls missed both the tool and the target in *both* arms, so much of a real resume is
  not recoverable from any artifact: the comparison is meaningful, the absolute scores are not.

### Corrections

An earlier version of this document reported a 17-pair run in which stubbing reasoning improved state
recall 13–1 (p = 0.002) and tripled the prompt. Two faults invalidate those numbers: the harness keyed
sessions by filename, so sessions from different projects collided and 24 of 40 "pairs" compared the
wrong artifacts, and the request omitted the provider's `thinking` field so the model's own reasoning
consumed the output budget and returned empty answers in most calls. The conclusion above is from the
re-run with both fixed. The directional hint — stubbing reasoning correlated with slightly higher
state recall — did **not** replicate under correct pairing.

### What this does not show

- n = 40 pairs is enough to rule out a large effect and nothing smaller; it cannot resolve a 5–10 %
  difference in continuation quality.
- One model (glm-5.3), one host (Pi), lexical grading.
- The probe is a bare model reading the artifact: no agent system prompt, no tools, and no retained
  region. Absolute scores understate a real resume; only the comparison is meaningful.
- **The checkpoint path is untested.** When the candidate exceeds the budget, the same text is fed
  to the summarizer (`artifactCandidateText`). Whether a checkpoint written from stubbed reasoning
  is worse than one written from full reasoning is the open question, and the reason the feature
  ships off by default.

## How it was measured

Two throwaway scripts over `~/.pi/agent/sessions`, both importing the repository's own
`estimateTokens`, `maskItems` and `artifactCandidateText` so the numbers use the engine's units
rather than a second estimator:

1. **Composition and one-compaction simulation.** Walk every `*.jsonl` session, bucket each
   message block by the item vocabulary, then replay Pi's cut (walk back from the newest message
   until `keepRecentTokens` is retained) and mask the rest with the shipped rules. Reports
   before/after composition, compression, candidate distribution, and the mask-only rate at several
   budgets.
2. **A/B.** Same replay, then two calls per cut point to
   `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` with `glm-5.3`, temperature 0,
   one prompt per arm differing only in the artifact. Graded by string match against the recorded
   trajectory; paired wins counted with a two-sided sign test.

The scripts are not committed: they read private session files and are a few hundred lines of
throwaway analysis. The method above is specific enough to rebuild them.
