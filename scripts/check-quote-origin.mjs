// One-off: for each quotation a run reported as untraceable, work out where the
// model could have got it -- a fetched passage, a step finding written during
// research, the plan, or the question itself.
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.env.APPDATA, 'anodex', 'critical-thinking')
const run = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')))[0]

const evidenceFile = fs
  .readdirSync(path.join(dir, 'evidence'))
  .find((name) => name.includes(String(run.id).slice(0, 18)))
const artifacts = Object.values(
  JSON.parse(fs.readFileSync(path.join(dir, 'evidence', evidenceFile), 'utf8'))
).filter((entry) => entry.kind === 'web-fetch')

const normalize = (value) =>
  String(value)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const passages = artifacts.flatMap((a) => (a.passages ?? []).map((p) => normalize(p.text)))
const findings = (run.steps ?? []).map((s) => normalize(s.finding))
const uncertainties = (run.steps ?? []).flatMap((s) => (s.uncertainties ?? []).map(normalize))
const titles = (run.steps ?? []).map((s) => normalize(s.title))
const question = normalize(run.question)

const draft = (run.synthesisDiagnostics?.attempts ?? []).find((a) => a.stage === 'draft')
const quotes = (draft?.issues ?? [])
  .filter((i) => i.startsWith('Quoted text is not present'))
  .map((i) => /“([\s\S]*)”\s*$/.exec(i)?.[1])
  .filter(Boolean)

const tally = { passage: 0, finding: 0, uncertainty: 0, title: 0, question: 0, nowhere: 0 }
for (const quote of quotes) {
  const needle = normalize(quote).replace(/\.\.\.$/, '')
  const where = passages.some((p) => p.includes(needle))
    ? 'passage'
    : findings.some((f) => f.includes(needle))
      ? 'finding'
      : uncertainties.some((u) => u.includes(needle))
        ? 'uncertainty'
        : titles.some((t) => t.includes(needle))
          ? 'title'
          : question.includes(needle)
            ? 'question'
            : 'nowhere'
  tally[where]++
  console.log(where.padEnd(12), needle.slice(0, 66))
}
console.log('\n', JSON.stringify(tally))
