// Phase one of the long-horizon build benchmark: the engine itself.
//
// One feature per run, scored after every run against all thirty-four checks.
// The curve is the result: rising means the agent can be trusted with ongoing
// work, rising then dipping means it broke something it had already built, and
// flat means it has stopped making progress at all.
//
// The machinery lives in bench-series-harness.mjs, shared with the
// first-person view benchmark that builds on top of this one.
//
// Usage:
//   node scripts/bench-roguelike-run.mjs setup    # workspace + run 1 spec
//   node scripts/bench-roguelike-run.mjs arm      # schedule the continuation
//   node scripts/bench-roguelike-run.mjs watch    # snapshot and score, forever
//   node scripts/bench-roguelike-run.mjs report   # the curve so far
//   node scripts/bench-roguelike-run.mjs cleanup  # remove the schedule
import { benchmark, main } from './bench-series-harness.mjs'
import { WORKSPACE, writeWorkspace } from './bench-roguelike-fixture.mjs'

const MARKER = 'Deepdown, a terminal roguelike'

const GOAL = [
  `You are building ${MARKER}. Read SPEC.md first, then FEATURES.md.`,
  '',
  '**The checklist may be behind the code.** An earlier run may have built more than ' +
    'it ticked. So before anything else: check each unticked feature against what the ' +
    'engine actually does, and tick every one that already works. Do that in one pass, ' +
    'cheaply, without rewriting anything.',
  '',
  'Then implement the first feature that genuinely does not work yet — exactly one — ' +
    'and tick it.',
  '',
  '**Do not break a feature that already works.** Everything already ticked is checked ' +
    'again after this run, and breaking an earlier feature costs more than adding this ' +
    'one gains. Read the code you are about to change before you change it.',
  '',
  'Keep your own regression file, `tests.py`: one check per finished feature, runnable ' +
    'with `python tests.py`, printing a line per check and a failure count. Add a check ' +
    'for whatever you build this run, and **run the whole file before you finish**. If ' +
    'something you did not touch has started failing, fix that first — it is worth more ' +
    'than the feature you came here to add.',
  '',
  'Run `python check.py` too. An engine that will not import scores nothing at all.',
  '',
  'Keep throwaway scripts out of the project: use `python -c` for one-offs, or put them ' +
    'in `scratch/`. Do not leave copies of engine.py or FEATURES.md lying around.',
  '',
  'When the feature works and its box is ticked, call finish_goal saying which feature ' +
    'you did, which boxes you ticked for work that was already there, and anything you ' +
    'had to change in what existed.'
].join('\n')

const commands = benchmark({
  taskId: 'bench_roguelike',
  name: 'Deepdown — next feature',
  marker: MARKER,
  workspace: WORKSPACE,
  writeWorkspace,
  goal: GOAL,
  acceptScript: 'scripts/bench-roguelike-accept.py',
  featuresFile: 'FEATURES.md',
  specPath: 'scripts/bench-roguelike-run1.json',
  resultsPath: 'scripts/bench-roguelike-results.json',
  snapshotsPath: 'scripts/bench-roguelike-snapshots',
  total: 34
})

await main(commands, 'usage: node scripts/bench-roguelike-run.mjs setup|arm|watch|report|cleanup')
