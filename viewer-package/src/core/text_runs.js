// Which font draws which character of a text. A host's font never declares `han`: one code point has different forms
//  in Korean, Japanese, Simplified and Traditional fonts, so only the font the user chose may draw it.
const SCRIPT_RANGES = {
  hangul: [[0x1100, 0x11FF], [0x3131, 0x318E], [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xD7B0, 0xD7FF]],
  kana: [[0x3040, 0x30FF], [0x31F0, 0x31FF], [0xFF66, 0xFF9F]],
  han: [[0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0x20000, 0x3FFFF]],
}

export function scriptOf(character) {
  const codePoint = character.codePointAt(0)
  for (const [script, ranges] of Object.entries(SCRIPT_RANGES)) {
    if (ranges.some(([first, last]) => codePoint >= first && codePoint <= last)) return script
  }
  return 'latin'
}

// The one fallback a character has: the first entry that declares its script.
export function fallbackFor(character, entries) {
  const script = scriptOf(character)
  return entries.find(entry => entry.covers?.includes(script)) ?? null
}

// Splits the text where the font changes. A space has no font of its own and stays in the run it falls in.
export function textRuns(text, fontOf, firstFont) {
  const runs = []
  for (const character of text) {
    const font = fontOf(character) ?? runs[runs.length - 1]?.font ?? firstFont
    const last = runs[runs.length - 1]
    if (last?.font === font) last.text += character
    else runs.push({ font, text: character })
  }
  return runs
}
