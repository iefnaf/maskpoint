import { describe, expect, it } from 'vitest'
import { budgetOf, DEFAULT_ENGINE_CONFIG, maskOptionsOf, resolveEngineConfig, resolveEngineConfigLayer, resolveEngineConfigLayers } from '../src/index.js'

describe('resolveEngineConfig', () => {
  it('resolves the documented defaults when nothing is configured', () => {
    const { config, warnings } = resolveEngineConfig({ projectTrusted: false })
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warnings).toEqual([])
  })

  it('applies a valid global layer over the defaults', () => {
    const { config, warnings } = resolveEngineConfig({
      global: { enabled: false, checkpointTriggerTokens: 8_000, checkpointModel: 'gpt-5', maskReasoning: true, notificationLevel: 'verbose' },
      projectTrusted: false,
    })
    expect(config).toEqual({ enabled: false, checkpointTriggerTokens: 8_000, checkpointModel: 'gpt-5', maskReasoning: true, notificationLevel: 'verbose' })
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
    ['maskReasoning', 'yes'],
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

describe('resolveEngineConfigLayers', () => {
  it('lets each layer win over the ones before it, field by field', () => {
    const config = resolveEngineConfigLayers(
      [
        { source: 'host', raw: { enabled: false, checkpointTriggerTokens: 8_000, notificationLevel: 'verbose' } },
        { source: 'environment', raw: { checkpointTriggerTokens: 20_000 } },
        { source: 'flag', raw: { notificationLevel: 'silent' } },
      ],
      () => {
        throw new Error('should not warn')
      },
    )
    expect(config).toEqual({ enabled: false, checkpointTriggerTokens: 20_000, maskReasoning: false, notificationLevel: 'silent' })
  })

  it('names the layer in every warning, so the operator knows which surface to fix', () => {
    const warned: string[] = []
    const config = resolveEngineConfigLayers(
      [
        { source: 'host', raw: { unknownKey: 1 } },
        { source: 'environment', raw: { checkpointTriggerTokens: 'lots' } },
        { source: 'flag', raw: 'not an object' },
      ],
      (message) => warned.push(message),
    )
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
    expect(warned).toEqual([
      'unknown host configuration key "unknownKey" ignored',
      'invalid environment value for "checkpointTriggerTokens" ("lots"); ignoring it',
      'flag configuration must be an object; ignoring it',
    ])
  })

  it('leaves an earlier valid value in place when a later layer is invalid', () => {
    const warned: string[] = []
    const config = resolveEngineConfigLayers(
      [
        { source: 'environment', raw: { checkpointTriggerTokens: 20_000 } },
        { source: 'flag', raw: { checkpointTriggerTokens: 0 } },
      ],
      (message) => warned.push(message),
    )
    expect(config.checkpointTriggerTokens).toBe(20_000)
    expect(warned).toEqual(['invalid flag value for "checkpointTriggerTokens" (0); ignoring it'])
  })

  it('warns about nothing when every layer is absent, which is a host that supplies no settings', () => {
    const config = resolveEngineConfigLayers(
      [
        { source: 'host', raw: undefined },
        { source: 'environment', raw: undefined },
        { source: 'flag', raw: undefined },
      ],
      () => {
        throw new Error('should not warn')
      },
    )
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG)
  })
})

describe('budgetOf / maskOptionsOf', () => {
  it('reads the one field each helper owns, and nothing else', () => {
    expect(budgetOf({ checkpointTriggerTokens: 20_000 })).toEqual({ checkpointTriggerTokens: 20_000 })
    expect(maskOptionsOf({ maskReasoning: true })).toEqual({ maskReasoning: true })
    expect(maskOptionsOf({ maskReasoning: false })).toEqual({ maskReasoning: false })
  })
})
