import { describe, expect, it, vi } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { agentFor, conversation, harness, replies, scriptedHarness, sequence } from './harness.js'

const signal = new AbortController().signal

describe('the maskpoint row config (issue #8)', () => {
  it('defaults to enabled, the design budget, and normal notification level with no config at all', async () => {
    const ctx = await harness(1_000_000)
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    expect(ctx.compaction).toBeInstanceOf(MaskpointCompactionEngine)
    const engine = ctx.compaction as MaskpointCompactionEngine
    expect(engine.maskpointConfig).toEqual({ enabled: true, checkpointTriggerTokens: 12_000, maskReasoning: false, notificationLevel: 'normal' })
  })

  it('lowers the checkpoint trigger from the row config, changing masking into a checkpoint end to end', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text('## Next steps\n- none'))
    await ctx.plugin(MaskpointCompactionEngine, { auto: false, checkpointTriggerTokens: 50 })
    const { session } = conversation(ctx, { openTurn: false })

    const result = await ctx.compaction.compactNow(agentFor(session), signal)

    expect(result).not.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('runs the default budget (no checkpoint call) when checkpointTriggerTokens is not configured', async () => {
    const { ctx, calls } = await scriptedHarness(() => replies.text('## Next steps\n- none'))
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: false })

    await ctx.compaction.compactNow(agentFor(session), signal)

    expect(calls).toHaveLength(0)
  })

  it('falls back to the default budget and warns when checkpointTriggerTokens is invalid, instead of failing to load', async () => {
    const ctx = await harness(1_000_000)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(MaskpointCompactionEngine, { auto: false, checkpointTriggerTokens: -5 })
    const engine = ctx.compaction as MaskpointCompactionEngine

    expect(engine.maskpointConfig.checkpointTriggerTokens).toBe(12_000)
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'maskpoint: config: invalid global value for "checkpointTriggerTokens" (-5); ignoring it',
    ])
  })

  it('warns and ignores an unknown row key rather than failing to load', async () => {
    const ctx = await harness(1_000_000)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const misspelled: Record<string, unknown> = { auto: false, notificaitonLevel: 'silent' }
    await ctx.plugin(MaskpointCompactionEngine, misspelled)

    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'maskpoint: config: unknown global configuration key "notificaitonLevel" ignored',
    ])
  })

  it('suppresses routine info logging at notificationLevel "silent"', async () => {
    const ctx = await harness(10_000)
    const info = vi.spyOn(ctx.logger, 'info')
    await ctx.plugin(MaskpointCompactionEngine, { auto: false, notificationLevel: 'silent' })
    const { session } = conversation(ctx, { openTurn: true })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(info).not.toHaveBeenCalled()
  })

  it('logs routine info at the default notification level', async () => {
    const ctx = await harness(10_000)
    const info = vi.spyOn(ctx.logger, 'info')
    await ctx.plugin(MaskpointCompactionEngine, { auto: false })
    const { session } = conversation(ctx, { openTurn: true })

    await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

    expect(info).toHaveBeenCalled()
  })

  describe('enabled: false', () => {
    it("delegates automatic compaction to the host's own (model-based) summarizer, never Maskpoint's model-free masking", async () => {
      const { ctx, calls } = await scriptedHarness(() => replies.text('host wrote this'), { contextWindow: 10_000 })
      await ctx.plugin(MaskpointCompactionEngine, { auto: false, enabled: false })
      const { session } = conversation(ctx, { openTurn: true })

      const result = await ctx.compaction.compactIfNeeded(agentFor(session), 'pressure', signal)

      expect(result).not.toBeNull()
      expect(calls).toHaveLength(1)
      // The unmodified built-in's own compaction event, not Maskpoint's prune-protocol landing.
      expect(sequence(session, 0).filter((event) => event.startsWith('compaction/'))).not.toContain('compaction/prune')
    })

    it('runs the host summary path unmasked for compactNow, never calling Maskpoint at all', async () => {
      const { ctx, calls } = await scriptedHarness(() => replies.text('host wrote this'))
      await ctx.plugin(MaskpointCompactionEngine, { auto: false, enabled: false, checkpointTriggerTokens: 1 })
      const { session } = conversation(ctx, { openTurn: false })

      const result = await ctx.compaction.compactNow(agentFor(session), signal)

      expect(result).not.toBeNull()
      expect(calls).toHaveLength(1)
      const summary = session.events[result!.summarySeq]
      if (summary?.type !== 'compaction/summary') throw new Error('expected compaction/summary')
      // The host's own envelope, not Maskpoint's mask-only or checkpoint identity.
      expect(summary.data.provider).not.toBe('maskpoint')
    })
  })
})
