import { describe, expect, it } from 'vitest'
import { planCompaction } from '../src/compact.js'
import { native } from './support/scenario.js'
import {
  assistant,
  bash,
  beforeCompact,
  branchSummary,
  bulky,
  customMessage,
  image,
  text,
  toolCall,
  toolResult,
  user,
} from './support/session.js'

describe('planCompaction — what counts as an observation', () => {
  it('keeps a command the user ran as a call and masks only its output', () => {
    const entries = [
      user('u1', 'Check the build.'),
      bash('b1', 'npm test', bulky('BUILD-OUT'), 1),
      assistant('a1', [text('The build fails.')]),
      user('u2', 'Fix it.'),
      assistant('a2', [text('On it.')]),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'u2')))
    expect(effect.summary).toContain('Recorded tool call: bash')
    expect(effect.summary).toContain('npm test')
    expect(effect.summary).toMatch(/\[tool result omitted: bash, error, exit 1, \d+ lines, \d+ chars\]/)
    expect(effect.summary).not.toContain('BUILD-OUT')
  })

  it('leaves out a command the user ran but kept from the model', () => {
    const entries = [
      user('u1', 'Check the build.'),
      bash('b1', 'echo hidden-command', bulky('PRIVATE-OUT'), 0, { excludeFromContext: true }),
      assistant('a1', [text('Checking.'), toolCall('c1', 'read', { path: '/workspace/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY-A')),
      user('u2', 'Fix it.'),
      assistant('a2', [text('On it.')]),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'u2')))
    expect(effect.summary).not.toContain('hidden-command')
    expect(effect.summary).not.toContain('PRIVATE-OUT')
  })

  it('drops an image payload and says so, keeping the tool and its status', () => {
    const entries = [
      user('u1', 'Look at the page.'),
      assistant('a1', [toolCall('c1', 'screenshot', { url: 'http://localhost:3000' })]),
      toolResult('r1', 'c1', 'screenshot', [image(), image()]),
      assistant('a2', [text('The layout is broken.')]),
      user('u2', 'Fix the layout.'),
      assistant('a3', [text('On it.')]),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'u2')))
    expect(effect.summary).toContain('[tool result omitted: screenshot, ok, 2 images]')
    expect(effect.detail.stats.observationsMasked).toBe(1)
  })

  it('notes an image the user attached instead of carrying it', () => {
    const entries = [
      user('u1', [text('Why is this blank?'), image()]),
      assistant('a1', [toolCall('c1', 'read', { path: '/workspace/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY-A')),
      user('u2', 'Thanks.'),
      assistant('a2', [text('Welcome.')]),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'u2')))
    expect(effect.summary).toContain('Why is this blank?')
    expect(effect.summary).toContain('[image omitted]')
  })

  it('carries host-injected messages and branch summaries as recorded context, verbatim', () => {
    const entries = [
      customMessage('m1', 'project-rules', 'Always use tabs.'),
      branchSummary('m2', 'Earlier I tried a different approach.'),
      user('u1', 'Continue.'),
      assistant('a1', [toolCall('c1', 'read', { path: '/workspace/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY-A')),
      user('u2', 'Next.'),
      assistant('a2', [text('Ok.')]),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'u2')))
    expect(effect.summary).toContain('Recorded host context: project-rules')
    expect(effect.summary).toContain('Always use tabs.')
    expect(effect.summary).toContain('Earlier I tried a different approach.')
  })
})

describe('planCompaction — a turn split by the cut', () => {
  it('keeps the request and the early actions readable and masks their observations', () => {
    const entries = [
      user('u1', 'Refactor the whole module.'),
      assistant('a1', [toolCall('c1', 'read', { path: '/workspace/a.ts' })]),
      toolResult('r1', 'c1', 'read', bulky('BODY-A')),
      assistant('a2', [toolCall('c2', 'read', { path: '/workspace/b.ts' })]),
      toolResult('r2', 'c2', 'read', bulky('BODY-B')),
      assistant('a3', [text('Now editing.'), toolCall('c3', 'edit', { path: '/workspace/a.ts' })]),
      toolResult('r3', 'c3', 'edit', 'ok'),
    ]
    const effect = native(planCompaction(beforeCompact(entries, 'a3', { splitTurnAt: 'u1' })))
    expect(effect.boundary).toEqual({ id: 'a3' })
    expect(effect.summary).toContain('Refactor the whole module.')
    expect(effect.summary).toContain('/workspace/b.ts')
    expect(effect.summary).not.toContain('BODY-A')
    expect(effect.summary).not.toContain('BODY-B')
    expect(effect.summary).not.toContain('Now editing.')
    expect(effect.detail.stats.observationsMasked).toBe(2)
  })
})
