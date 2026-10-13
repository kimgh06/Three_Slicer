// Split golden verification (S0): splits golden.mjs output into sections and compares them.
//  - Support-free sections: must stay byte-identical even when support logic changes (detects regressions on unrelated paths)
//  - Support sections: "changing is expected" when the threshold-angle formula is corrected — only whether it changed is reported
// Usage: node golden_split.mjs <baseline.txt> <current.txt>
import { readFileSync } from 'node:fs'

const split = (path) => {
  const text = readFileSync(path, 'utf8')
  const sections = {}
  let name = '(prologue)', sectionLines = []
  for (const line of text.split('\n')) {
    if (line.startsWith('=== ')) {
      sections[name] = sectionLines.join('\n')
      name = line.trim()
      sectionLines = []
    }
    else sectionLines.push(line)
  }
  sections[name] = sectionLines.join('\n')
  return sections
}

const [basePath, currentPath] = process.argv.slice(2)
if (!basePath || !currentPath) {
  console.error('usage: node golden_split.mjs <baseline> <current>')
  process.exit(2)
}
const base = split(basePath)
const current = split(currentPath)

const isSupport = (name) => /support/i.test(name) && !/no support/i.test(name)
let fail = 0
for (const name of Object.keys(base)) {
  if (name === '(prologue)') continue
  const same = base[name] === current[name]
  if (isSupport(name)) {
    let marker = '≠  '
    if (same) marker = '=  '
    console.log(`${marker} ${name}  [support — change allowed]`)
  } else if (same) {
    console.log(`OK  ${name}  [support-free — byte-identical]`)
  } else {
    console.log(`FAIL ${name}  [support-free but changed — regression on an unrelated path!]`)
    fail++
  }
}
if (fail) {
  console.log(`\n${fail} support-free section(s) changed — suspected regression`)
  process.exit(1)
}
console.log('\nAll support-free sections are byte-identical')
process.exit(0)
