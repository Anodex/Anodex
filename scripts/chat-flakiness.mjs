#!/usr/bin/env node
/**
 * Combine several matrix runs and report which criteria are unstable.
 *
 * Usage: node scripts/chat-flakiness.mjs <run> <run> [...] [--criteria <file>]
 *
 * A run is either a matrix `summary.json`, or — with `--criteria` — a directory
 * of logs to re-grade on the spot.
 *
 * A single matrix run answers "did it pass". Run the same models over the same
 * prompts three times and a different question becomes answerable: "does it
 * pass *reliably*". Those are not the same property, and only the second one is
 * worth calling a 10.
 *
 * This matters more for local models than the score ever did. Sampling is not
 * deterministic, so a criterion can pass on one run and fail on the next with
 * nothing changed — and a single run reports whichever of those it happened to
 * get. The failure mode is believing a surface is fixed because the one run you
 * did was the good one.
 *
 * A criterion that is 3/3 or 0/3 is telling you something about the build. A
 * criterion that is 2/3 is telling you about the sampler, and is the only kind
 * of result that a repeat run can find at all.
 *
 * **Read a 0/3 with one extra check: did the replies actually differ?** Repeat
 * runs only measure anything where sampling varies, and it does not vary
 * uniformly. Hashing qwen4b's twelve replies across three runs of the hard
 * script gave seven turns that differed every time and four that were
 * byte-identical — the short, high-confidence ones (a refusal, an arithmetic
 * answer, an acknowledgement). So a 0/3 on a long discursive turn is three
 * independent failures, while a 0/3 on a short one may be the same generation
 * three times.
 *
 * That distinction decides what to do about it. A stable attractor will not
 * shift for a reworded prompt, and trying is how a core prompt accumulates
 * sentences that cost every model context and fix nothing: adding 39 tokens
 * against one such failure changed the reply not at all — byte for byte. Diff
 * the transcripts before concluding a fix is needed, and again before
 * concluding one worked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const criteriaFlag = args.indexOf('--criteria')
/**
 * Re-grade from logs rather than trusting each run's stored summary.
 *
 * A rubric gets corrected while a matrix is still running — that is normal, and
 * it happened during the run this script was written for. The summaries then
 * disagree about what was even being measured, and comparing them across runs
 * silently compares two different rubrics. Pointing this at the run
 * *directories* with `--criteria` re-scores every log with one version, which
 * is the only way the comparison means anything.
 */
const criteria = criteriaFlag !== -1 ? args[criteriaFlag + 1] : null
const summaries = args.filter(
  (arg, index) => !arg.startsWith('--') && args[index - 1] !== '--criteria'
)

if (summaries.length < 2) {
  console.error('Usage: node scripts/chat-flakiness.mjs <run> <run> [...] [--criteria <file>]')
  console.error('A run is a summary.json, or a directory of logs when --criteria is given.')
  console.error('At least two runs — one run cannot show instability.')
  process.exit(2)
}

/**
 * A run's rows, either read from its summary or produced by re-grading.
 *
 * The model key comes from the log filename, which is how `chat-matrix.mjs`
 * names them in the first place.
 */
function rowsFor(path) {
  if (!statSync(path).isDirectory()) return JSON.parse(readFileSync(path, 'utf-8'))
  if (!criteria) {
    console.error(`${path} is a directory; pass --criteria <file> to re-grade it.`)
    process.exit(2)
  }
  return readdirSync(path)
    .filter((name) => name.endsWith('.log'))
    .map((name) => {
      const result = spawnSync(process.execPath, [criteria, join(path, name), '--json'], {
        encoding: 'utf-8'
      })
      const line = (result.stdout ?? '').trim().split(/\r?\n/).pop()
      return { key: basename(name, '.log'), ...JSON.parse(line) }
    })
}

/** model key -> criterion id -> { passed, total } */
const tally = new Map()
/** model key -> how many of the runs finished every prompt */
const completeRuns = new Map()

for (const path of summaries) {
  for (const row of rowsFor(path)) {
    if (!tally.has(row.key)) tally.set(row.key, new Map())
    const perCriterion = tally.get(row.key)
    completeRuns.set(row.key, (completeRuns.get(row.key) ?? 0) + (row.complete ? 1 : 0))
    for (const result of row.results ?? []) {
      const entry = perCriterion.get(result.id) ?? { passed: 0, total: 0 }
      entry.passed += result.passed ? 1 : 0
      entry.total += 1
      perCriterion.set(result.id, entry)
    }
  }
}

const runs = summaries.length
let flaky = 0
let solidFailures = 0

for (const [key, perCriterion] of tally) {
  const stable = [...perCriterion.values()].filter((e) => e.passed === e.total).length
  console.log(`\n${key}  (${completeRuns.get(key) ?? 0}/${runs} runs completed every prompt)`)
  console.log(`  ${stable}/${perCriterion.size} criteria passed on every run`)
  for (const [id, entry] of perCriterion) {
    if (entry.passed === entry.total) continue
    // Only the interesting rows are printed. A list where most lines say "3/3"
    // buries the two lines that do not.
    const verdict = entry.passed === 0 ? 'never passed' : 'FLAKY'
    if (entry.passed === 0) solidFailures += 1
    else flaky += 1
    console.log(`    ${String(entry.passed).padStart(2)}/${entry.total}  ${id}  — ${verdict}`)
  }
}

console.log(
  `\n${flaky} flaky criteria (pass sometimes), ${solidFailures} consistent failures across ${runs} runs`
)
// Flakiness is the finding this script exists for, so it is not an error exit:
// a run that surfaces two unstable criteria has done its job.
process.exit(0)
