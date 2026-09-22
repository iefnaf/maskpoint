import { describe, expect, it } from 'vitest'
import { loadCorpus } from '../src/corpus.js'
import { runDsh, runPi } from './support/host-runs.js'

/**
 * Cross-platform parity (issue #12, docs/design.md "Testing design" and "Quality bars"): one
 * corpus, replayed through the two adapters that reach the native-replacement tier (Pi and DSH —
 * Claude Code and Codex are assisted augmentation and produce no comparable masked-history
 * replacement; docs/design.md, "Non-goals"). Every fixture is compared unless it is named below,
 * with a reason: "never a silent skip" means a new fixture defaults to being compared, not excused.
 */
const EXCLUDED: Record<string, string> = {
  cjk: [
    'Carries customInstructions. Pi attempts its issue-#7 checkpoint call, but this harness',
    'configures no model (fakePiContext — the same zero-LLM path every other fixture takes), so the',
    "call rejects and falls back to masked history; that fallback does not satisfy Pi's own",
    "strict-shrink guard for this fixture, so Pi declines no-size-reduction. DSH's",
    'SummarizationInput still carries no customInstructions field at all (its own checkpoint path,',
    'issue #11, has no way to see them), so it masks normally instead of declining. The two',
    'adapters still take genuinely different paths for this input, just not for the reason this',
    'comment used to give before #7 landed; pinned directly below instead of run through the',
    'generic comparison.',
  ].join(' '),
  'parallel-tool-calls': [
    "Pi's own adapter enforces \"the result must strictly shrink\" itself, measured by",
    "Maskpoint's own estimator (packages/pi/src/compact.ts, `tokensReplaced`); for this fixture's",
    'small observations, the framing overhead outweighs the savings and Pi declines',
    "no-size-reduction. DSH's engine.ts carries no such check of its own: it relies on the host's",
    'compaction transaction, which runs the equivalent check after `summarize()` returns',
    "(dsh-compaction-basic's `summarizeCompaction`) using the host's own token meter, not",
    "Maskpoint's estimator. This harness calls `summarize()` directly (see host-runs.ts) and so",
    "never exercises that transaction, and the two estimators' thresholds are not close enough",
    'here to say what the real host would decide without reproducing its meter exactly. Pinned',
    'directly below as a known gap, not silently skipped: DSH masking content this small is not',
    'proof that a real DSH host would land it.',
  ].join(' '),
}

const CORPUS = loadCorpus()

function findFixture(name: string) {
  const fixture = CORPUS.find((each) => each.name === name)
  if (fixture === undefined) throw new Error(`parity: excluded fixture "${name}" is not (or no longer) in the corpus`)
  return fixture
}

describe('cross-platform parity: the shared corpus through the Pi and DSH adapters', () => {
  it('accounts for every fixture: run through both adapters, or named above with a reason', () => {
    for (const name of Object.keys(EXCLUDED)) findFixture(name)
  })

  for (const fixture of CORPUS) {
    if (fixture.name in EXCLUDED) continue

    it(`${fixture.name}: same outcome, statistics, and masked-history text on both adapters`, async () => {
      const pi = await runPi(fixture.snapshot)
      const dsh = await runDsh(fixture.snapshot)

      expect(dsh.outcome, `dsh outcome for "${fixture.name}"`).toBe(pi.outcome)
      if (pi.outcome === 'decline') {
        expect(dsh.reason, `dsh decline reason for "${fixture.name}"`).toBe(pi.reason)
        return
      }
      expect(dsh.stats, `dsh statistics for "${fixture.name}"`).toEqual(pi.stats)
      expect(dsh.text, `dsh masked history for "${fixture.name}"`).toBe(pi.text)
    })
  }
})

describe('documented divergence: custom instructions', () => {
  const fixture = findFixture('cjk')

  it("Pi declines: its checkpoint call has no model configured, and the masked-history fallback does not shrink", async () => {
    expect(await runPi(fixture.snapshot)).toEqual({ host: 'pi', outcome: 'decline', reason: 'no-size-reduction' })
  })

  it("DSH masks normally: its explicit compaction input carries no customInstructions field yet", async () => {
    const dsh = await runDsh(fixture.snapshot)
    expect(dsh.outcome).toBe('masked-history')
  })
})

describe('documented gap: no-size-reduction thresholds are estimator-specific', () => {
  const fixture = findFixture('parallel-tool-calls')

  it("Pi declines: its own estimator says the framed result would not shrink the context", async () => {
    expect(await runPi(fixture.snapshot)).toEqual({ host: 'pi', outcome: 'decline', reason: 'no-size-reduction' })
  })

  it('DSH masks: engine.ts asserts no shrink guard of its own for the explicit path', async () => {
    const dsh = await runDsh(fixture.snapshot)
    expect(dsh.outcome).toBe('masked-history')
  })
})
