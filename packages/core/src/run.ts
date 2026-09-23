import { requestCheckpoint } from './checkpoint.js'
import { decide } from './decide.js'
import type { MaskOptions } from './mask.js'
import type { BudgetPolicy, ConversationSnapshot, EngineDeps, Outcome } from './vocabulary.js'

/**
 * The engine entry: mask, accumulate, decide, and make the one checkpoint call only when the
 * decision asks for it. The masked-history path never touches a model.
 *
 * Mask options are passed through rather than defaulted: `decide` already takes them, and an adapter
 * that reaches the engine this way (Pi, DSH) would otherwise have no way to ask for anything beyond
 * the documented default without reimplementing the call.
 */
export async function run(
  snapshot: ConversationSnapshot,
  budget: BudgetPolicy,
  deps: EngineDeps,
  options: MaskOptions = {},
): Promise<Outcome> {
  const decision = decide(snapshot, budget, options)
  if (decision.kind !== 'checkpoint-requested') return decision
  return requestCheckpoint(decision, snapshot, deps)
}

/**
 * `run` with the checkpoint call refused (`checkpointEnabled: false`): the decision's masked-history
 * fallback stands whatever the budget — or a manual focus request — says, so a compaction never
 * touches a model. Unlike a rejected checkpoint this is not a failure: there is no
 * `checkpointRejection` to report, because nothing was attempted.
 */
export function runMaskOnly(snapshot: ConversationSnapshot, budget: BudgetPolicy, options: MaskOptions = {}): Outcome {
  const decision = decide(snapshot, budget, options)
  return decision.kind === 'checkpoint-requested' ? decision.fallback : decision
}
