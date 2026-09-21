import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkSanitized, scanText } from '../src/sanitize.js'

// Credential-shaped samples are assembled at runtime so this file itself never contains
// a literal that secret scanners (ours or GitHub's) would flag.
const dirty = {
  awsAccessKey: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  githubToken: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  slackToken: 'xoxb-' + '123456789012-abcdefABCDEF1234',
  apiKey: 'sk-' + 'proj-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  privateKey: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  bearer: 'Authorization: Bearer ' + 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4',
  assignment: 'DATABASE_PASSWORD="' + 'hunter2hunter2xyz"',
}

function rules(text: string): string[] {
  return scanText(text).map((finding) => finding.rule)
}

describe('scanText', () => {
  it('passes neutral fixture content', () => {
    const clean = [
      'Read /workspace/app/src/index.ts',
      'npm test exited with code 1',
      'const total = items.reduce((sum, item) => sum + item.price, 0)',
      'sha256 of the build is e3b0c44298fc1c149afbf4c8996fb924',
      'the password prompt was skipped; see /home/user/.config/tool',
      '用户要求把 /workspace/app 里的配置文件迁移到新的目录',
    ].join('\n')
    expect(scanText(clean)).toEqual([])
  })

  it.each([
    ['an AWS access key id', dirty.awsAccessKey, 'aws-access-key'],
    ['a GitHub token', dirty.githubToken, 'github-token'],
    ['a Slack token', dirty.slackToken, 'slack-token'],
    ['an API key', dirty.apiKey, 'api-key'],
    ['a JWT', dirty.jwt, 'jwt'],
    ['a private key block', dirty.privateKey, 'private-key'],
    ['a bearer credential', dirty.bearer, 'bearer-token'],
    ['a secret assignment', dirty.assignment, 'secret-assignment'],
  ])('flags %s', (_label, sample, rule) => {
    expect(rules(`before\n${sample}\nafter`)).toContain(rule)
  })

  it.each([
    ['a quoted letters-only password', '{"password": "' + 'correcthorsebattery"}'],
    ['a compact key=value secret without digits', 'curl --data password=' + 'correcthorsebattery'],
    ['credentials embedded in a URL', 'postgres://admin:' + 's3cretpw@db.internal:5432/app'],
  ])('flags %s', (_label, sample) => {
    expect(scanText(sample).length).toBeGreaterThan(0)
  })

  it('does not mistake ordinary code or URLs for secrets', () => {
    const benign = [
      'const tokenizer = createTokenizer',
      'tokens: Array<string> = []',
      'const password: string = readPasswordFromPrompt()',
      'postgres://localhost:5432/app',
      'https://registry.example.test/dep-1/-/dep-1-2.1.0.tgz',
      'the secret to good tests is small seams',
    ].join('\n')
    expect(scanText(benign)).toEqual([])
  })

  it.each([
    ['a macOS home directory', '/Users/' + 'alice/projects/app/src/main.ts'],
    ['a Linux home directory', 'cd /home/' + 'bob/work && ls'],
    ['a Windows home directory', 'C:\\Users\\' + 'carol\\repo'],
    ['a JSON-escaped Windows home directory', '"C:\\\\Users\\\\' + 'carol\\\\repo"'],
  ])('flags %s as a real path', (_label, sample) => {
    expect(rules(sample)).toContain('real-path')
  })

  it('accepts the neutral placeholder user in home paths', () => {
    expect(scanText('/Users/user/app and /home/user/app and C:\\Users\\user\\app')).toEqual([])
  })

  it('reports rule and 1-based line, and never echoes the matched secret', () => {
    const findings = scanText(`line one\nline two\n${dirty.githubToken}\n`)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'github-token', line: 3 })
    expect(JSON.stringify(findings)).not.toContain(dirty.githubToken)
  })
})

describe('checkSanitized', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maskpoint-sanitize-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns no findings for clean files', () => {
    const clean = join(dir, 'clean.json')
    writeFileSync(clean, JSON.stringify({ text: 'Read /workspace/app/src/index.ts' }))
    expect(checkSanitized([clean])).toEqual([])
  })

  it('fails a deliberately dirty fixture, naming the file', () => {
    const fixture = join(dir, 'dirty.json')
    writeFileSync(
      fixture,
      JSON.stringify({ text: `export ${dirty.awsAccessKey}`, args: '/Users/' + 'alice/app' }, null, 2),
    )
    const findings = checkSanitized([fixture])
    expect(findings.map((finding) => finding.rule).sort()).toEqual(['aws-access-key', 'real-path'])
    expect(findings.every((finding) => finding.file === fixture)).toBe(true)
  })

  it('expands directories and reports findings in nested files', () => {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'deep.json'), `{"text": "${dirty.githubToken}"}`)
    writeFileSync(join(dir, 'ok.json'), '{"text": "fine"}')
    const findings = checkSanitized([dir])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'github-token', file: join(dir, 'nested', 'deep.json') })
  })
})
