import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')

/** The packages a release publishes, in the order the root `release` script publishes them. */
const PUBLISHED = ['core', 'pi', 'dsh', 'claude-code', 'codex'] as const

const manifestOf = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))

describe('release invariants', () => {
  const manifests = new Map(PUBLISHED.map((name) => [name, manifestOf(name)]))
  const rootJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const version = manifests.get('core')!.version

  it('publishes every package at one version, so a release is one number', () => {
    // The adapters depend on @maskpoint/core by caret, and a 0.x caret pins the minor: publishing
    // core alone means the adapters' declared range no longer matches what they were tested against.
    for (const [name, manifest] of manifests) expect(manifest.version, name).toBe(version)
  })

  it('gives every published package the same license and the license text', () => {
    // MIT requires the notice to travel with every copy, and npm links LICENSE from the repository
    // root without shipping it — so each package carries its own copy, byte-identical to the root's,
    // and this assertion is what keeps the copies honest.
    const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8')
    for (const [name, manifest] of manifests) {
      expect(manifest.license, name).toBe('MIT')
      expect(readFileSync(join(root, 'packages', name, 'LICENSE'), 'utf8'), name).toBe(rootLicense)
    }
  })

  it('marks every published package public, so a first scoped publish is not restricted', () => {
    // Scoped packages default to restricted access on first publish: a release that quietly only
    // reaches the publisher is worse than one that fails.
    for (const [name, manifest] of manifests) {
      expect((manifest.publishConfig as { access?: string } | undefined)?.access, name).toBe('public')
    }
  })

  it('publishes @maskpoint/core before the adapters that depend on it', () => {
    const publishOrder = [...rootJson.scripts.release!.matchAll(/npm publish -w (@maskpoint\/[a-z-]+)/g)].map((m) => m[1]!)
    expect(publishOrder[0]).toBe('@maskpoint/core')
    expect(publishOrder).toHaveLength(PUBLISHED.length)
  })

  it('builds what each published package ships, from a clean checkout', () => {
    for (const name of ['dsh', 'claude-code', 'codex'] as const) {
      // These three ship `dist` and have no source in the tarball, so prepack must build — core
      // first, since their build resolves @maskpoint/core through ../core/dist.
      expect(manifests.get(name)!.scripts as Record<string, string>, name).toMatchObject({
        prepack: expect.stringContaining('../core/tsconfig.build.json'),
      })
    }
    // Pi ships TypeScript source that the host loads itself, so it must NOT need a build step.
    expect(manifests.get('pi')!.scripts).toBeUndefined()
    expect(manifests.get('pi')!.pi).toEqual({ extensions: ['./src/extension.ts'] })
  })
})
