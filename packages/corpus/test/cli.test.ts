import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { loadCorpus } from '../src/corpus.js'

async function run(...argv: string[]) {
  let out = ''
  let err = ''
  const code = await main(argv, { out: (text) => (out += text), err: (text) => (err += text) })
  return { code, out, err }
}

describe('cli replay', () => {
  it('prints masked history and statistics for a named fixture', async () => {
    const { code, out } = await run('replay', 'shell-execution')
    expect(code).toBe(0)
    expect(out).toContain('fixture: shell-execution')
    expect(out).toContain('== masked history')
    expect(out).toContain('== statistics ==')
  })

  it('replays with the real masking engine: bodies are out and the report does not call itself a pass-through', async () => {
    const { out } = await run('replay', 'shell-execution')
    expect(out).toContain('engine: maskpoint masking')
    expect(out).not.toMatch(/pass-through|does not mask/i)
    expect(out).toContain('[tool result omitted:')
    expect(out).not.toMatch(/observationsMasked: 0\b/)
  })

  it('rejects an unknown fixture and lists the ones that exist', async () => {
    const { code, out, err } = await run('replay', 'no-such-fixture')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('no-such-fixture')
    for (const fixture of loadCorpus()) expect(err).toContain(fixture.name)
  })

  it('explains usage when no fixture is named', async () => {
    const { code, err } = await run('replay')
    expect(code).toBe(2)
    expect(err).toMatch(/usage/i)
  })
})

describe('cli list', () => {
  it('names every fixture in the manifest with its description', async () => {
    const { code, out } = await run('list')
    expect(code).toBe(0)
    for (const fixture of loadCorpus()) {
      expect(out).toContain(fixture.name)
      expect(out).toContain(fixture.description)
    }
  })
})

describe('cli check', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maskpoint-cli-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes on the checked-in corpus', async () => {
    const { code, out } = await run('check')
    expect(code).toBe(0)
    expect(out).toMatch(/\d+ fixtures/)
  })

  it('fails on a dirty fixture, naming file, line and rule but not the secret', async () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const dirty = join(dir, 'dirty.json')
    writeFileSync(dirty, `{\n  "text": "${secret}"\n}\n`)
    const { code, out, err } = await run('check', dir)
    expect(code).toBe(1)
    expect(err).toContain(`${dirty}:2`)
    expect(err).toContain('github-token')
    expect(out + err).not.toContain(secret)
  })

  it('passes a clean directory given explicitly', async () => {
    writeFileSync(join(dir, 'clean.json'), '{"text":"fine"}')
    expect((await run('check', dir)).code).toBe(0)
  })
})

describe('cli', () => {
  it('prints usage and fails on an unknown command', async () => {
    const { code, err } = await run('frobnicate')
    expect(code).toBe(2)
    expect(err).toMatch(/usage/i)
  })
})

describe('cli calibration', () => {
  it('reports the estimator and DSH host meter for every comparable fixture, including cjk and code-heavy', async () => {
    const { code, out } = await run('calibration')
    expect(code).toBe(0)
    expect(out).toContain('cjk')
    expect(out).toContain('code-heavy')
    expect(out).toMatch(/estimator ~\d+ tokens, DSH host meter ~\d+ tokens/)
  })
})

describe('cli quality-bars', () => {
  it('reports the zero-LLM ratio, usable-result rate, context-decrease and checkpoint safety', async () => {
    const { code, out } = await run('quality-bars')
    expect(code).toBe(0)
    expect(out).toContain('zero-LLM ratio:')
    expect(out).toContain('usable-result rate:')
    expect(out).toContain('context-decrease violations:')
    expect(out).toContain('checkpoint safety:')
    expect(out).toMatch(/0 truncated\/empty persisted/)
  })
})
