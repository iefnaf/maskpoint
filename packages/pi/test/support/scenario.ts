import type { PiEffect } from '../../src/compact.js'
import { assistant, bulky, text, thinking, toolCall, toolResult, user } from './session.js'

/** Narrow an effect to a native replacement, failing the test with the decline reason otherwise. */
export const native = (effect: PiEffect): Extract<PiEffect, { kind: 'native' }> => {
  if (effect.kind !== 'native') throw new Error(`expected a native effect, got decline: ${effect.reason} ${effect.note ?? ''}`)
  return effect
}

/** A short session whose first turn read a bulky file. The retained region starts at u2. */
export const firstTurn = () => [
  user('u1', 'Rename the Widget component to Panel and update the docs.'),
  assistant('a1', [
    thinking('Find every usage before touching anything.'),
    text('I will grep for it first.'),
    toolCall('call-1', 'grep', { pattern: 'Widget', path: '/workspace/app' }),
  ]),
  toolResult('r1', 'call-1', 'grep', bulky('BODY-1')),
  assistant('a2', [text('There are forty usages across the app.')]),
  user('u2', 'Go ahead with the rename.'),
  assistant('a3', [text('Starting on the rename now.')]),
]
