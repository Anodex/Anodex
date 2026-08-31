# Benchmark data

Evidence exported out of Anodex's own stores, which belong to the running app
and are pruned by it. Everything here is a copy kept deliberately, because this
project has already lost measurements once: the agent-run records that would
have identified a run of blank trailing assistant messages were cleared before
anyone could read them, and that question stayed unanswerable for days.

## `benchmark-runs.json`

One compact row per run: what produced it, what it cost, how it ended, and
call-level counts. Regenerate with `node scripts/bench-export.mjs`.

Two things about it are load-bearing:

- **`model` is null for runs recorded before provenance existed.** Those cannot
  be attributed and must not be pooled with the rest. Six models were compared
  in a single day with no record of which was which, and every number drawn from
  that comparison was meaningless.
- **`refused` is separate from `faulted`.** A call a guard turned away is Anodex
  working; a fault is Anodex breaking. Pooling them once put a run at "64% of
  tool calls failed" when 91% of those were guards correctly refusing a model
  that repeated itself.

Not transcripts. Those are large, and the questions worth asking later — how
often did this model finish, how much of the budget did it spend, how many calls
were refused — are answered by the counts.

## `overnight-2026-08-31.log`

The unattended pass that produced the matrix: five benchmarks, six models, the
16,384 and 32,768 windows, and a second full pass over the baseline for
variance. Each benchmark is verified against the filesystem immediately after
the run, before the next reset deletes the output — which is how two models were
caught editing the test file to make it pass.
