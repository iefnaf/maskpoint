import { describe, expect, it } from 'vitest'
import { loadCorpus } from '../src/corpus.js'
import { checkpointSafetyOverCorpus, contextDecreaseViolations, usageOverCorpus } from '../src/qualitybars.js'

const corpus = loadCorpus()

describe('usageOverCorpus', () => {
  it('accounts for every fixture as masked, checkpoint, or a named decline reason', async () => {
    const report = await usageOverCorpus(corpus)
    expect(report.fixtures).toBe(corpus.length)
    expect(report.maskedHistory + report.checkpoint + report.decline).toBe(corpus.length)
    const declineTotal = Object.values(report.declineReasons).reduce((sum, n) => sum + (n ?? 0), 0)
    expect(declineTotal).toBe(report.decline)
  })

  it('reports the cjk fixture as a checkpoint (it carries customInstructions)', async () => {
    const report = await usageOverCorpus(corpus)
    // docs/design.md, parity harness exclusions: the cjk fixture carries customInstructions, which
    // requests a checkpoint regardless of budget -- so it is not part of the zero-LLM count.
    expect(report.checkpoint).toBeGreaterThanOrEqual(1)
  })
})

describe('contextDecreaseViolations', () => {
  it('is empty but for one named, understood exception: a pure-image observation', async () => {
    // packages/core/src/mask.ts always drops an image payload "whatever its text costs" -- its own
    // comment: "the estimator only sees text". A tool result that is nothing but an image (no text
    // at all) therefore goes from 0 estimated tokens before masking (the estimator never counted
    // the image) to the few tokens of its placeholder's descriptive text after -- a nominal
    // increase in this text-only estimator's units, not a real one: the image itself, which the
    // estimator never priced, is still gone. `image-observations` is the corpus's only fixture with
    // such an item. A new name appearing here is real evidence, not an expected exception.
    expect(await contextDecreaseViolations(corpus)).toEqual(['image-observations'])
  })
})

describe('checkpointSafetyOverCorpus', () => {
  it('never persists a truncated or empty checkpoint across any fixture x rejection-shape combination', async () => {
    const report = await checkpointSafetyOverCorpus(corpus)
    expect(report.truncatedOrEmptyPersisted).toBe(0)
    expect(report.attempts).toBeGreaterThan(0)
    expect(report.accepted + Object.values(report.rejections).reduce((sum, n) => sum + (n ?? 0), 0)).toBe(report.attempts)
  })

  it('classifies every rejection shape it is given', async () => {
    const report = await checkpointSafetyOverCorpus(corpus)
    for (const reason of ['provider-error', 'aborted', 'truncated', 'empty', 'tool-call'] as const) {
      expect(report.rejections[reason] ?? 0).toBeGreaterThan(0)
    }
  })
})
