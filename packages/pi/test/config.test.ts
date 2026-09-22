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
          MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '20000',
          MASKPOINT_CHECKPOINT_MODEL: 'glm-4.6',
          MASKPOINT_MASK_REASONING: 'true',
          MASKPOINT_NOTIFICATION_LEVEL: 'verbose',
        },
      },
      warn,
    )
    expect(config).toEqual({
      enabled: false,
      checkpointTriggerTokens: 20_000,
      checkpointModel: 'glm-4.6',
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
          checkpointTriggerTokens: '9000',
          checkpointModel: 'glm-4.6',
          maskReasoning: true,
          notificationLevel: 'silent',
        },
      },
      warn,
    )
    expect(config).toEqual({
      enabled: true,
      checkpointTriggerTokens: 9_000,
      checkpointModel: 'glm-4.6',
      maskReasoning: true,
      notificationLevel: 'silent',
    })
    expect(warned).toEqual([])
  })

  it('accepts the two spellings of a boolean an operator is likely to type', () => {
    const { warn } = collecting()
    expect(loadConfig({ env: { MASKPOINT_ENABLED: 'true' } }, warn).enabled).toBe(true)
    expect(loadConfig({ env: { MASKPOINT_ENABLED: '0' } }, warn).enabled).toBe(false)
  })

  it('applies host, environment and flag in escalating order', () => {
    const { warn } = collecting()
    const config = loadConfig(
      {
        host: { checkpointTriggerTokens: 5_000, notificationLevel: 'verbose' },
        env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '20_000' },
        flags: { checkpointTriggerTokens: '9000', notificationLevel: 'silent' },
      },
      warn,
    )
    expect(config.checkpointTriggerTokens).toBe(9_000)
    expect(config.notificationLevel).toBe('silent')
  })

  it('passes an unparsable value to the core, which warns about it by channel name and keeps the default', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: 'lots' } }, warn)
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual(['invalid environment value for "checkpointTriggerTokens" ("lots"); ignoring it'])
  })

  it('warns about a zero or negative budget rather than accepting it, since only a positive integer is a budget', () => {
    const { warned, warn } = collecting()
    expect(loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '0' } }, warn).checkpointTriggerTokens).toBe(12_000)
    expect(loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '-5' } }, warn).checkpointTriggerTokens).toBe(12_000)
    expect(warned).toHaveLength(2)
  })

  it('keeps the flag that wins when a losing flag is invalid', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ env: { MASKPOINT_CHECKPOINT_TRIGGER_TOKENS: '9000' }, flags: { checkpointTriggerTokens: '9000.5' } }, warn)
    expect(config.checkpointTriggerTokens).toBe(9_000)
    expect(warned).toEqual(['invalid flag value for "checkpointTriggerTokens" ("9000.5"); ignoring it'])
  })

  it('says nothing about a flag that was not passed, and nothing about an absent environment', () => {
    const { warned, warn } = collecting()
    const config = loadConfig({ flags: readFlags(() => undefined), env: undefined }, warn)
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
  it('names one flag per setting, each with a description an operator can act on', () => {
    const specs = flagSpecs()
    expect(specs.map((spec) => spec.name).sort()).toEqual([
      'maskpoint-checkpoint-model',
      'maskpoint-checkpoint-trigger-tokens',
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
    const values = readFlags((name) => {
      asked.push(name)
      return name === 'maskpoint-notification-level' ? 'silent' : undefined
    })
    expect(asked).toEqual(flagSpecs().map((spec) => spec.name))
    expect(values).toEqual({
      enabled: undefined,
      checkpointTriggerTokens: undefined,
      checkpointModel: undefined,
      notificationLevel: 'silent',
    })
  })
})
