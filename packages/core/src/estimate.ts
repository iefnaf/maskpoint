/** Cost of one code point, in quarter-tokens, so the arithmetic stays in integers. */
const QUARTERS_CJK = 6
const QUARTERS_OTHER_NON_ASCII = 4
const QUARTERS_ASCII_SYMBOL = 2
const QUARTERS_ASCII_OTHER = 1

/** Kana, CJK ideographs and extensions, Hangul, CJK punctuation and full-width forms. */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  )
}

function isAsciiSymbol(codePoint: number): boolean {
  return (
    (codePoint >= 0x21 && codePoint <= 0x2f) ||
    (codePoint >= 0x3a && codePoint <= 0x40) ||
    (codePoint >= 0x5b && codePoint <= 0x60) ||
    (codePoint >= 0x7b && codePoint <= 0x7e)
  )
}

/**
 * Estimated token count for a piece of text. This is the single estimator in the system: the
 * no-expansion rule in masking and the checkpoint budget both use it, so they agree by construction.
 *
 * Deliberately conservative — it overestimates rather than under — and weights by kind of character
 * instead of counting characters alike: CJK characters cost more than one token each, and the
 * punctuation that dominates source code costs more than prose. Calibration against host meters is
 * an open issue in docs/design.md; treat the constants as tuning parameters.
 */
export function estimateTokens(text: string): number {
  let quarters = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (codePoint < 0x80) quarters += isAsciiSymbol(codePoint) ? QUARTERS_ASCII_SYMBOL : QUARTERS_ASCII_OTHER
    else quarters += isCjk(codePoint) ? QUARTERS_CJK : QUARTERS_OTHER_NON_ASCII
  }
  return Math.ceil(quarters / 4)
}
