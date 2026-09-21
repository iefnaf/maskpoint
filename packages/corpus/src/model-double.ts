import type { ModelRequest, ModelResponse, Usage } from '@maskpoint/core'

/**
 * A deterministic stand-in for the host's model call, for Seam 1 and, later, adapter conformance.
 * It records every request it receives and answers with one scripted response, so a test can assert
 * the number and contract of model calls and every way a call can end. No network, ever.
 */
export interface ModelDouble {
  complete(request: ModelRequest): Promise<ModelResponse>
  /** Every request received, in order. */
  readonly requests: readonly ModelRequest[]
}

/** What the double does when called: answer with a response, or throw as a host or provider might. */
export type Script = ModelResponse | Error

const DEFAULT_USAGE: Usage = { inputTokens: 1200, outputTokens: 300 }

/** The six ways a checkpoint call can end that the design's testing section requires covering. */
export const responses = {
  success: (text: string, usage: Usage = DEFAULT_USAGE): ModelResponse => ({ stopReason: 'stop', text, usage }),
  providerError: (message: string): ModelResponse => ({ stopReason: 'error', text: '', error: message }),
  aborted: (): ModelResponse => ({ stopReason: 'aborted', text: '' }),
  /** Cut off by the output cap: the text is whatever fitted, and must never be used. */
  lengthStop: (partialText: string, usage: Usage = DEFAULT_USAGE): ModelResponse => ({
    stopReason: 'length',
    text: partialText,
    usage,
  }),
  toolCall: (): ModelResponse => ({ stopReason: 'tool-call', text: '' }),
  empty: (): ModelResponse => ({ stopReason: 'stop', text: '', usage: DEFAULT_USAGE }),
}

export function modelDouble(script: Script): ModelDouble {
  const requests: ModelRequest[] = []
  return {
    requests,
    async complete(request) {
      requests.push(request)
      if (script instanceof Error) throw script
      return script
    },
  }
}
