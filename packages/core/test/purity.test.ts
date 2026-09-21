import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const coreDir = join(import.meta.dirname, '..')
const srcDir = join(coreDir, 'src')

function sourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** Every module specifier a file imports or re-exports, including dynamic imports and require. */
function specifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!)
  }
  return found
}

describe('core package purity', () => {
  it('has source to inspect', () => {
    expect(sourceFiles().length).toBeGreaterThan(0)
  })

  it('imports nothing but its own modules: no host SDK, no node builtins, no packages', () => {
    for (const file of sourceFiles()) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\//)
      }
    }
  })

  it('declares no runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[field] ?? {}), field).toEqual([])
    }
  })

  it('does not reach for ambient I/O globals', () => {
    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/\b(process|fetch|XMLHttpRequest|WebSocket|localStorage)\b/)
    }
  })
})
