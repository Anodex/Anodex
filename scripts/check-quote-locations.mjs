// One-off: for each quotation a run reported as untraceable, say whether the
// text exists anywhere in that run's fetched evidence, and if so where.
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.env.APPDATA, 'anodex', 'critical-thinking')
const runs = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')))
const run = runs[0]

const evidenceFile = fs
  .readdirSync(path.join(dir, 'evidence'))
  .find((name) => name.includes(String(run.id).slice(0, 18)))
const artifacts = Object.values(
  JSON.parse(fs.readFileSync(path.join(dir, 'evidence', evidenceFile), 'utf8'))
).filter((entry) => entry.kind === 'web-fetch')

const normalize = (value) =>
  value
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const haystack = artifacts.flatMap((artifact) =>
  (artifact.passages ?? []).map((passage) => ({
    url: artifact.finalUrl,
    id: passage.id,
    text: normalize(passage.text)
  }))
)

const draft = (run.synthesisDiagnostics?.attempts ?? []).find((a) => a.stage === 'draft')
const quotes = (draft?.issues ?? [])
  .filter((issue) => issue.startsWith('Quoted text is not present'))
  .map((issue) => /“([\s\S]*)”\s*$/.exec(issue)?.[1])
  .filter(Boolean)

let found = 0
for (const quote of quotes) {
  // Issue text is truncated for display, so match on the prefix that survives.
  const needle = normalize(quote).replace(/\.\.\.$/, '')
  const hit = haystack.find((entry) => entry.text.includes(needle))
  if (hit) found++
  console.log(
    `${hit ? 'IN EVIDENCE ' : 'NOT FOUND   '} ${hit ? `${hit.id} of ${new URL(hit.url).hostname}` : ''}`.padEnd(
      46
    ),
    needle.slice(0, 62)
  )
}
console.log(`\n${found} of ${quotes.length} reported-untraceable quotations exist in the evidence.`)
