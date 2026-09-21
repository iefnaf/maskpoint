import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')
const srcDir = join(packageDir, 'src')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

function sourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** Every module specifier a file imports or re-exports. */
function specifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!)
  }
  return found
}

describe('the Pi package', () => {
  it('declares itself a pi package with its extension entrypoint', () => {
    expect(manifest.keywords).toContain('pi-package')
    expect(manifest.pi.extensions).toEqual(['./src/extension.ts'])
  })

  it('needs no build step: the entrypoint is TypeScript source Pi loads itself, and it ships', () => {
    for (const entry of manifest.pi.extensions as string[]) {
      expect(entry).toMatch(/\.ts$/)
      expect(existsSync(join(packageDir, entry)), entry).toBe(true)
    }
    expect(manifest.files).toContain('src')
    expect(manifest.scripts?.build).toBeUndefined()
    expect(manifest.scripts?.prepare).toBeUndefined()
  })

  it('declares every runtime dependency as a production dependency, since Pi installs without dev dependencies', () => {
    expect(manifest.dependencies).toHaveProperty('@maskpoint/core')
    expect(manifest.devDependencies?.['@maskpoint/core']).toBeUndefined()
  })

  it('imports only its own modules and the platform-free core: no Pi SDK, no other package', () => {
    for (const file of sourceFiles()) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^(\.\.?\/|@maskpoint\/core$)/)
      }
    }
  })

  it('makes no network or model call of its own', () => {
    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|modelRegistry|complete)\b/)
    }
  })
})
