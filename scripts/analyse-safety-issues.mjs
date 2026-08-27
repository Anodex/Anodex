// One-off: for every number a stored run flagged as fabricated, decide honestly
// whether that figure is really absent from the run's evidence -- matching on a
// standalone number, not a substring, and reporting where it was found.
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.env.APPDATA, 'anodex', 'critical-thinking')
const runs = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')))

const standalone = (haystack, figure) =>
  new RegExp(`(?<![\\d.,])${figure.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?![\\d.,])`).test(
    haystack
  )

let absent = 0
let present = 0
for (const run of runs) {
  const draft = (run.synthesisDiagnostics?.attempts ?? []).find((a) => a.stage === 'draft')
  if (!draft) continue
  const file = fs
    .readdirSync(path.join(dir, 'evidence'))
    .find((n) => n.includes(String(run.id).slice(0, 18)))
  if (!file) continue
  const passages = Object.values(
    JSON.parse(fs.readFileSync(path.join(dir, 'evidence', file), 'utf8'))
  )
    .filter((e) => e.kind === 'web-fetch')
    .flatMap((e) => (e.passages ?? []).map((p) => p.text))
  const allText = passages.join(' \n ')

  const figures = (draft.issues ?? [])
    .filter((i) => i.startsWith('Numeric claim'))
    .map((i) => /Numeric claim (\S+?) (?:is|has)/.exec(i)?.[1])
    .filter(Boolean)

  if (figures.length) console.log(`\n### ${String(run.question).slice(0, 44)}`)
  for (const figure of figures) {
    const bare = figure.replace(/[,%]/g, '')
    const found = standalone(allText, bare)
    if (found) present++
    else absent++
    console.log(`  ${figure.padEnd(9)} ${found ? 'present in evidence' : 'ABSENT from evidence'}`)
  }
}
console.log(`\nflagged figures genuinely absent: ${absent}   present somewhere: ${present}`)
