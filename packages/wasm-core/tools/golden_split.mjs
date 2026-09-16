// Split golden verification (S0): splits golden.mjs output into sections and compares them.
//  - Support-free sections: must stay byte-identical even when support logic changes (detects regressions on unrelated paths)
//  - Support sections: "changing is expected" when the threshold-angle formula is corrected — only whether it changed is reported
// Usage: node golden_split.mjs <baseline.txt> <current.txt>
import { readFileSync } from 'node:fs'

const split = (path) => {
  const txt = readFileSync(path, 'utf8')
  const out = {}
  let name = '(prologue)', buf = []
  for (const line of txt.split('\n')) {
    if (line.startsWith('=== ')) { out[name] = buf.join('\n'); name = line.trim(); buf = [] }
    else buf.push(line)
  }
  out[name] = buf.join('\n')
  return out
}

const [basePath, curPath] = process.argv.slice(2)
if (!basePath || !curPath) { console.error('usage: node golden_split.mjs <baseline> <current>'); process.exit(2) }
const base = split(basePath), cur = split(curPath)

const isSupport = (name) => /support/i.test(name) && !/no support/i.test(name)
let fail = 0
for (const name of Object.keys(base)) {
  if (name === '(prologue)') continue
  const same = base[name] === cur[name]
  if (isSupport(name)) {
    console.log(`${same ? '=  ' : '≠  '} ${name}  [support — change allowed]`)
  } else if (same) {
    console.log(`OK  ${name}  [support-free — byte-identical]`)
  } else {
    console.log(`FAIL ${name}  [support-free but changed — regression on an unrelated path!]`)
    fail++
  }
}
console.log(fail ? `\n${fail} support-free section(s) changed — suspected regression` : '\nAll support-free sections are byte-identical')
process.exit(fail ? 1 : 0)
