import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Finding {
  file: string
  /** 1-based line number. */
  line: number
  rule: string
}

/** Home-directory usernames that are neutral placeholders rather than a contributor's identity. */
const PLACEHOLDER_USERS = new Set(['user', 'username', 'example', 'you'])

const SECRET_KEY_NAME = String.raw`[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)[\w-]*`

interface Rule {
  name: string
  pattern: RegExp
  /** Extra check on the match; return false to discard it. */
  accept?: (match: RegExpExecArray) => boolean
}

const RULES: Rule[] = [
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  {
    // A secret-named key given a long, unplaceholdered value. Bare `key: value` and spaced `key = value`
    // are prose or code, so they need letters and digits; a quoted value or compact `key=value` is
    // JSON, env, or CLI style, and is flagged whatever it contains.
    name: 'secret-assignment',
    pattern: new RegExp(
      String.raw`${SECRET_KEY_NAME}(?:\\?["'])?(\s*[=:]\s*)((?:\\?["'])?)([^\s"'\\$<{*\[][^\s"'\\]{7,})`,
      'i',
    ),
    accept: ([, separator, quote, value]) =>
      quote !== '' || separator === '=' || (/[A-Za-z]/.test(value!) && /\d/.test(value!)),
  },
  {
    name: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/i,
    accept: (match) => !/^[<$*{]/.test(match[1]!),
  },
  {
    name: 'real-path',
    pattern: /(?<![\w.~-])\/(?:Users|home)\/([^/\s"'\\]+)|\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"']+)/,
    accept: (match) => !PLACEHOLDER_USERS.has((match[1] ?? match[2] ?? '').toLowerCase()),
  },
]

/**
 * Scan text for anything resembling a credential or a contributor's real paths. Findings carry the
 * rule and line only: the matched text is never reported, so CI logs cannot leak what they catch.
 */
export function scanText(text: string, file = '<input>'): Finding[] {
  const findings: Finding[] = []
  text.split('\n').forEach((lineText, index) => {
    for (const rule of RULES) {
      const match = rule.pattern.exec(lineText)
      if (match && (rule.accept?.(match) ?? true)) {
        findings.push({ file, line: index + 1, rule: rule.name })
      }
    }
  })
  return findings
}

function expand(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** Scan files, expanding directories recursively. Throws on a path that does not exist. */
export function checkSanitized(paths: string[]): Finding[] {
  return paths.flatMap(expand).flatMap((file) => scanText(readFileSync(file, 'utf8'), file))
}
