# Maskpoint — Portable Hybrid Context Compaction

**Status:** current · **Created:** 2026-09-21 · **Canonical:** this file · **Work anchor:** issue #1 · **Design:** [`docs/design.md`](design.md)

## Problem Statement

Every coding agent I use — Pi, Claude Code, Codex, DSH — eventually runs out of context and compacts. All four do roughly the same thing: when history must shrink, they send a large span of history to an LLM and replace it with prose. Software engineering sessions are dominated by verbose tool observations (file dumps, command output, test logs, diffs), so this spends a model call to remove material that is mostly mechanical noise.

The consequences I feel today:

- Compaction is slow, costs a model call, and can fail or truncate, at the exact moment the session is already stressed.
- Each platform compacts differently and opaquely; I cannot carry one strategy or one set of tunings between tools.
- On platforms where compaction is internal, I cannot see or change the algorithm at all.
- There is no shared way to measure whether a context strategy is actually helping.

The research literature (JetBrains Research, *The Complexity Trap*) shows that deterministic observation masking matches or beats LLM summarization on cost, and that a hybrid — masking as the normal mechanism with an occasional LLM checkpoint — beats both. That strategy should not be reimplemented, differently and unobservably, once per platform.

## Solution

Maskpoint is a portable hybrid context-compaction engine plus one adapter per host platform.

The engine implements a two-stage strategy over a platform-neutral conversation model:

1. **Observation masking** (deterministic, zero LLM calls). Replace stale tool observations with compact, informative placeholders. Preserve user content, assistant text and reasoning, tool calls with arguments, and the host's own retained recent window verbatim.
2. **Budgeted checkpoint** (LLM, last resort). Only when accumulated masked history exceeds a configured budget, or when the user explicitly requests summarization, condense that accumulated history into a structured state checkpoint.

The engine never chooses the compaction cut point and never writes to a platform by itself. Adapters normalize the host's conversation into the engine's model, supply the retained boundary, invoke the engine, render the result in the host's vocabulary, and apply it through whatever integration depth the host permits.

Two integration depths exist, and the product states which one is in use rather than implying equivalence:

- **Native replacement** — the host accepts an externally produced compaction result that becomes model-visible history. Pi and DSH both expose this.
- **Assisted augmentation** — the host owns compaction and cannot yield it. Maskpoint generates the same artifacts, steers the host's summarizer where a documented channel exists, and re-injects state after compaction. Claude Code and Codex CLI are in this tier today.

Because the engine is shared, the same masking rules, budget policy, checkpoint format, state reducers, and statistics apply everywhere. Because adapters declare a capability profile, nobody is misled about which platform genuinely replaced its compactor.

## User Stories

### Portability

1. As a coding-agent user who works in several tools, I want one context strategy available in Pi, Claude Code, Codex, and DSH, so that I do not relearn a different compaction behavior per tool.
2. As a coding-agent user, I want the same masking rules and checkpoint format in every tool, so that a session's context quality does not depend on which CLI I happened to open.
3. As a coding-agent user, I want one place to configure the context budget, so that I do not duplicate tuning across four config files.
4. As a coding-agent user, I want each adapter to tell me what it can actually do (replace, steer, or only re-inject), so that I know whether compaction was genuinely replaced or merely supplemented.
5. As a coding-agent user, I want to run Maskpoint in one tool only, so that adoption does not require touching the others.
6. As a coding-agent user, I want the engine to work with no network access of its own, so that installing it does not add a new outbound destination.

### Masking

7. As a Pi or DSH user, I want stale tool observations replaced by placeholders, so that historical noise stops consuming context.
8. As a coding-agent user, I want every user instruction inside the compacted span preserved verbatim, so that compaction cannot silently weaken my requirements.
9. As a coding-agent user, I want assistant reasoning and explanatory text preserved verbatim on the masking path, so that the rationale behind the work survives.
10. As a coding-agent user, I want tool names and arguments preserved, so that the agent remembers which actions it attempted.
11. As a coding-agent user, I want placeholders to name the tool, so that I can tell a masked file read from a masked test run.
12. As a coding-agent user, I want placeholders to record success or error status, so that a masked failure is not mistaken for success.
13. As a coding-agent user, I want placeholders to record the omitted size, so that the agent knows whether a small reply or a large log was removed.
14. As a coding-agent user, I want shell commands preserved when their output is masked, so that the action remains understandable.
15. As a coding-agent user, I want masking to be idempotent, so that re-running it over already-masked or already-pruned history does not degrade the result.
16. As a coding-agent user, I want masking never to enlarge an observation, so that context management cannot increase token usage.
17. As a coding-agent user, I want old image observations replaced by text metadata, so that historical images do not consume context indefinitely.
18. As a coding-agent user, I want split-turn compaction to keep the original request and its actions readable while masking its observations, so that a half-compacted turn still makes sense.
19. As a coding-agent user, I want the host's own retained recent window left untouched, so that the agent keeps immediate access to its latest work.
20. As a coding-agent user, I want no second recency window invented inside the compacted span, so that full observations do not accumulate across repeated compactions.

### Budgeted checkpoint

21. As a coding-agent user, I want most compactions to complete without any LLM call, so that compaction is fast and does not consume budget.
22. As a coding-agent user, I want accumulated masked history periodically compressed into a structured checkpoint, so that masking alone cannot grow without bound.
23. As a coding-agent user, I want a checkpoint to replace all masked history accumulated before it, so that the compacted summary returns to a bounded size.
24. As a coding-agent user, I want later compactions to build incrementally from the latest checkpoint, so that the same work is not summarized repeatedly.
25. As a coding-agent user, I want checkpoints to retain goals, constraints, completed work, pending work, decisions, code state, tests including exact errors, changes, dependencies, version-control state, exact paths, and next steps, so that work can continue after a long session.
26. As a coding-agent user, I want the budget threshold configurable, so that I can trade context headroom against checkpoint frequency.
27. As a coding-agent user, I want the checkpoint output size bounded, so that a checkpoint cannot itself become the context problem.
28. As a coding-agent user, I want a checkpoint cut off by an output limit to be rejected, so that a truncated checkpoint never becomes permanent session state.
29. As a coding-agent user, I want a failed, aborted, tool-calling, or empty checkpoint to fall back to masked history, so that a secondary model failure cannot block my primary task.
30. As a coding-agent user, I want the current session model used for checkpoints by default, so that the checkpoint understands the same task as the main agent.
31. As a coding-agent user, I want to point checkpoints at a different registered model, so that I can trade cost and latency against quality.
32. As a coding-agent user, I want checkpoint token usage reported to the host, so that session accounting stays honest.
33. As a coding-agent user, I want a checkpoint request to use a fresh routing identity and no prompt-cache retention, so that a one-off summarization call does not distort main-loop caching.
34. As a coding-agent user, I want checkpoint calls to carry the host's cancellation signal, so that pressing Escape cannot leave the session without a usable result.
35. As a coding-agent user, I want no checkpoint to expose normal agent tools, so that a summarization call cannot perform side effects.

### Pi adapter

36. As a Pi user, I want automatic, manual, and overflow recovery compaction all handled, so that behavior is consistent however compaction was triggered.
37. As a Pi user, I want Pi's prepared cut point reused unchanged, so that Pi's own retention policy remains authoritative.
38. As a Pi user, I want `/compact <instructions>` to force a checkpoint and apply my instructions, so that explicit focus requests are honored rather than stored as inert text.
39. As a Pi user, I want `/compact` without instructions to follow the normal budget policy, so that behavior is predictable.
40. As a Pi user, I want Maskpoint state stored in the compaction entry's details, so that resuming or reloading a session restores it without a sidecar file.
41. As a Pi user, I want missing, malformed, older-version, or foreign compaction details treated as absent, so that installing Maskpoint into an existing session is safe.
42. As a Pi user, I want cumulative read and modified file lists carried across Maskpoint compactions, so that file-operation context is not lost.
43. As a Pi user, I want a genuinely unsupported history shape to fall through to Pi's own compactor, so that Maskpoint can never leave the session without a compaction result.
44. As a Pi user, I want each compaction to report whether masking or checkpointing ran, so that I can see what happened.

### DSH adapter

45. As a DSH user, I want Maskpoint available as a compaction backend implementing the existing compaction seam, so that I can select it like any other backend preset.
46. As a DSH user, I want Maskpoint to honor the seam's automatic, manual, and explicit-region entry points, so that all existing trigger paths work.
47. As a DSH user, I want the masking path to land a model-free surface replacement with accurate shadow pricing, so that DSH's own token accounting stays correct.
48. As a DSH user, I want the checkpoint path to record the summarization call envelope and usage durably, so that "which model wrote this checkpoint" has an answer in the log.
49. As a DSH user, I want Maskpoint to coexist with the existing tool-result pruner, so that enabling it does not require removing another safety net.
50. As a DSH user, I want masking to be idempotent over already-pruned results, so that two deterministic reducers do not compound placeholders.
51. As a DSH user, I want Maskpoint to respect the seam's tool-call/result pairing rules, so that compaction cannot leave a dangling tool call.
52. As a DSH user, I want expected failures classified with the seam's existing error vocabulary, so that the command surface reports them correctly.

### Claude Code adapter

53. As a Claude Code user, I want Maskpoint to generate its artifact during pre-compaction, so that a complete pre-compaction history is available to it.
54. As a Claude Code user, I want the artifact re-injected after compaction through a documented channel, so that correctness does not depend on undocumented behavior.
55. As a Claude Code user, I want the host's summarizer steered toward state preservation where a channel exists, so that the host summary and the artifact do not fight each other.
56. As a Claude Code user, I want post-compaction audit of the host summary against the artifact, so that fidelity drift is visible.
57. As a Claude Code user, I want Maskpoint never to block compaction, so that a policy of mine cannot turn a recovery compaction into a failed request.
58. As a Claude Code user, I want to be told clearly that the host summary is still produced, so that I do not believe the built-in compactor was replaced.
59. As a Claude Code user, I want no raw observation copies written outside the transcript, so that Maskpoint does not create a second sensitive artifact.

### Codex adapter

60. As a Codex user, I want Maskpoint's anti-loss instructions applied through the documented summarization-prompt configuration where available, so that the host summary retains state Maskpoint cares about.
61. As a Codex user, I want the artifact re-injected after compaction through the documented post-compaction context channel, so that state survives.
62. As a Codex user, I want to be told that Codex cannot accept an externally produced replacement history today, so that the tier is not overstated.
63. As a Codex user, I want the adapter to detect whether provider-side native compaction is active for my authentication mode, so that the adapter reports what it is actually supplementing.
64. As a Codex user, I want hook trust to be an explicit step, so that installing Maskpoint cannot silently execute code.

### Capability honesty and degradation

65. As a user of any platform, I want every adapter to publish a capability profile, so that I can compare tiers without reading source.
66. As a user of any platform, I want an unsupported capability to degrade explicitly rather than silently, so that masked-in-place and augmented-look identical only when they are.
67. As a user of any platform, I want a missing or unauthenticated checkpoint model to degrade to masking rather than to skip compaction, so that history still shrinks.
68. As a user of any platform, I want a total engine failure to leave the host's default compaction intact, so that Maskpoint can never make things worse than not installing it.
69. As a user, I want a host upgrade that changes hook payloads to be detected by conformance fixtures rather than discovered in production, so that platform drift is caught early.
70. As a user, I want advisory warnings when a host channel Maskpoint relies on is missing, so that silent no-ops are visible.

### Configuration

71. As a user, I want a global Maskpoint configuration, so that defaults apply across projects.
72. As a user, I want per-project configuration to override global settings only in trusted projects, so that an untrusted repository cannot choose my model or alter my compaction behavior.
73. As a user, I want to disable Maskpoint per project and globally, so that I can fall back to the host's own behavior.
74. As a user, I want invalid configuration rejected with a clear warning and safe defaults, so that a typo cannot corrupt session context.
75. As a user, I want configuration mapped onto each host's native config location, so that I do not manage a fifth config system.

### Safety and privacy

76. As a security-conscious user, I want Maskpoint to introduce no new network destination, so that checkpoint data only travels through providers already configured in the host.
77. As a security-conscious user, I want derived state to contain no raw observation bodies, so that no second copy of tool output exists on disk.
78. As a security-conscious user, I want checkpoint prompts to carry no credentials or environment values beyond what the conversation already contains, so that compaction cannot exfiltrate more than the host would.
79. As a security-conscious user, I want hook and plugin installation to respect each host's trust flow, so that Maskpoint cannot execute untrusted code.
80. As a security-conscious user, I want Maskpoint to leave host kill switches and thresholds alone, so that I retain a platform-level escape hatch.

### Observability

81. As a user, I want each compaction to report the strategy used and the size change, so that I can see the effect immediately.
82. As a user, I want persistent statistics — observations masked, characters omitted, estimated candidate size, checkpoint count, checkpoint usage — so that I can tune the budget from evidence.
83. As a user, I want zero-LLM compaction ratio measured, so that I can verify the cost claim.
84. As a user, I want the same statistics available on every platform, so that cross-tool comparison is meaningful.
85. As a user, I want headless and non-interactive runs to work without a UI, so that Maskpoint is usable in scripts, RPC, and CI.

### Maintainer

86. As an extension maintainer, I want masking, budget, checkpoint, and state-reduction policies in a platform-free core, so that they can be tested deterministically and reused by every adapter.
87. As an extension maintainer, I want adapters to be thin translation and effect layers, so that adding a platform does not fork the algorithm.
88. As an extension maintainer, I want engine rendering separated from engine decisions, so that one artifact can be rendered as Pi text, DSH content blocks, or injected markdown.
89. As an extension maintainer, I want serialized state versioned from the first release, so that later algorithm changes can migrate or ignore old state explicitly.
90. As an extension maintainer, I want platform fixtures recorded from real hosts and sanitized, so that adapter drift is reproducible in CI.
91. As an extension maintainer, I want a single sanitized fixture corpus replayed through every adapter, so that cross-platform parity is asserted rather than assumed.
92. As a future contributor, I want an adapter contract documented well enough to add a new host without touching the core, so that the project can grow beyond four platforms.

## Implementation Decisions

### Repository and packaging

- A TypeScript npm workspace. Package boundaries: `core` (platform-free engine), one package per adapter (`pi`, `dsh`, `claude-code`, `codex`), and a shared `cli` package providing the hook entrypoints that command-based hosts invoke.
- The core package depends on no host SDK and performs no I/O. Everything platform-specific — transcript parsing, hook payloads, model calls, persistence, rendering — lives in adapters.
- Pi ships as a pi package declaring its extension entrypoint. Claude Code and Codex ship as plugins bundling hook configuration plus the CLI entrypoint. DSH ships as a package implementing its compaction seam; whether it lives in-tree in DSH or loads as an external plugin is an open question recorded below.
- Runtime dependencies must be declared as production dependencies, since at least one host installs packages with development dependencies omitted.
- Node 22 or later, matching the hosts' own floors.

### Core model

- The engine consumes a **ConversationSnapshot**: an ordered item list, a retained boundary supplied by the adapter, an optional previous checkpoint, a trigger kind, optional custom instructions, and a budget configuration.
- **Conversation items** are normalized to a small vocabulary: user message, assistant text, assistant reasoning, tool call, tool result, checkpoint, and host-injected context. Each observation item carries an optional tool name, call identifier, status, exit code, and media count.
- The engine performs three pure steps: build masked history from the items outside the retained boundary, accumulate it with the previous checkpoint, and decide between returning the accumulation or requesting a checkpoint.
- **The engine never selects the cut point.** The retained boundary is an adapter input and is passed through unchanged on the way out.
- **The retained region is the only full-fidelity window.** The engine does not implement a second recency window inside the compacted span. This is what prevents frozen full observations from accumulating across repeated compactions.
- Masking is defined as: replace an observation body with a placeholder when the placeholder is smaller than the body. The comparison uses the same estimator as the budget, so the no-expansion rule and the budget agree by construction.
- Placeholders carry tool name, status, exit code when known, omitted line and character counts, and omitted image count. They never carry the body.
- Masking must be idempotent: masking an already-masked placeholder is a no-op. This makes composition with an existing platform-side pruner safe.
- Masked history preserves chronological order and explicit role labels, and is written so it is unambiguous that recorded user and tool content is historical context rather than a new instruction to execute.
- Accumulation is incremental: the candidate is the previous checkpoint followed by only the newly evicted masked history. Pi and DSH both expose a repeated-compaction boundary that makes this well-defined; adapters that lack one must detect it from their own persisted state and fall back rather than double-append.
- The checkpoint trigger compares the estimated size of the whole candidate against a configured token budget. At or below budget, the accumulation is returned as-is. Above budget, or when custom instructions are present, exactly one checkpoint call is made.
- The checkpoint output limit is a configured generation cap. A response truncated by that cap is rejected.
- A checkpoint is accepted only when the model returned non-empty text with no error, abort, length stop, or tool call.
- The checkpoint input is the accumulated masked history, not the original observation bodies. This is what makes the last-resort call materially cheaper than a host's default full-history summary.
- The checkpoint prompt requests a fixed structured format: user context and constraints, completed work, pending work, current state, code state, tests and exact errors, changes, dependencies, version-control state, key decisions, next steps. The model may be concise but must not invent missing state.
- The engine returns a platform-neutral **Outcome**: the strategy used, the artifact, statistics, and any usage. Rendering into a host's text, content-block, or markdown vocabulary is an adapter responsibility.
- The engine surfaces a **capability profile** describing what the adapter can do: replace history, steer the host summarizer, re-inject context, persist metadata, honor cancellation; plus any injection size cap.
- The engine has no knowledge of host-specific file-operation tracking, but carries an adapter-supplied file-operation summary through accumulation so that hosts which do track it can preserve it.
- Terminology is fixed: **masked history** is deterministic serialized history with observation bodies replaced; **checkpoint** is a model-generated semantic state summary. Host APIs frequently name both a "summary"; internal code and user-facing text must not conflate them.

### Adapter contract

- An adapter must: read the host's conversation, normalize it, supply the retained boundary, invoke the core, render the outcome in the host's vocabulary, apply it through the deepest supported channel, and return the host-specific result.
- An adapter must never claim native replacement unless the host can in fact accept an externally produced model-visible history.
- An adapter must degrade in a defined order: checkpoint failure returns masked history; masking or serialization failure returns no custom result, so the host's own compaction runs. An empty custom result is never returned.
- An adapter must translate its host's cancellation signal into the engine call and abandon partial work on abort.
- An adapter must persist engine state in host-native metadata where one exists, and in versioned derived state where one does not. Raw observation bodies are never persisted outside the host transcript.
- An adapter must expose the same statistics keys so that cross-platform comparison is possible.

### Pi adapter

- Integration point is the pre-compaction extension event, which covers manual `/compact`, automatic threshold compaction, and overflow recovery. The event's prepared cut point is returned unchanged.
- The extension returns a custom compaction result and thereby skips Pi's default summarization. If it returns nothing, Pi's default compaction runs — this is the fallback.
- Custom instructions passed to manual compaction force a checkpoint and are appended to its prompt.
- Persistent state lives in the compaction entry's details: schema version, engine identifier, strategy, cumulative checkpoint count, masking statistics, estimated size, and the cumulative file-operation lists. Foreign or unrecognized details are treated as absent.
- Pi does not automatically fold a hook-produced compaction's custom details into later file tracking, so the adapter merges the latest compatible details from the active branch with the current preparation's file operations.
- Checkpoint model calls use the host's model registry, a fresh routing session identifier, and disabled cache retention.
- Truncated checkpoint responses are rejected, mirroring the host, because a truncated checkpoint becomes permanent session state.
- Branch compaction for the tree view is a separate host mechanism and is not covered by this adapter.

### DSH adapter

- Integration point is the host's compaction service seam: implement the same abstract service as the host's built-in backend and let the host's preset choose which one is mounted. One backend per context.
- All three entry points are honored: automatic trigger-driven compaction, explicit idle-session compaction, and explicit region compaction. The seam's tool-call/result pairing predicates are used for region edge validation.
- The masking path must land a model-free surface replacement that carries accurate shadow pricing so the host's replay-based token accounting stays correct. The host already defines a model-free replacement protocol for its tool-result pruner; the adapter should use that protocol if the session API permits a backend to emit it, and otherwise record the routed provider and model with no summarization-call marker on the summary path. Which of the two is permitted must be verified against the host's session API before implementation and recorded as a decision.
- The checkpoint path must record the summarization call envelope (provider, model, generation cap) and usage durably, and must mark the call as going through the host's LLM seam when it does.
- The replacement is delivered as the host-sanctioned compaction checkpoint source so that host consumers can recognize and correlate it, and so the host's client can render it.
- The host may also mount its own deterministic tool-result pruner. Maskpoint must be correct with it present or absent: idempotent masking and no-expansion guarantees make the composition safe, and the order must be verified.
- Expected failures are reported with the host's existing manual-compaction error vocabulary so the command surface behaves normally.
- Automatic pressure handling must respect the host's threshold and retention policy rather than reimplementing trigger logic.

### Claude Code adapter

- The pre-compaction hook supplies the session identifier, transcript path, working directory, trigger, and custom instructions on standard input, and runs synchronously before compaction; the artifact is generated here from the complete pre-compaction transcript.
- The hook is not used to block. The host's payload does not let a hook distinguish proactive automatic compaction from recovery-after-overflow, and blocking a recovery compaction surfaces the underlying request failure. Blocking is therefore out of scope for this adapter.
- The artifact is re-injected after compaction through the documented post-compaction context channel, which caps injected text; the artifact must fit the cap and otherwise point at the persisted derived state.
- The host's summarizer is additionally steered through the pre-compaction hook's standard output where that channel exists, with the guidance being plain text, small, and silent on standard error. The adapter must not depend on this channel for correctness: if it disappears, the documented re-injection channel still delivers the artifact.
- Post-compaction audit compares the host-produced summary against the artifact and records fidelity drift as a metric, not as a correction.
- Only derived state is written to disk. The host transcript remains the sole raw history.

### Codex adapter

- Codex exposes pre-compaction and post-compaction hook events but cannot accept an externally produced replacement history today. The adapter is therefore strictly in the assisted tier.
- The host's summarization-prompt configuration is used to push state preservation and observation masking instructions into the host's own compaction request, where the host's configuration layer allows it.
- The artifact is re-injected after root-session compaction through the documented post-compaction context channel.
- The adapter detects whether provider-side native compaction is active for the current authentication mode, because in that mode the host's checkpoint may be provider-opaque and the relative value of re-injection changes. The detected mode is reported, not silently assumed.
- Hook trust is the host's own review flow; Maskpoint does not bypass it and does not require bypass flags in normal use.

### Configuration

- Shared engine settings: enabled, checkpoint trigger budget, checkpoint output cap, optional checkpoint model, small-observation behavior, notification level.
- An additional adapter setting where a host needs one, for example injected-text policy on the assisted tiers.
- Global configuration applies across projects; project configuration overrides it only in a trusted project; invalid values fall back to documented defaults with a warning.
- Settings are mapped onto each host's native configuration location rather than introducing a separate Maskpoint config system.

### Observability

- Every compaction records the strategy used, observations masked, characters omitted, estimated candidate size, whether a checkpoint ran, and checkpoint usage where a call was made.
- Host-native metadata is the primary store of these statistics; host UI reporting is optional and must not be required for headless operation.
- Cross-platform statistics use one key set so the same dashboard or script works everywhere.

### Fallback chain (applies everywhere)

1. Checkpoint attempted, succeeded → checkpoint outcome.
2. Checkpoint attempted, failed, aborted, truncated, empty, or tool-calling → masked-history outcome.
3. Masking, serialization, or persistence failed → no custom result; the host's own compaction runs.
4. Adapter cannot read or interpret the host conversation → no custom result; the host's own compaction runs.

## Testing Decisions

- **Two seams.** The suite is organized around two seams, each at the highest useful point in its layer.
- **Seam 1 — the engine, over a platform-neutral conversation snapshot.** Input is a normalized snapshot plus budget configuration; output is the outcome. This seam exercises item classification, masking scope, the no-expansion rule, idempotence, accumulation across repeated compactions, budget boundaries, checkpoint acceptance criteria, fallback, and statistics. It requires no host, no network, and no model.
- **Seam 2 — adapter conformance, over recorded host artifacts.** Input is a recorded host artifact (a session file, a hook payload, a rollout transcript) plus a controlled host context; output is the adapter's effect plan and rendered payload. This seam exercises transcript parsing, normalization fidelity, cut-point pass-through, rendered shape, persistence, capability reporting, and degradation.
- Tests assert external behavior: the artifact content, the unchanged cut point or surface range, the number and contract of model calls, reported usage, and persisted metadata. They do not assert private helper structure or incidental formatting outside the documented placeholder and checkpoint contracts.
- **One shared fixture corpus, replayed through every adapter.** A neutral conversation corpus drives Seam 1 directly and Seam 2 through per-platform recordings of the equivalent conversation, so that cross-platform parity of masked history is asserted rather than assumed. Where a host's semantics legitimately differ, the divergence is an explicit, documented expectation in the parity test.
- Recorded fixtures come from real hosts and are sanitized before commit; a sanitization check runs in CI.
- Checkpoint tests use a deterministic model double that records its request and returns controlled success, error, abort, length-stop, tool-call, and empty-text responses. Automated tests never require paid provider access.
- Masking fixtures cover text and image tool results, success and error results, shell execution, multiple and parallel tool calls, host-injected context, branch or checkpoint entries, user text, assistant text, reasoning blocks, and large tool arguments. Tests prove only observation bodies are removed.
- No-expansion and idempotence fixtures cover empty, tiny, large, and already-masked observations, and observations previously pruned by a host-side pruner.
- Repeated-compaction fixtures feed one returned artifact into the next preparation and prove that only newly evicted items are appended, that full observations never accumulate, that checkpoint counts persist, and that the candidate resets after a checkpoint.
- Budget-boundary fixtures cover estimates just below, exactly at, and just above the trigger, plus CJK, source-code, and mixed-language content, so that the estimator's conservatism is asserted rather than assumed.
- Trigger fixtures cover automatic threshold, overflow recovery, manual without instructions, and manual with instructions on every host that has those paths.
- Host-specific fixtures cover Pi's split-turn preparation, image and custom message entries, and foreign compaction details; DSH's pairing rules, pruner-present and pruner-absent compositions, and the exact session-event sequence for each path; Claude Code's pre-compaction payload, post-compaction summary, and re-injection cap; Codex's hook payloads and native-compaction detection.
- Capability tests assert that assisted adapters never report native replacement, and that each adapter's declared profile matches the behavior exercised by its fixtures.
- Degradation tests force each fallback stage and assert the observed result, including that a total failure leaves the host's default compaction path intact.
- Configuration tests cover defaults, global values, trusted and untrusted project overrides, disabled mode, invalid numbers, unknown keys, and missing or unauthenticated checkpoint models.
- Smoke verification is manual and per platform: load the artifact into Pi and force a small threshold; mount the backend in a DSH preset and exercise the command surface; pipe synthetic hook payloads into the Claude Code and Codex entrypoints and inspect the injected text and persisted derived state.
- Dogfooding records zero-LLM compaction ratio, checkpoint input and output tokens, context size before and after, checkpoint failures, and cross-platform parity drift. Initial targets: at least 70 percent of compactions with zero LLM calls, and a strict context-size decrease on every successful masking or native-replacement compaction.
- Prior art: the repository has no implementation yet. Behavioral references are Pi's official custom-compaction example and compaction lifecycle, DSH's compaction seam tests and tool-result pruner tests, and the JetBrains Research history-processor tests. Local tests adopt their externally visible cases without copying framework-specific internals.
- Tooling is the repository's choice as long as it runs in CI without host binaries; host-dependent smoke tests are documented manual procedures rather than CI requirements.

## Out of Scope

- Forking Claude Code or Codex, and shipping patches against their internal compaction paths.
- Upstream proposals to add a replacement-history extension point to Codex or Claude Code. The assisted adapters exist precisely because those do not exist yet.
- Hosting our own agent loop through either vendor's SDK as a way to gain full control.
- Continuous request-time masking that rewrites the prompt on every model call. It is the most faithful reading of the research, but it invalidates prompt-cache prefixes and multiplies per-call cost risk; it is a later experiment, not part of the first release.
- Replacing a host's trigger thresholds, reserve or retention settings, or overflow-retry loops.
- Custom branch or tree summaries on hosts that separate that mechanism from compaction.
- Model training, fine-tuning, or distillation.
- Reproducing the paper's benchmark or leaderboard evaluation.
- Deleting or rewriting raw entries in any host's append-only session store.
- Persisting raw observation bodies outside host transcripts.
- Retrieval, embeddings, vector search, or long-term cross-session memory.
- A graphical user interface.
- Exact provider tokenizer parity; host-provided meters are used where available and the engine's own estimator elsewhere.

## Further Notes

- Research basis: *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management* (arXiv:2508.21433, DL4Code at NeurIPS 2025), the JetBrains Research article "Cutting Through the Noise: Smarter Context Management for LLM-Powered Agents", and the accompanying `the-complexity-trap` repository. Reference implementation: the SWE-agent fork's history processors.
- Reported results to calibrate against: both strategies cut cost by more than half versus an unmasked agent without hurting solve rate; masking was the cheapest; LLM summarization elongated trajectories about fifteen percent; the hybrid cut cost further with a small solve-rate gain; cache hits are up to an order of magnitude cheaper than misses, which is why the reference implementation quantizes its masking boundary.
- Reported parameters are not portable. The paper's best hybrid used a 43-step checkpoint batch, 10 retained steps, and a 10-observation masking window, calibrated so that masked accumulation at 43 steps matched raw accumulation at 21. Maskpoint replaces step counts with the host's own retained window and a token budget, so these numbers are calibration context, not defaults.
- Terminology mapping: the paper's rolling observation window corresponds to the host's own retained recent window in this design; the paper's periodic summarization corresponds to the budgeted checkpoint.
- Observation masking slows growth but cannot bound it: preserved reasoning, actions, user messages, and placeholders still accumulate. The checkpoint budget is what makes the strategy bounded over arbitrarily long sessions.
- Platform capability evidence as of September 2026. Pi exposes a pre-compaction event whose custom result fully replaces the default summarize step for manual, threshold, and overflow triggers, with an advisory cut point that the hook may override. DSH exposes an abstract compaction service with automatic, manual, and explicit-region entry points, a model-free replacement protocol used by its own tool-result pruner, session events that record the summarization envelope, pairing predicates, and a singleton token meter. Claude Code exposes pre-compaction and post-compaction hooks and a post-compaction context-injection channel, but its summary prompt, summarizer call, and history swap are internal; a hook cannot supply replacement history. Codex CLI exposes pre-compaction and post-compaction hook events and a summarization-prompt configuration, but likewise cannot accept an externally produced replacement history. These capabilities must be re-verified per host release; the conformance fixtures are the mechanism that turns drift into a red test rather than a silent regression.
- Naming: the name combines the two engine stages, masking and checkpointing, and is platform-neutral. `context-fold` and `ctxfold` are already taken on npm, one of them by a Pi extension with a nearly identical positioning, so those names are excluded.
- Open questions. First, whether the DSH adapter ships inside that repository as an in-tree backend or loads as an external plugin; this depends on how external service providers are permitted to register against the compaction seam. Second, which host-sanctioned session event a model-free masked replacement may emit on DSH, and whether a compaction backend may use the prune protocol. Third, what Codex's provider-side native compaction does to the relative value of artifact re-injection under each authentication mode. Fourth, whether the assisted tier delivers enough value beyond the host summary to justify its duplication cost, or whether its main value there is the audit and re-injection of derived state. Fifth, whether continuous request-time masking is worth prototyping on the hosts that can express it without invalidating cache prefixes.
