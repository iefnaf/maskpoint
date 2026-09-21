import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { loadCorpus } from '../src/corpus.js'

function run(...argv: string[]) {
  let out = ''
  let err = ''
  const code = main(argv, { out: (text) => (out += text), err: (text) => (err += text) })
  return { code, out, err }
}

describe('cli replay', () => {
  it('prints masked history and statistics for a named fixture', () => {
    const { code, out } = run('replay', 'shell-execution')
    expect(code).toBe(0)
    expect(out).toContain('fixture: shell-execution')
    expect(out).toContain('== masked history')
    expect(out).toContain('== statistics ==')
  })

  it('replays with the real masking engine: bodies are out and the report does not call itself a pass-through', () => {
    const { out } = run('replay', 'shell-execution')
    expect(out).toContain('engine: maskpoint masking')
    expect(out).not.toMatch(/pass-through|does not mask/i)
    expect(out).toContain('[tool result omitted:')
    expect(out).not.toMatch(/observationsMasked: 0\b/)
  })

  it('rejects an unknown fixture and lists the ones that exist', () => {
    const { code, out, err } = run('replay', 'no-such-fixture')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('no-such-fixture')
    for (const fixture of loadCorpus()) expect(err).toContain(fixture.name)
  })

  it('explains usage when no fixture is named', () => {
    const { code, err } = run('replay')
    expect(code).toBe(2)
    expect(err).toMatch(/usage/i)
  })
})

describe('cli list', () => {
  it('names every fixture in the manifest with its description', () => {
    const { code, out } = run('list')
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

  it('passes on the checked-in corpus', () => {
    const { code, out } = run('check')
    expect(code).toBe(0)
    expect(out).toMatch(/\d+ fixtures/)
  })

  it('fails on a dirty fixture, naming file, line and rule but not the secret', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const dirty = join(dir, 'dirty.json')
    writeFileSync(dirty, `{\n  "text": "${secret}"\n}\n`)
    const { code, out, err } = run('check', dir)
    expect(code).toBe(1)
    expect(err).toContain(`${dirty}:2`)
    expect(err).toContain('github-token')
    expect(out + err).not.toContain(secret)
  })

  it('passes a clean directory given explicitly', () => {
    writeFileSync(join(dir, 'clean.json'), '{"text":"fine"}')
    expect(run('check', dir).code).toBe(0)
  })
})

describe('cli', () => {
  it('prints usage and fails on an unknown command', () => {
    const { code, err } = run('frobnicate')
    expect(code).toBe(2)
    expect(err).toMatch(/usage/i)
  })
})
