import { describe, expect, it } from 'vitest'
import { DEFAULT_ENGINE_CONFIG, resolveEngineConfig, resolveEngineConfigLayer } from '../src/index.js'

describe('resolveEngineConfig', () => {
  it('resolves the documented defaults when nothing is configured', () => {
    const { config, warnings } = resolveEngineConfig({ projectTrusted: false })
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual([])
  })

  it('applies a valid global layer over the defaults', () => {
    const { config, warnings } = resolveEngineConfig({
      global: { enabled: false, checkpointTriggerTokens: 8_000, checkpointModel: 'gpt-5', notificationLevel: 'verbose' },
      projectTrusted: false,
    })
    expect(config).toEqual({ enabled: false, checkpointTriggerTokens: 8_000, checkpointModel: 'gpt-5', notificationLevel: 'verbose' })
    expect(warnings).toEqual([])
  })

  it.each([
    ['enabled', 'yes'],
    ['checkpointTriggerTokens', 0],
    ['checkpointTriggerTokens', -1],
    ['checkpointTriggerTokens', 12.5],
    ['checkpointTriggerTokens', 'a lot'],
    ['checkpointModel', ''],
    ['checkpointModel', '   '],
    ['checkpointModel', 42],
    ['notificationLevel', 'loud'],
  ])('falls back to the default and warns when global "%s" is %j', (field, value) => {
    const { config, warnings } = resolveEngineConfig({ global: { [field]: value }, projectTrusted: false })
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.field).toBe(field)
    expect(warnings[0]?.message).toMatch(/invalid global value/)
  })

  it('warns and ignores a non-object global layer', () => {
    const { config, warnings } = resolveEngineConfig({ global: 'not an object', projectTrusted: false })
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual([{ field: 'global', message: 'global configuration must be an object; ignoring it' }])
  })

  it('warns on an unknown key without disturbing the known ones', () => {
    const { config, warnings } = resolveEngineConfig({ global: { enabled: false, mode: 'turbo' }, projectTrusted: false })
    expect(config.enabled).toBe(false)
    expect(warnings).toEqual([{ field: 'mode', message: 'unknown global configuration key "mode" ignored' }])
  })

  it('ignores project configuration entirely when the project is not trusted, with one warning', () => {
    const { config, warnings } = resolveEngineConfig({
      global: { checkpointTriggerTokens: 9_000 },
      project: { checkpointTriggerTokens: 1, checkpointModel: 'attacker-model' },
      projectTrusted: false,
    })
    expect(config).toEqual({ ...DEFAULT_ENGINE_CONFIG, checkpointTriggerTokens: 9_000 })
    expect(warnings).toEqual([{ field: 'project', message: 'project configuration ignored: this project is not trusted' }])
  })

  it('applies project configuration over global when the project is trusted', () => {
    const { config, warnings } = resolveEngineConfig({
      global: { checkpointTriggerTokens: 9_000, notificationLevel: 'verbose' },
      project: { checkpointTriggerTokens: 5_000 },
      projectTrusted: true,
    })
    expect(config).toEqual({ ...DEFAULT_ENGINE_CONFIG, checkpointTriggerTokens: 5_000, notificationLevel: 'verbose' })
    expect(warnings).toEqual([])
  })

  it('keeps the already-resolved value and warns when a trusted project field is invalid', () => {
    const { config, warnings } = resolveEngineConfig({
      global: { checkpointTriggerTokens: 9_000 },
      project: { checkpointTriggerTokens: -5 },
      projectTrusted: true,
    })
    expect(config.checkpointTriggerTokens).toBe(9_000)
    expect(warnings).toEqual([{ field: 'checkpointTriggerTokens', message: 'invalid project value for "checkpointTriggerTokens" (-5); ignoring it' }])
  })

  it('does not merge project when it is absent, trusted or not', () => {
    const trusted = resolveEngineConfig({ global: { checkpointTriggerTokens: 9_000 }, projectTrusted: true })
    expect(trusted.warnings).toEqual([])
    expect(trusted.config.checkpointTriggerTokens).toBe(9_000)
  })
})

describe('resolveEngineConfigLayer', () => {
  it('resolves a single merged layer as trusted, warning through the given callback', () => {
    const warned: string[] = []
    const config = resolveEngineConfigLayer({ checkpointTriggerTokens: 'nope', enabled: false }, (message) => warned.push(message))
    expect(config).toEqual({ ...DEFAULT_ENGINE_CONFIG, enabled: false })
    expect(warned).toEqual(['invalid global value for "checkpointTriggerTokens" ("nope"); ignoring it'])
  })

  it('resolves the defaults for an absent layer', () => {
    const config = resolveEngineConfigLayer(undefined, () => {
      throw new Error('should not warn')
    })
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
  })
})
