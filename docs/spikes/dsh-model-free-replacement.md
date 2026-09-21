# Spike: DSH model-free replacement and packaging

**Status:** done · **Work anchor:** issue #9 · **Feeds:** #10, #11 · **Decisions recorded in:** [`docs/design.md`](../design.md) Open issues 1 and 2 · **Evidence code:** [`dsh-model-free-replacement.spike.ts`](dsh-model-free-replacement.spike.ts)

Investigated against deepseek-harness ("DSH") commit `47f943859b`, package version `0.1.0-rc.5`. DSH is at release-candidate; every claim below needs re-verifying per host release (design §Testing).

## Outcome

1. **Model-free masking lands two ways, chosen by entry point.** The automatic entry (`compactIfNeeded`) reuses the host's prune protocol, in place. The explicit entries (`compactNow`, `compactRegion`) use the summary path with a Maskpoint envelope and no summarization-call marker. Neither candidate alone covers every entry point.
2. **The backend ships as an external package**, installed as a DSH bundle that disables the built-in backend and inserts ours. Not as an in-tree sibling.
3. **Host token accounting stays exact under both landings**, checked against all three readers: `measure().totalTokens`, and the `contextBreakdown` and `contextPressure` replay projections.
4. **Two corrections to the design doc:** the summary path does not require a summarization-call marker, and a patch's `name` cannot retarget a row.

## Method

A characterization suite (12 tests) run in an isolated copy of DSH. Each landing shape is built with only public entrypoints and appended to a real session, under DSH's real token meter, real replay projections, and the session and compaction invariant companions. The fixture is three closed turns, each with a user prompt, one large tool observation, and a closing assistant message; the last message carries provider usage so the pressure figure is anchored the way a live session is. Landings run both inside an open fourth turn (the automatic path) and with the session idle (the manual path).

Baseline before adding the spike: DSH's own pruner and `compaction-basic` specs pass (90 tests). After: all compaction and token-meter suites pass (16 files, 260 tests).

## Unknown 1: durable representation of a model-free masked replacement

### What the host's model-free protocol is

The pruner's landing, `packages/compaction/compaction-tool-result-pruner/src/index.ts:162-172`: append a `compaction/prune` shadow-price event, then immediately append a `tool/result` replacement with `surfaceOp: replace` and `sourceEventSeqs` citing the shadowed node. Both replay projections (`surface-projection.ts:70`) treat `compaction/prune` and `compaction/summary` identically: each arms a claim that the next replacement must consume, and a claim for a different range throws.

### Landing matrix

Every row was run; "accounting" means all three readers agree and the total moved by exactly the priced delta.

| Shape | Open turn (automatic) | Idle (manual) | Notes |
|---|---|---|---|
| **A1** in place: `[compaction/prune, tool/result(replace)]` per observation | Lands. Accounting exact. | **Rejected**: `tool/result surface replacement appended outside any open turn` (`core/session/src/invariant.ts:132`) | The pruner's own shape. No bracket, no envelope, no lie. |
| **A2** region `user/message`, checkpoint provenance, inside `compaction/start…end`, `compaction/prune` instead of `compaction/summary` | **Rejected at `compaction/end`**: `successful compaction/end requires one compaction/summary` (`compaction/src/invariant.ts:215`) | same | The replacement had already committed, so the failure leaves the surface replaced and the lock unclosed. |
| **A3** as A2, no bracket | **Rejected**: `compaction checkpoint has no matching compaction/start` (`invariant.ts:68`) | same | Nothing landed. |
| **A4** region `user/message`, plain source, no bracket | Lands. Accounting exact. | not run | Off-contract: no lock, and `isCompactCheckpointSource` is false, so consumers cannot recognise it. |
| **B** summary path, `compaction/summary` with envelope, no `llmStreamCall` | Lands via the real backend. Accounting exact. | Lands via `compactNow`. Accounting exact. | Only shape that works in both contexts. |

Event sequences observed:

- A1: `compaction/prune`, `tool/result(replace)`, repeated once per masked observation.
- B: `compaction/start`, `compaction/summary`, `user/message(replace)`, `compaction/end`. Idle `compaction/start` has `turn: null`.

### Accounting evidence

| | Before | After | Shadowed | Replacement |
|---|---|---|---|---|
| A1, three observations | total 9,054 · surface 3,620 | total 5,652 · surface 218 | 3,486 | 84 |
| B, whole closed region | total 9,054 · surface 3,620 | total 5,641 · surface 207 | 3,606 | 193 |

In both, `contextBreakdown.messageTokens` equals `measure().surfaceTokens` after landing, and the totals fall by exactly shadowed minus replacement (A1: 3,402; B: 3,413). For A1 the `contextPressure` projected figure also moves by exactly that delta. A1 advances `surface.replaceGeneration`, which is what the overflow-retry path uses as proof of progress (`compaction-basic/src/index.ts:191-219`). Masking left every non-observation message deep-equal and left every tool-call/result pairing predicate unchanged.

**Negative control:** the same in-place replacement without the `compaction/prune` shadow price makes `measure().surfaceTokens` fall while `contextBreakdown.messageTokens` still counts the old body. The shadow price is what keeps replay accounting correct, which is why a plain content rewrite is not an option.

### Decision

- **Automatic entry (`compactIfNeeded`): A1.** It is the only shape that is legal, honest, and composes with the host's own pruner. `compactIfNeeded` is documented to return `null` when no summary ran, and `compaction-basic` already returns `null` after a prune-only pass, so a prune-only landing fits its return type.
- **Explicit entries (`compactNow`, `compactRegion`): B, with a Maskpoint envelope.** `provider: 'maskpoint'`, `model: 'mask-only'`, no `llmStreamCall`, no `usage`. Two independent reasons, either sufficient: A1 is illegal when idle, and both methods must return a `CompactionResult`, whose `startSeq`/`summarySeq`/`endSeq` a prune landing cannot populate. `/compact` also needs a non-null result: on `null` it prints "No compactable history yet." (`command-compact/src/index.ts:67`) and it cites `summarySeq`.
- **Checkpoint path stays the ordinary marked call** (`llmStreamCall: true`, real envelope, real usage). That is issue #11.

### Rejected

- **Prune protocol for everything.** Cannot serve the manual path: A1 is illegal when idle, and the region-level variants (A2, A3) are rejected by the compaction invariant. A4 lands but leaves the seam.
- **Summary path for everything, with the routed provider and model as the envelope.** That is the misreport the issue warns about. The trajectory view builds a completed compaction request from `compaction/summary`, presenting `provider`/`model` as provenance and request config (`ui-trajectory/src/client/trajectory-compaction-definition.ts:62-75`). Claiming the session's real model wrote masked history would be false. The sentinel envelope is honest about the author but still shows a completed compaction request with no usage.

### Cost of B, and the way out

B is a reluctant fallback, confined to the two entries that cannot use A1. Its cost is that the host names the masked history a "summary" and a trajectory shows a `maskpoint/mask-only` compaction request with no usage. The clean fix is upstream: let a `compaction/prune` shadow price satisfy a bracket's "one summary" requirement, and make `CompactionResult.summarySeq` optional. That would let the explicit entries use the prune protocol too. It is not needed for v1 and is not assumed anywhere.

## Unknown 2: packaging

### Evidence

- **The seam is a plain Cordis service.** `CompactionEngine extends Service` and registers as `compaction` (`compaction/src/index.ts`); `command-compact` injects `compaction` and is documented as backend-independent. A class extending it from public entrypoints mounts as `ctx.compaction` under the real Loader, under any package name.
- **One backend per context.** Mounting a second provider beside the built-in fails: `service "compaction" has been registered at <BasicCompactionEngine>`. An external backend must replace the built-in row, not sit next to it.
- **A patch's `name` is a guard, not a retarget.** `applyEntryPatches` skips a patch whose `name` differs from the target row's (`vendor/include/src/index.ts:116`). A patch `{ id: 'compaction-basic', name: 'maskpoint-dsh' }` leaves the built-in mounted (tested). What works: disable the built-in row, naming it in the guard, and insert ours: `{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true }` plus `{ insert: [{ id: 'maskpoint', name: 'maskpoint-dsh' }] }` (tested). This corrects the app-boot README's wording that an id-targeted patch only replaces `config`.
- **Out-of-tree install is a documented path.** A bundle declares `dsh.bundle` in its `package.json`; `dsh plugin add` installs it into a profile, and the Loader resolves names from the profile's `node_modules` (`docs/user/develop/basic/publish.md`, `app-boot/src/profile.ts:15-21`). Read from source and docs; not run end to end.
- **The subclass hook is public.** `BasicCompactionEngine.summarize()` is the documented sole customization hook, so B does not require re-implementing the compaction transaction (lock, stability check, error classification, flush). Both explicit entries run through it.

### Decision

**External package**, shipped as a DSH bundle. It follows the design's "documented extension points only" constraint, keeps the shared core in our workspace (an in-tree DSH package would still have to depend on our core), and leaves our release cadence independent of DSH's. The seam surface it depends on is the same either way, so moving in-tree later is a code move, not a rewrite.

### Rejected: in-tree sibling of `dsh-compaction-basic`

Technically simpler, and it would make the backend selectable from the shipped presets. Rejected because it makes us a contributor to a repo we do not control, obliges DSH to take a dependency on our core (or a vendored copy of it, breaking "one algorithm"), and couples our releases to theirs. Nothing in the evidence made it necessary.

### Risks accepted with this decision

- **Shipped presets do not follow a bundle patch.** `standard`, `code`, and `cordis` each mount `dsh-compaction-basic` in their own isolated `compaction` realm (`apps/cli/config/agent-presets/*/agent.cordis.yml`), and presets have no patch layer (`agent-presets/README.md:153`). A bundle patch reaches the host-plane row; an agent in a shipped preset needs a user-authored preset copy with the row swapped. **Not verified:** which realm an agent's compaction actually resolves to, and whether an external package name resolves inside a preset composition. This is the first thing #10 must settle, and if it proves unworkable it is the strongest argument for revisiting in-tree.
- **rc-stage seam.** Types and event shapes can change between host releases; the per-release conformance fixtures in the design's testing section are the mitigation.
- **Deep import of two types.** `SummaryResult` and `SummarizationInput` are not re-exported from the `dsh-compaction-basic` root; they are reachable through its `./src/*` export. Ask upstream to re-export, or restate the two small types.
- **Invariants appear not to be mounted in the shipped product.** They run in DSH's test topologies and the agent-spine demo composition (which mounts the session, agent, scope, and agent-loop companions but not compaction). A search of the shipped bundle, presets, and launcher found no mount of the registry. So the rejections in the matrix are the seam's contract, not a guard users would hit, and a shape that violates it would probably land silently in production. Our conformance tests must mount the session and compaction companions themselves.

## Not verified

- A real `dsh plugin add` and boot with the external bundle. The spike proves the Loader and patch semantics on the real plugin classes, not the launcher.
- Behaviour in a shipped preset realm (above).
- B with the checkpoint path: overriding `summarize()` to return masked history under budget and delegating to `super.summarize()` (a marked LLM call) over budget. Only the unmarked half was run. Issue #11 owns it.
- Whether the built-in pruner, present or absent, needs an ordering rule with A1. Both use the same protocol on the same nodes, so it should compose, but the spike did not run them together. Issue #10 owns it.
- A `toolResultPruner` substitute as the way to host A1. `compaction-basic` calls `ctx.get('toolResultPruner')?.pruneSession` before range selection, so a Maskpoint masker registered under that service might be the whole automatic adapter. Untested lead for #10.

## Consequences for the design

- **The DSH accumulation problem mostly disappears on the automatic path.** DSH's surface already is the accumulated state, and A1 masks it in place, so there is no candidate to assemble and no cursor to persist. The budget comparison becomes `measure()` against the trigger. This is a lead for #10 and #11, not a settled design change.
- **Placeholder rule carries over unchanged.** A1's placeholder is Maskpoint's (tool, status, size; never body) with the no-expansion check made against the meter's own estimator, as in the spike.
- **Vocabulary.** In fallback B the host's `compaction/summary` event carries *masked history*, not a *checkpoint*. That is a host naming artifact; the glossary distinction stands.
