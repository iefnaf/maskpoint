import { describe, expect, it } from 'vitest'
import { DEFAULT_BUDGET } from '../src/index.js'

describe('DEFAULT_BUDGET', () => {
  it("is the design's initial budget of 12,000 estimated tokens", () => {
    expect(DEFAULT_BUDGET).toEqual({ checkpointTriggerTokens: 12_000 })
  })
})
