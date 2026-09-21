import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import MaskpointCompactionEngine from '../src/index.js'
import { accounting, agentFor, conversation, surfaceText } from './harness.js'

const PACKAGE_NAME = '@maskpoint/dsh'
const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['@deepseek-ai/dsh-invariants', InvariantRegistry],
  ['@deepseek-ai/dsh-session/invariant', SessionInvariant],
  ['@deepseek-ai/dsh-compaction/invariant', CompactionInvariant],
  ['@deepseek-ai/dsh-commands', CommandRuntime],
  ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
  ['@deepseek-ai/dsh-command-compact', commandCompact],
  ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
  [PACKAGE_NAME, MaskpointCompactionEngine],
])

/** The host-plane rows every profile shares, as `packages/bundle/base/cordis.patch.yml` lists them. */
const HOST_ROWS = [
  "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
  "- id: session\n  name: '@deepseek-ai/dsh-session'",
  "- id: session-projection\n  name: '@deepseek-ai/dsh-session-projection'",
  "- id: token-meter\n  name: '@deepseek-ai/dsh-token-meter'",
  "- id: invariants\n  name: '@deepseek-ai/dsh-invariants'",
  "- id: session-invariant\n  name: '@deepseek-ai/dsh-session/invariant'",
  "- id: compaction-invariant\n  name: '@deepseek-ai/dsh-compaction/invariant'",
  "- id: commands\n  name: '@deepseek-ai/dsh-commands'",
]

/**
 * A preset's compaction group as the shipped presets write it: an isolated `compaction` realm
 * holding the backend, `/compact`, and the pruner. `backend` is the one row a preset copy edits.
 */
const presetCompactionGroup = (...backends: string[]): string => [
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '    toolResultPruner: true',
  '  config:',
  ...backends.flatMap((backend, index) => [`    - id: backend-${index}`, `      name: '${backend}'`]),
  '    - id: command-compact',
  "      name: '@deepseek-ai/dsh-command-compact'",
  '    - id: tool-result-pruner',
  "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
].join('\n')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the real Loader over `rows`, resolving package names from an in-memory module table. */
async function boot(rows: readonly string[], patches: readonly Record<string, unknown>[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'maskpoint-dsh-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `${rows.join('\n')}\n`)
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!MODULES.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return MODULES.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches } })
  await ctx.loader.await()
  context = ctx
  return ctx
}

describe('the backend is selectable by preset, like the host own', () => {
  it('replaces the built-in in a preset copy by swapping one row, and /compact then runs Maskpoint', async () => {
    const ctx = await boot([...HOST_ROWS, presetCompactionGroup(PACKAGE_NAME)])
    const { session } = conversation(ctx, { openTurn: false })
    const before = accounting(ctx, session)
    const agent = agentFor(session)

    const execution = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)

    if (execution === undefined) throw new Error('the composition did not resolve /compact')
    expect(execution.result).toMatchObject({ kind: 'success' })
    // The command reached Maskpoint, not the built-in: a model-free landing under its envelope.
    const summary = session.events.find((event) => event.type === 'compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('expected a compaction/summary')
    expect({ provider: summary.data.provider, model: summary.data.model }).toEqual({ provider: 'maskpoint', model: 'mask-only' })
    expect(summary.data.llmStreamCall).toBeUndefined()
    // The host's own accounting after the replacement: readers agree and the total fell.
    const after = accounting(ctx, session)
    expect(after.breakdownMessages).toBe(after.surface)
    expect(after.total).toBeLessThan(before.total)
    expect(surfaceText(session)).not.toContain('line of build output')
    // The command's report and the log agree on what was compacted.
    expect(execution.result).toMatchObject({ sourceEventSeq: summary.seq })
  })

  it('keeps one backend per context: a second backend beside the built-in is refused', async () => {
    await expect(boot([...HOST_ROWS, presetCompactionGroup('@deepseek-ai/dsh-compaction-basic', PACKAGE_NAME)]))
      .rejects.toThrow(/service "compaction" has been registered/)
  })

  it('is selected on the host plane by the bundle patch: the built-in row disabled, ours inserted', async () => {
    const patches = load(await readFile(BUNDLE_PATCH, 'utf8'))
    expect(Array.isArray(patches)).toBe(true)
    const ctx = await boot(
      [...HOST_ROWS, "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'"],
      patches as Record<string, unknown>[],
    )

    // Ours ⇒ also a built-in instance (it extends it), so only this direction discriminates.
    expect(ctx.get('compaction')).toBeInstanceOf(MaskpointCompactionEngine)
  })

  it("declares itself a bundle whose patch is the shipped file", async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string } }
    }
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })
})
