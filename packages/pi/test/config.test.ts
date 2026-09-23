import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG } from '@maskpoint/core'
import { CHANNELS, flagSpecs, loadConfig, readFlags } from '../src/config.js'

const collecting = () => {
  const warned: string[] = []
  return { warned, warn: (message: string) => warned.push(message) }
}

describe('loadConfig — the channels Pi leaves an extension', () => {
  it('resolves the documented defaults when no channel supplies anything', () => {
    const { warned, warn } = collecting()
    expect(loadConfig({}, warn)).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual([])
  })

  it('reads every field from its environment variable', () => {
    const { warned, warn } = collecting()
    const config = loadConfig(
      {
        env: {
          MASKPOINT_ENABLED: 'false',
          MASKPOINT_COMPACT_BUDGET_TOKENS: '20000',
          MASKPOINT_CHECKPOINT_MODEL: 'glm-4.6',
          MASKPOINT_CHECKPOINT_ENABLED: 'false',
          MASKPOINT_MASK_REASONING: 'true',
          MASKPOINT_NOTIFICATION_LEVEL: 'verbose',
        },
      },
      warn,
    )
    expect(config).toEqual({
      enabled: false,
      compactBudgetTokens: 20_000,
      checkpointModel: 'glm-4.6',
      checkpointEnabled: false,
      maskReasoning: true,
      notificationLevel: 'verbose',
    })
    expect(warned).toEqual([])
  })

  it('reads every field from its flag as well', () => {
    const { warned, warn } = collecting()
    const config = loadConfig(
      {
        flags: {
          enabled: true,
          compactBudgetTokens: '9000',
          checkpointModel: 'glm-4.6',
          checkpointEnabled: false,
          maskReasoning: true,
          notificationLevel: 'silent',
        },
      },
      warn,
    )
    expect(config).toEqual({
      enabled: true,
      compactBudgetTokens: 9_000,
      checkpointModel: 'glm-4.6',
      checkpointEnabled: false,
      maskReasoning: true,
      notificationLevel: 'silent',
    })
    expect(warned).toEqual([])
  })

  it('accepts the two spellings of a boolean an operator is likely to type', () => {
    const { warn } = collecting()
    expect(loadConfig({ env: { MASKPOINT_ENABLED: 'true' } }, warn).enabled).toBe(true)
    expect(loadConfig({ env: { MASKPOINT_ENABLED: '0' } }, warn).enabled).toBe(false)
    expect(loadConfig({ env: { MASKPOINT_CHECKPOINT_ENABLED: '1' } }, warn).checkpointEnabled).toBe(true)
    expect(loadConfig({ env: { MASKPOINT_CHECKPOINT_ENABLED: 'false' } }, warn).checkpointEnabled).toBe(false)
  })

  it('applies host, environment and flag in escalating order', () => {
    const { warn } = collecting()
    const config = loadConfig(
      {
        host: { compactBudgetTokens: 5_000, notificationLevel: 'verbose' },
        env: { MASKPOINT_COMPACT_BUDGET_TOKENS: '20_000' },
        flags: { compactBudgetTokens: '9000', notificationLevel: 'silent' },
      },
      warn,
    )
    expect(config.compactBudgetTokens).toBe(9_000)
    expect(config.notificationLevel).toBe('silent')
  })

  it('passes an unparsable value to the core, which warns about it by channel name and keeps the default', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { MASKPOINT_COMPACT_BUDGET_TOKENS: 'lots' } }, warn)
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual(['invalid environment value for "compactBudgetTokens" ("lots"); ignoring it'])
  })

  it('warns about a zero or negative budget rather than accepting it, since only a positive integer is a budget', () => {
    const { warned, warn } = collecting()
    expect(loadConfig({ env: { MASKPOINT_COMPACT_BUDGET_TOKENS: '0' } }, warn).compactBudgetTokens).toBe(24_000)
    expect(loadConfig({ env: { MASKPOINT_COMPACT_BUDGET_TOKENS: '-5' } }, warn).compactBudgetTokens).toBe(24_000)
    expect(warned).toHaveLength(2)
  })

  it('keeps the flag that wins when a losing flag is invalid', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { MASKPOINT_COMPACT_BUDGET_TOKENS: '9000' }, flags: { compactBudgetTokens: '9000.5' } }, warn)
    expect(config.compactBudgetTokens).toBe(9_000)
    expect(warned).toEqual(['invalid flag value for "compactBudgetTokens" ("9000.5"); ignoring it'])
  })

  it('maps the deprecated budget variable onto the field, warns, and lets the modern name win', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '30000' } }, warn)
    expect(config.compactBudgetTokens).toBe(30_000)
    expect(warned).toEqual(['MASKPOINT_CHECKPOINT_TRIGGER_TOKENS is deprecated; use MASKPOINT_COMPACT_BUDGET_TOKENS'])

    const both = loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '30000', MASKPOINT_COMPACT_BUDGET_TOKENS: '40000' } }, warn)
    expect(both.compactBudgetTokens).toBe(40_000)
  })

  it('derives the budget from the model window when no channel set it, and an explicit channel wins over the window', () => {
    const { warn } = collecting()
    expect(loadConfig({ contextWindow: 200_000 }, warn).compactBudgetTokens).toBe(50_000)
    expect(loadConfig({ contextWindow: 1_000_000 }, warn).compactBudgetTokens).toBe(96_000) // the ceiling binds
    expect(loadConfig({ contextWindow: 64_000 }, warn).compactBudgetTokens).toBe(24_000) // the floor binds
    expect(loadConfig({ env: { MASKPOINT_COMPACT_BUDGET_TOKENS: '9000' }, contextWindow: 200_000 }, warn).compactBudgetTokens).toBe(9_000)
    expect(loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '8000' }, contextWindow: 200_000 }, warn).compactBudgetTokens).toBe(8_000)
  })

  it('says nothing about a flag that was not passed, and nothing about an absent environment', () => {
    const { warned, warn } = collecting()
    const read = readFlags(() => undefined)
    expect(read.deprecations).toEqual([])
    const config = loadConfig({ flags: read.values, env: undefined }, warn)
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual([])
  })

  it('ignores the environment variables of other tools, and names an unknown key when a host passes one', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { PATH: '/usr/bin', MASKPOINT_TYPO: '1' }, host: { typo: 1 } }, warn)
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual(['unknown host configuration key "typo" ignored'])
  })
})

describe('flagSpecs', () => {
  it('names one flag per setting, each with a description an operator can act on, plus the deprecated renames', () => {
    const specs = flagSpecs()
    expect(specs.map((spec) => spec.name).sort()).toEqual([
      'maskpoint-checkpoint-enabled',
      'maskpoint-checkpoint-model',
      'maskpoint-checkpoint-trigger-tokens',
      'maskpoint-compact-budget-tokens',
      'maskpoint-enabled',
      'maskpoint-mask-reasoning',
      'maskpoint-notification-level',
    ])
    for (const spec of specs) expect(spec.description.length).toBeGreaterThan(20)
  })

  it('gives every setting one environment variable and one flag name, with no name shared', () => {
    const names = Object.values(CHANNELS).flatMap((channel) => [channel.env, channel.flag])
    expect(new Set(names).size, 'every channel name is used once').toBe(names.length)
    for (const channel of Object.values(CHANNELS)) {
      expect(channel.env).toMatch(/^MASKPOINT_[A-Z_]+$/)
      expect(channel.flag).toMatch(/^maskpoint-[a-z-]+$/)
    }
    // Coverage of the fields themselves is the `Record<keyof EngineConfig, Channels>` type's job:
    // a new setting cannot compile until it names both of its channels here.
  })
})

describe('readFlags', () => {
  it('reads each setting through the name its spec registered, and reports the unset ones as unset', () => {
    const asked: string[] = []
    const { values, deprecations } = readFlags((name) => {
      asked.push(name)
      return name === 'maskpoint-notification-level' ? 'silent' : undefined
    })
    expect([...asked].sort()).toEqual(flagSpecs().map((spec) => spec.name).sort())
    expect(values).toEqual({
      enabled: undefined,
      compactBudgetTokens: undefined,
      checkpointModel: undefined,
      notificationLevel: 'silent',
    })
    expect(deprecations).toEqual([])
  })

  it('maps a deprecated budget flag onto the field it renamed, and says so; the modern name wins', () => {
    const modern = readFlags((name) => (name === 'maskpoint-compact-budget-tokens' ? '30000' : undefined))
    expect(modern.values.compactBudgetTokens).toBe('30000')
    expect(modern.deprecations).toEqual([])

    const legacy = readFlags((name) => (name === 'maskpoint-checkpoint-trigger-tokens' ? '30000' : undefined))
    expect(legacy.values.compactBudgetTokens).toBe('30000')
    expect(legacy.deprecations).toEqual(['--maskpoint-checkpoint-trigger-tokens is deprecated; use --maskpoint-compact-budget-tokens'])

    const both = readFlags((name) => (name === 'maskpoint-compact-budget-tokens' || name === 'maskpoint-checkpoint-trigger-tokens' ? '30000' : undefined))
    expect(both.deprecations).toEqual([])
  })
})
