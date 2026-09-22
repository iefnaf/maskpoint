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
  'pre-masked': [
    "Simulates observations a host-side pruner already replaced. DSH has such a pruner (an",
    'optional sibling backend) and recognizes its marker text (packages/dsh/src/normalize.ts,',
    'HOST_PRUNE_MARKER); Pi has no host-side pruner and no equivalent placeholder concept, so',
    'there is no Pi side to compare this fixture against (docs/design.md, DSH adapter,',
    '"Composition with the host\'s pruner"). Idempotence itself is already covered per host: for',
    'the algorithm directly by packages/corpus/test/masking.test.ts against this fixture, and for',
    'DSH specifically by packages/dsh/test/pruner.test.ts and automatic.test.ts.',
  ].join(' '),
  cjk: [
    'Carries customInstructions. Pi declines with checkpoint-unavailable: a focus needs a model',
    "and this adapter makes none yet (issue #7). DSH's engine does not read customInstructions",
    'from the host at all yet (its own checkpoint path is issue #11), so it masks normally',
    'instead of declining for the same input. The two adapters take genuinely different paths',
    'today; pinned directly below instead of run through the generic comparison.',
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
      const pi = runPi(fixture.snapshot)
      const dsh = await runDsh(fixture.snapshot)

      expect(dsh.outcome, `dsh outcome for "${fixture.name}"`).toBe(pi.outcome)
      if (pi.outcome === 'declined') {
        expect(dsh.reason, `dsh decline reason for "${fixture.name}"`).toBe(pi.reason)
        return
      }
      expect(dsh.stats, `dsh statistics for "${fixture.name}"`).toEqual(pi.stats)
      expect(dsh.text, `dsh masked history for "${fixture.name}"`).toBe(pi.text)
    })
  }
})

describe('documented divergence: custom instructions, before issues #7 and #11 both land', () => {
  const fixture = findFixture('cjk')

  it('Pi declines: a focus needs a model, and this adapter makes none', () => {
    expect(runPi(fixture.snapshot)).toEqual({ host: 'pi', outcome: 'declined', reason: 'checkpoint-unavailable' })
  })

  it("DSH masks normally: its explicit compaction input carries no customInstructions field yet", async () => {
    const dsh = await runDsh(fixture.snapshot)
    expect(dsh.outcome).toBe('masked')
  })
})

describe('documented gap: no-size-reduction thresholds are estimator-specific', () => {
  const fixture = findFixture('parallel-tool-calls')

  it("Pi declines: its own estimator says the framed result would not shrink the context", () => {
    expect(runPi(fixture.snapshot)).toEqual({ host: 'pi', outcome: 'declined', reason: 'no-size-reduction' })
  })

  it('DSH masks: engine.ts asserts no shrink guard of its own for the explicit path', async () => {
    const dsh = await runDsh(fixture.snapshot)
    expect(dsh.outcome).toBe('masked')
  })
})
