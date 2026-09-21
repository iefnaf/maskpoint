import type { ModelRequest } from '@maskpoint/core'
import { describe, expect, it } from 'vitest'
import { modelDouble, responses } from '../src/model-double.js'

const request: ModelRequest = {
  instructions: 'condense',
  input: 'history',
  maxOutputTokens: 100,
  routingId: 'r1',
  cacheRetention: 'none',
  tools: [],
  signal: new AbortController().signal,
}

describe('the deterministic model double', () => {
  it('records every request it receives, in order, and answers each with the script', async () => {
    const double = modelDouble(responses.success('state'))
    const second = { ...request, routingId: 'r2' }
    expect(await double.complete(request)).toMatchObject({ stopReason: 'stop', text: 'state' })
    await double.complete(second)
    expect(double.requests).toEqual([request, second])
  })

  it.each([
    ['success', responses.success('state'), { stopReason: 'stop', text: 'state' }],
    ['provider error', responses.providerError('boom'), { stopReason: 'error', error: 'boom' }],
    ['abort', responses.aborted(), { stopReason: 'aborted' }],
    ['length stop', responses.lengthStop('half a che'), { stopReason: 'length', text: 'half a che' }],
    ['tool call', responses.toolCall(), { stopReason: 'tool-call' }],
    ['empty response', responses.empty(), { stopReason: 'stop', text: '' }],
  ])('covers %s', async (_label, script, expected) => {
    expect(await modelDouble(script).complete(request)).toMatchObject(expected)
  })

  it('can throw as a host or provider might, after recording the request', async () => {
    const double = modelDouble(new Error('socket hang up'))
    await expect(double.complete(request)).rejects.toThrow('socket hang up')
    expect(double.requests).toEqual([request])
  })
})
