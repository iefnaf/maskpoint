import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'

/**
 * `SummarizationInput` and `SummaryResult` as `dsh-compaction-basic` defines them. The package root
 * does not re-export them and its `./src/*` export points at files the published package does not
 * ship, so they are restated here. `summarize()` is the host's documented subclass hook; the
 * override is checked against the host's own signature, so drift is a type error, not a silent one.
 */
export interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  /** The region being compacted, in surface order. */
  readonly messages: readonly Message[]
}

export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)
