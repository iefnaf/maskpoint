# @maskpoint/core

The Maskpoint engine: platform-free vocabulary, masking rules, accumulation, and the budget decision.
No host SDK, no I/O, no runtime dependencies — every adapter in this workspace calls this package and
translates its own host's shapes into and out of it, which is what keeps one algorithm behind four
hosts instead of four subtly different behaviours.

```ts
import { run, DEFAULT_BUDGET } from '@maskpoint/core'

const outcome = await run(snapshot, DEFAULT_BUDGET, deps)
```

`run` masks, accumulates, decides, and makes the one checkpoint call only when the decision asks for
it:

```text
run(snapshot, budget, deps)
  decide(...)                  # pure and synchronous: mask the evicted span, measure the candidate
    → masked-history           #   within budget: returned as is, and no model call was possible
    → checkpoint-requested     #   over budget, or a focus was asked for: requestCheckpoint(...)
    → decline                  #   nothing to compact, or a cursor that cannot be trusted
```

## What is here

| Export | Role |
| --- | --- |
| `run` | the engine entry: decide, and checkpoint only when asked |
| `decide`, `DEFAULT_BUDGET`, `budgetOf` | the pure decision, and the accumulated-token budget that triggers a checkpoint |
| `maskItems`, `maskSpan`, `MaskingError` | the masking rules: tool results out, placeholders in |
| `estimateTokens` | the internal estimator used where the host exposes no meter |
| `candidateTokens`, `artifactCandidateText`, `payloadOf` | how a candidate is measured and rendered |
| `CHECKPOINT_SECTIONS` | the structured shape a checkpoint's output must carry |
| `resolveEngineConfig`, `resolveEngineConfigLayer`, `DEFAULT_ENGINE_CONFIG` | the shared configuration surface every adapter maps onto its host's own settings |
| `HISTORY_FRAMING`, `roleLabel` | how masked history is framed for the model, so it reads as record rather than instruction |
| types in `vocabulary.ts` | `ConversationSnapshot`, `Item`, `Outcome`, `EngineDetail`, `CapabilityProfile`, … |

Callers own the host seam: an adapter supplies the snapshot, the model call, and rendering, and gets
back either masked history or a checkpoint — never a partially applied result.

## Two invariants this package enforces on itself

Both are pinned by tests in `test/`, not conventions:

- **Purity** (`test/purity.test.ts`): no `node:` builtins, no packages, no `process`/`fetch`/globals —
  the engine is host-free, and that is a red test rather than an aspiration.
- **No silent loss**: a decline is a reason (`no-size-reduction`, `nothing-to-compact`,
  `inconsistent-cursor`, `masking-failure`, …), so "Maskpoint stepped aside" is always distinguishable
  from "Maskpoint did nothing".

## Documentation

- [`docs/design.md`](../../docs/design.md) — algorithms, the budget, quality bars
- [`docs/spec.md`](../../docs/spec.md) — user stories and testing decisions

## License

MIT
