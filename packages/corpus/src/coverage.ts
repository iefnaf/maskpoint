import type { ConversationSnapshot, Item } from '@maskpoint/core'

/**
 * Content shapes the corpus exists to exercise. Derived from the items themselves, never from
 * labels, so a fixture cannot claim coverage it does not have.
 */
export type Feature =
  | 'text-observation'
  | 'image-observation'
  | 'success-result'
  | 'error-result'
  | 'shell-execution'
  | 'parallel-tool-calls'
  | 'split-turn'
  | 'host-context'
  | 'cjk'
  | 'code-heavy'
  | 'pre-masked'
  | 'previous-checkpoint'

/** What the design's Testing section says the shared corpus must cover. */
export const REQUIRED_FEATURES: readonly Feature[] = [
  'text-observation',
  'image-observation',
  'success-result',
  'error-result',
  'shell-execution',
  'parallel-tool-calls',
  'split-turn',
  'host-context',
  'cjk',
  'code-heavy',
]

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/
const CODE_PUNCTUATION = /[{}()[\];=<>]/g
const CODE_MIN_LINES = 30
const CODE_MIN_DENSITY = 0.05

function texts(item: Item): string[] {
  switch (item.kind) {
    case 'tool-call':
      return [item.args]
    case 'tool-result':
      return item.text === undefined ? [] : [item.text]
    case 'opaque':
      return [item.note]
    case 'host-context':
      return [item.label, item.text]
    default:
      return [item.text]
  }
}

function isShellCall(item: Item): boolean {
  if (item.kind !== 'tool-call') return false
  try {
    const args: unknown = JSON.parse(item.args)
    return typeof args === 'object' && args !== null && typeof (args as { command?: unknown }).command === 'string'
  } catch {
    return false
  }
}

function isCodeHeavy(text: string): boolean {
  if (text.split('\n').length < CODE_MIN_LINES) return false
  return (text.match(CODE_PUNCTUATION)?.length ?? 0) / text.length >= CODE_MIN_DENSITY
}

export function featuresOf(snapshot: ConversationSnapshot): Set<Feature> {
  const { items } = snapshot
  const features = new Set<Feature>()

  items.forEach((item, index) => {
    if (texts(item).some((text) => CJK.test(text))) features.add('cjk')
    if (item.kind === 'host-context') features.add('host-context')
    if (item.kind === 'checkpoint') features.add('previous-checkpoint')
    if (isShellCall(item)) features.add('shell-execution')
    if (item.kind === 'tool-call' && items[index + 1]?.kind === 'tool-call') features.add('parallel-tool-calls')
    if (item.kind === 'tool-result') {
      features.add(item.status === 'ok' ? 'success-result' : 'error-result')
      if (item.media > 0) features.add('image-observation')
      if (item.text !== undefined && item.text !== '' && item.media === 0) features.add('text-observation')
      if (item.masked) features.add('pre-masked')
      if (item.text !== undefined && isCodeHeavy(item.text)) features.add('code-heavy')
    }
  })
  if (snapshot.previousCheckpoint !== undefined) features.add('previous-checkpoint')

  // A split turn: the host's cut lands inside a turn, so the first retained item is not the start of one.
  const boundaryIndex = items.findIndex((item) => item.id === snapshot.boundary.id)
  const startsTurn = items[boundaryIndex]?.kind === 'user'
  if (boundaryIndex > 0 && !startsTurn && items.slice(0, boundaryIndex).some((item) => item.kind === 'user')) {
    features.add('split-turn')
  }
  return features
}
