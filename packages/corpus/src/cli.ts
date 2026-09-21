import { realpathSync } from 'node:fs'
import { corpusDir, loadCorpus } from './corpus.js'
import { maskingEngine, replay } from './replay.js'
import { checkSanitized } from './sanitize.js'

export interface Io {
  out(text: string): void
  err(text: string): void
}

const USAGE = `usage:
  cli list                    list the corpus fixtures
  cli replay <fixture>        print masked history and statistics for a fixture
  cli check [path...]         validate the corpus (default) or sanitize the given paths
`

/** Run the corpus tooling. Returns the process exit code: 0 ok, 1 failure, 2 usage error. */
export function main(argv: string[], io: Io): number {
  const [command, ...args] = argv
  try {
    switch (command) {
      case 'list':
        for (const fixture of loadCorpus()) io.out(`${fixture.name}\n  ${fixture.description}\n`)
        return 0

      case 'replay': {
        const [name] = args
        if (name === undefined) {
          io.err(USAGE)
          return 2
        }
        const corpus = loadCorpus()
        const fixture = corpus.find((each) => each.name === name)
        if (!fixture) {
          io.err(`unknown fixture "${name}"; available: ${corpus.map((each) => each.name).join(', ')}\n`)
          return 1
        }
        io.out(replay(fixture, maskingEngine))
        return 0
      }

      case 'check': {
        const explicit = args.length > 0
        const corpus = explicit ? undefined : loadCorpus()
        const findings = checkSanitized(explicit ? args : [corpusDir])
        for (const finding of findings) io.err(`${finding.file}:${finding.line} ${finding.rule}\n`)
        if (findings.length > 0) {
          io.err(`sanitization failed: ${findings.length} finding(s)\n`)
          return 1
        }
        io.out(corpus ? `corpus ok: ${corpus.length} fixtures, sanitized\n` : `sanitized: ${args.join(', ')}\n`)
        return 0
      }

      default:
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  })
}
