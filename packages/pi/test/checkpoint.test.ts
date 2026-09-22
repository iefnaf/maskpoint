import { describe, expect, it, vi } from 'vitest'
import { planCompaction } from '../src/compact.js'
import type { PiModelRegistry } from '../src/host.js'
import { firstTurn, native } from './support/scenario.js'
import { beforeCompact, fakeContext, modelReply } from './support/session.js'

describe('planCompaction — over budget, with a checkpoint available', () => {
  it('makes exactly one model call and returns the checkpoint it wrote', async () => {
    const complete = vi.fn().mockResolvedValue(modelReply('## Goal\nRename Widget to Panel.'))
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } }),
    )
    expect(complete).toHaveBeenCalledTimes(1)
    expect(effect.detail.strategy).toBe('checkpoint')
    expect(effect.detail.checkpoints).toBe(1)
    expect(effect.summary).toContain('Rename Widget to Panel.')
    expect(effect.summary).not.toContain('BODY-1')
  })

  it("sends the accumulated masked history as input, never a raw observation body", async () => {
    let sent: { systemPrompt?: string; messages: readonly { content: string }[] } | undefined
    const complete: PiModelRegistry['complete'] = (_model, context) => {
      sent = context
      return Promise.resolve(modelReply('a checkpoint'))
    }
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } })
    expect(sent?.messages[0]?.content).toContain('Rename the Widget component to Panel and update the docs.')
    expect(sent?.messages[0]?.content).not.toContain('BODY-1')
  })

  it('reports the checkpoint call usage', async () => {
    const complete = vi.fn().mockResolvedValue(modelReply('a checkpoint', { usage: { input: 321, output: 65 } }))
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } }),
    )
    expect(effect.usage).toEqual({ inputTokens: 321, outputTokens: 65 })
  })
})

describe('planCompaction — custom instructions', () => {
  it('forces a checkpoint within budget, and the focus reaches the prompt', async () => {
    let sent: { systemPrompt?: string } | undefined
    const complete: PiModelRegistry['complete'] = (_model, context) => {
      sent = context
      return Promise.resolve(modelReply('a focused checkpoint'))
    }
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2', { reason: 'manual', customInstructions: 'focus on the docs' }), ctx),
    )
    expect(effect.summary).toContain('a focused checkpoint')
    expect(sent?.systemPrompt).toContain('focus on the docs')
  })

  it('treats blank instructions as none: no checkpoint is forced', async () => {
    const complete = vi.fn()
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = await planCompaction(beforeCompact(firstTurn(), 'u2', { reason: 'manual', customInstructions: '   ' }), ctx)
    expect(effect.kind).toBe('native')
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('planCompaction — a checkpoint call that is not accepted', () => {
  it('falls back to masked history on a provider error, never to a decline', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('boom'))
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } }),
    )
    expect(effect.detail.strategy).toBe('mask')
    expect(effect.checkpointRejection).toBe('provider-error')
    expect(effect.summary).not.toContain('BODY-1')
  })

  it('discards a truncated reply and falls back to masked history', async () => {
    const complete = vi.fn().mockResolvedValue(modelReply('cut off mid-', { stopReason: 'length' }))
    const ctx = { ...fakeContext(), modelRegistry: { complete } }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } }),
    )
    expect(effect.checkpointRejection).toBe('truncated')
    expect(effect.summary).not.toContain('cut off mid-')
  })

  it('falls back to masked history when no model is configured for the session', async () => {
    const ctx = { ...fakeContext(), model: undefined }
    const effect = native(
      await planCompaction(beforeCompact(firstTurn(), 'u2'), ctx, { budget: { checkpointTriggerTokens: 1 } }),
    )
    expect(effect.detail.strategy).toBe('mask')
    expect(effect.checkpointRejection).toBe('provider-error')
  })
})
