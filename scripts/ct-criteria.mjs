// One-off: report the four clean-run criteria for every stored run.
//   1. selectedStage is the model's own report -- draft, repair, or a
//      hierarchical report none of whose sections fell back to excerpts
//   2. every step completed where evidence exists
//   3. status completed
//   4. zero excerpt-dump blocks in the shipped report
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const runs = Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(
  (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
)

const only = process.argv[2] ? Number(process.argv[2]) : null

// An excerpt-dump block is the assembled-fallback shape: raw passages listed in
// place of prose that answers the question.
//
// This used to count any markdown blockquote line, and that measured the wrong
// thing in both directions. Checked against every stored run:
//
//   - Six runs (2, 11, 12, 18, 30, 31) contain the fallback's own lead line and
//     were every one scored `dumps=0`. Every real excerpt dump was missed.
//   - Two runs (38, 40) contain no dump at all and were both flagged - on a
//     quotation from a source, and on the model's own recommendation set in a
//     blockquote for emphasis.
//
// Zero true positives, two false positives. The fallback emits bullets under a
// fixed lead line (`buildStepBody` in `criticalThinkingFallbackReport.ts`) and
// never a blockquote, so a blockquote could only ever be the model quoting
// something - which the evidence validator elsewhere calls the ordinary way to
// present a quotation.
//
// Matching the real signature makes this criterion stricter, not looser: six
// runs that passed it were carrying excerpt dumps.
const FALLBACK_LEAD = 'Direct excerpts from the verified sources'

const dumpBlocks = (report) => {
  if (!report) return 0
  let n = 0
  for (const line of report.split('\n')) {
    if (line.includes(FALLBACK_LEAD)) n++
    if (/^#{1,6}\s+(Excerpt|Passage|Raw|Source \d)/i.test(line)) n++
  }
  return n
}

/** The attempt that produced the shipped report. */
const shippedAttempt = (d) => {
  const stage = d.selectedStage
  if (!stage) return null
  const matching = (d.attempts ?? []).filter((a) => a.stage === stage)
  return matching.length ? matching[matching.length - 1] : null
}

/** Issues per cited block -- the same rate `chooseBetterReportCandidate` uses. */
const issueRate = (a) => (a.issues ?? []).length / Math.max(1, a.citedBlockCount ?? 0)

/**
 * Stages that produce a whole report, and so could actually have shipped.
 *
 * The first version of this compared against every attempt and flagged runs 54
 * and 58 for "discarding" a `section` -- one step's worth of prose, which was
 * never a competing candidate and is in fact already inside the hierarchical
 * report. A section scoring better than a whole report says nothing; parts and
 * wholes are not comparable.
 */
const WHOLE_REPORT_STAGES = new Set([
  'draft',
  'repair',
  'hierarchical-report',
  'chart',
  'deterministic-fallback'
])

/**
 * A candidate this run wrote that the shipped report should have lost to.
 *
 * Beaten on both cited coverage and issue rate, so a deliberate trade -- fewer
 * claims, made more carefully -- is not reported as a mistake. And never
 * flagged when the shipped report wins an earlier tiebreak in
 * `chooseBetterReportCandidate`: a valid report beats an invalid one however
 * well the invalid one is cited, and an unusable candidate is out regardless.
 * Without that, this called run 44 a mistake for preferring its valid draft.
 */
const betterThan = (shipped, attempts) =>
  attempts.find(
    (a) =>
      a !== shipped &&
      WHOLE_REPORT_STAGES.has(a.stage) &&
      a.usable === true &&
      // Losing on validity is a legitimate reason to be passed over.
      !(shipped.valid === true && a.valid !== true) &&
      (a.citedBlockCount ?? 0) > (shipped.citedBlockCount ?? 0) &&
      issueRate(a) < issueRate(shipped)
  ) ?? null

for (const [i, run] of runs.entries()) {
  if (only !== null && i + 1 !== only) continue
  const d = run.synthesisDiagnostics ?? {}
  const steps = run.steps ?? []
  const done = steps.filter((s) => s.status === 'completed').length
  const tally = {}
  let rounds = 0
  for (const step of steps)
    for (const round of step.rounds ?? []) {
      const v = round.assessment?.verdict
      if (!v) continue
      rounds++
      tally[v] = (tally[v] ?? 0) + 1
    }
  const suff = rounds ? Math.round(((tally.sufficient ?? 0) / rounds) * 100) : 0
  // Runs recorded before the chart fix stored `selectedStage: 'chart'` when a
  // chart was appended, which overwrote the stage that wrote the prose. A chart
  // is only ever appended to the winning report, so for those older runs
  // 'chart' still means the model's own report -- it just no longer says which.
  //
  // `hierarchical-report` is also the model's own report when none of its
  // sections fell back: each section is written and validated separately, then
  // assembled. It is the strategy for a small context, not a degradation, and
  // scoring it as a failure marked runs 53, 55 and 56 not-clean while they
  // shipped valid, safe, fully cited reports. A `section-fallback` attempt in
  // the run means excerpts stood in for at least one section, which is the
  // case this criterion is actually for.
  const fellBackToExcerpts = (d.attempts ?? []).some(
    (attempt) => attempt.stage === 'section-fallback'
  )
  const c1 =
    d.selectedStage === 'draft' ||
    d.selectedStage === 'repair' ||
    d.selectedStage === 'chart' ||
    (d.selectedStage === 'hierarchical-report' && !fellBackToExcerpts)
  const c2 = steps.length > 0 && done === steps.length
  const c3 = run.status === 'completed'
  const c4 = dumpBlocks(run.report) === 0
  // Did the run ship the weaker of two reports it wrote?
  //
  // The four criteria above all passed for run 58 while it shipped a
  // 6,603-character report with 4 cited blocks and discarded a 32,912-character
  // one with 35 that it had already written and validated. `cited` was printed
  // right there and scored nothing, so the run read CLEAN.
  //
  // Unlike a bar on `cited` -- which the note below rightly refuses, because
  // any absolute threshold would be invented -- this needs no threshold. It is
  // a comparison inside one run, against candidates the run produced itself: a
  // usable candidate beaten on *both* cited coverage and issue rate by another
  // usable candidate should not be the one that shipped. Nothing here says how
  // much coverage is enough.
  const shipped = shippedAttempt(d)
  const outclassed = shipped ? betterThan(shipped, d.attempts ?? []) : null
  const c5 = !outclassed
  const clean = c1 && c2 && c3 && c4 && c5
  console.log(
    [
      `run ${String(i + 1).padStart(2)}`,
      new Date(run.createdAt ?? 0).toISOString().slice(5, 16),
      clean ? 'CLEAN  ' : 'not-clean',
      `stage=${String(d.selectedStage).padEnd(8)}${d.chartAdded ? '+chart' : '      '}${c1 ? '+' : '-'}`,
      `steps=${done}/${steps.length}${c2 ? '+' : '-'}`,
      `status=${String(run.status).padEnd(9)}${c3 ? '+' : '-'}`,
      `dumps=${dumpBlocks(run.report)}${c4 ? '+' : '-'}`,
      `shipped-best=${c5 ? 'yes+' : 'no -'}`,
      `suff=${suff}%`,
      `chars=${(run.report ?? '').length}`,
      // Reported, deliberately not scored. "Completed" is defined as research
      // that was substantial, well-sourced AND CITED, and the four criteria
      // cannot see the last of those. Measured on one question: a 4B and a 27B
      // did the same research - 13 rounds against 12, 36 searches each, 49
      // fetches against 44, 29 sources against 26 - and both scored clean, with
      // 10 cited blocks against 57 and a third of the prose. The smaller model
      // gathered the evidence and then hardly used it.
      //
      // Not turned into a pass/fail bar: any threshold would be invented from
      // this single comparison, and thresholds fitted to one observation are
      // how this system was over-fitted before. Shown so the difference cannot
      // pass unnoticed.
      `cited=${d.completion?.citedSubstantiveBlockCount ?? '?'}`
    ].join('  ')
  )
  if (outclassed) {
    const rate = (a) => ((a.issues ?? []).length / Math.max(1, a.citedBlockCount ?? 0)).toFixed(2)
    console.log(
      `    shipped a weaker report: ${shipped.stage} ${shipped.contentChars}ch ` +
        `cited=${shipped.citedBlockCount} rate=${rate(shipped)} ` +
        `| discarded ${outclassed.stage} ${outclassed.contentChars}ch ` +
        `cited=${outclassed.citedBlockCount} rate=${rate(outclassed)}`
    )
  }
  const blockers = d.completion?.blockers
  if (blockers?.length)
    console.log('    blockers:', blockers.join(', '), '|', JSON.stringify(d.completion))
  if (process.env.VERBOSE) {
    console.log('    question:', (run.question ?? '').slice(0, 100))
    for (const a of d.attempts ?? [])
      console.log(
        `    ${a.stage}: chars=${a.contentChars} valid=${a.valid} issues=${(a.issues ?? []).length}`
      )
  }
}
