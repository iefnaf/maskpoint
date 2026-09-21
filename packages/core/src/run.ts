import { requestCheckpoint } from './checkpoint.js'
import { decide } from './decide.js'
import type { BudgetPolicy, ConversationSnapshot, EngineDeps, Outcome } from './vocabulary.js'

/**
 * The engine entry: mask, accumulate, decide, and make the one checkpoint call only when the
 * decision asks for it. The masked-history path never touches a model.
 */
export async function run(snapshot: ConversationSnapshot, budget: BudgetPolicy, deps: EngineDeps): Promise<Outcome> {
  const decision = decide(snapshot, budget)
  if (decision.kind !== 'checkpoint-requested') return decision
  return requestCheckpoint(decision, snapshot, deps)
}
