// Phase two of the long-horizon build benchmark: a first-person view.
//
// The engine phase measured whether an agent could grow one codebase across
// dozens of unattended runs. This phase asks a harder question: can it add a
// second subsystem to a codebase it already built, against an interface it did
// not design, without breaking the first one. Every run is scored against the
// engine's own rubric as well, so damage to what already works shows up.
//
// Usage:
//   node scripts/bench-view3d-run.mjs setup    # workspace + run 1 spec
//   node scripts/bench-view3d-run.mjs arm      # schedule the continuation
//   node scripts/bench-view3d-run.mjs watch    # snapshot and score, forever
//   node scripts/bench-view3d-run.mjs report   # the curve so far
//   node scripts/bench-view3d-run.mjs cleanup  # remove the schedule
import { benchmark, main } from './bench-series-harness.mjs'
import { WORKSPACE, writeFixture } from './bench-view3d-fixture.mjs'

const MARKER = 'Deepdown in first person'

const GOAL = [
  `You are building ${MARKER} — a raycast view of a roguelike engine that is ` +
    'already finished. Read SPEC-3D.md first, then FEATURES-3D.md.',
  '',
  '`engine.py` works and is not yours to change. Neither are `main.py`, `check.py` ' +
    'or `tests.py` — the terminal view has to keep running. Your work goes in new ' +
    'files: `render3d.py` for the maths and `view3d.py` for the window.',
  '',
  'pygame is installed and imports as `pygame`. Do not try to install anything.',
  '',
  '**The checklist may be behind the code.** An earlier run may have built more than ' +
    'it ticked. So before anything else: check each unticked feature against what the ' +
    'code actually does, and tick every one that already works. One pass, cheaply, ' +
    'without rewriting anything.',
  '',
  'Then implement the first feature that genuinely does not work yet — exactly one — ' +
    'and tick it.',
  '',
  '**Do not break a feature that already works.** Everything ticked is checked again ' +
    'after this run, the engine included, and breaking an earlier feature costs more ' +
    'than adding this one gains. Read the code you are about to change first.',
  '',
  'Keep your own regression file, `tests3d.py`: one check per finished feature, ' +
    'runnable with `python tests3d.py`, printing a line per check and a failure count. ' +
    'It must not need a display — set `SDL_VIDEODRIVER=dummy` and drive `View` through ' +
    '`frame()` and `key()` rather than opening a window. Add a check for whatever you ' +
    'build this run, and **run the whole file before you finish**. If something you did ' +
    'not touch has started failing, fix that first.',
  '',
  'Run `python check3d.py` and `python check.py` too. Code that will not import scores ' +
    'nothing at all.',
  '',
  'Keep throwaway scripts out of the project: use `python -c` for one-offs, or put them ' +
    'in `scratch/`. Do not leave copies of engine.py or the checklists lying around.',
  '',
  'When the feature works and its box is ticked, call finish_goal saying which feature ' +
    'you did, which boxes you ticked for work that was already there, and anything you ' +
    'had to change in what existed.'
].join('\n')

const commands = benchmark({
  taskId: 'bench_view3d',
  name: 'Deepdown in first person — next feature',
  marker: MARKER,
  workspace: WORKSPACE,
  writeWorkspace: writeFixture,
  goal: GOAL,
  acceptScript: 'scripts/bench-view3d-accept.py',
  featuresFile: 'FEATURES-3D.md',
  specPath: 'scripts/bench-view3d-run1.json',
  resultsPath: 'scripts/bench-view3d-results.json',
  snapshotsPath: 'scripts/bench-view3d-snapshots',
  total: 18,
  // The engine is finished and must stay finished; the goal promises the
  // agent it is re-checked, so it is.
  inheritedScript: 'scripts/bench-roguelike-accept.py'
})

await main(commands, 'usage: node scripts/bench-view3d-run.mjs setup|arm|watch|report|cleanup')
