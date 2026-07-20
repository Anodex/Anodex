# Context Reliability Manual Test Guide

Use this guide after the automated suite passes to exercise the real local model,
GPU/runtime, configured search provider, Electron lifecycle, and renderer. These
cases intentionally cover behavior that unit tests cannot reproduce without the
user's model and web credentials.

## Automated Gate

Run from the repository root:

```powershell
npm run test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: every command exits successfully. `format:check` currently reports a
known repository-wide backlog of files; all files in this reliability change are
formatted.

## Test 1: Bounded Tool-Heavy Project Chat

1. Load the normal local model with an 8,192-token context.
2. Set **Max response tokens** to 8,192. This deliberately reproduces the
   previously unsafe full-window request; runtime should clamp it safely.
3. Open the actual Anodex project folder, not an empty test folder.
4. Start a new project chat and send:

```text
Perform a read-only architecture audit of this project. Inspect the main source
directories and at least 12 relevant TypeScript files covering local generation,
context handling, web tools, Critical Thinking, cloud providers, IPC, and tests.
Use the read tools, do not edit files or run destructive commands, avoid rereading
the same range, and finish with the generation flow, context flow, tool flow,
five strengths, five risks, and exact supporting file paths.
```

Pass criteria:

- The UI remains responsive.
- Logs report an effective local output cap no larger than 2,048 tokens for
  this 8K tool-enabled turn, while the context popover explains the clamp.
- Repeated exact/alternating calls are blocked instead of looping indefinitely.
- Oversized, omitted, and non-finite `read_file_range.endLine` values are treated
  as the same effective 200-line range, and results state the next start line.
- The turn finishes or stops with a specific limit message within 15 minutes.
- A limit is not labeled as a user Stop.
- Any streamed partial answer remains in persisted message content after a limit.
- Logs may show deterministic context checkpoints, but should not show repeated
  GPU-backed mid-turn summary generations.
- Reaching the effective output cap is labeled as an output-token limit with
  partial text preserved, not as a successful completion or context crash.

## Test 2: Full Critical Thinking Run

Start a new Critical Thinking investigation with:

```text
Compare the strongest current evidence on why honey-bee, bumblebee, yellowjacket,
paper-wasp, and hornet stings differ in pain, tissue effects, allergic risk, and
repeat-sting behavior. Prefer medical, university, government, and primary sources;
separate well-supported findings from uncertainty and include practical emergency
warning signs. Use evidence current through July 2026.
```

Review the plan, keep four to six focused steps, and start research.

Pass criteria:

- The UI advances one plan step at a time and shows the current zero-based
  persisted round as a one-based label (`Round 1`, `Round 2`, and so on).
- The round visibly moves through Choosing searches, Searching the web, Reading
  selected sources, and Checking evidence coverage. The UI shows at most two of
  the latest remaining gaps instead of model chain-of-thought.
- Query selection and coverage assessment are short, isolated model calls. They
  do not expose `web_search`/`fetch_url` as native model tools and do not build a
  shared research transcript across rounds.
- Search and fetch work can overlap up to the run's pinned concurrency settings;
  an individual provider/page failure does not cancel successful siblings.
- Search leads do not appear as verified pages until `fetch_url` succeeds.
- Evidence count grows while the report remains empty during research.
- A step is not completed merely because the model writes `sufficient`: the
  persisted assessment must have no remaining gaps and either at least two
  verified URLs for `multiple-sources` or at least one for
  `authoritative-primary`.
- `Synthesizing` and `Validating` appear after evidence collection.
- Every substantive prose/list/table block in the final report carries a clickable
  citation to a fetched source; uncited claims force repair or a Partial result.
- A page title containing Markdown characters cannot inject a second link, and a
  chart citation remains valid JSON after citation rendering.
- The run ends as Complete or clearly labeled Partial, never false Complete.
- With the default pinned policy, each active attempt is bounded to three rounds
  per step, 18 rounds/24 searches/36 fetches across the run, 10 minutes per
  active step, and one hour for the active research attempt. The run lifetime is
  also bounded to 100 verified pages. Resume starts a new bounded attempt; it
  does not discard prior rounds/evidence or reset the lifetime page cap.

## Test 3: Stop, Restart, and Resume

1. Start Test 2 again.
2. Wait until the progress row says Searching, Reading, or Checking evidence,
   and at least one artifact has been saved. Click **Stop**.
3. Confirm the run says Stopped and offers **Resume**.
4. Close Anodex during a later active step, then reopen it.
5. Open the same run and click **Resume**.

Pass criteria:

- Existing evidence and completed steps remain present after Stop and restart.
- The interrupted run is labeled Partial/resumable, not Failed or Complete.
- Resume skips completed steps and continues the unfinished persisted round. It
  does not repeat queries or URLs that already have round-owned artifacts.
- The evidence sidecar exists under app data at
  `critical-thinking/evidence/<run-id>.json`.
- The matching run in `critical-thinking/runs.json` retains each round's status,
  queries, selected URLs, evidence IDs, finding, assessment, and timing fields.
- Evidence artifacts record their owning `stepId` and `roundId`; an interrupted
  round can therefore reuse evidence without trusting model prose.

## Test 4: Persisted Sufficiency and Limit Semantics

After Test 2 or Test 3, inspect the selected run in
`critical-thinking/runs.json` and its evidence sidecar.

Pass criteria:

- `researchPolicy` is present on the run and remains unchanged after restart or
  Resume.
- Every plan step has a `rounds` array. Old runs created before this feature still
  open because missing policies and arrays are normalized to safe defaults.
- A completed step's final round has a structured assessment. A `continue`
  verdict preserves gaps and may seed novel follow-up queries.
- Search artifacts are bounded leads; only successful fetch artifacts contribute
  verified passages and citation support.
- Two consecutive rounds that fetch no verified page stop that step as
  no-progress rather than searching forever.
- A round/search/fetch/time limit is recorded as a limit reason, not as a user
  Stop or successful completion. Evidence collected before the limit remains in
  the sidecar and can still support a Partial report.
- Reaching the lifetime page cap records `evidence-limit`; additional collection
  is disabled, while retrying synthesis from retained evidence remains possible.
- The activity list retains a bounded history. The UI initially renders only the
  latest 20 entries and offers a control for earlier retained entries.

## Test 5: Small-Context Failure Semantics

1. Set the local context to 4,096 tokens.
2. Start a fresh project chat and send the Test 1 prompt.

Pass criteria:

- If fixed instructions/tools cannot fit, the reply says so before decoding.
- If the turn later runs out of context, partial text and completed tool work stay
  visible with a context-limit notice. If the safety budget stops repeated
  compaction first, the notice identifies the context-compaction limit instead.
- The app does not say that the user stopped the run.
- Starting a new short chat afterward still works; the session is not wedged.

## Useful Log Signals

Healthy context-shift logs include a bounded count of folded exchanges/tool
results and a non-zero deterministic checkpoint when evidence was folded. Treat
any of these as failures to investigate:

- repeated zero-token checkpoints while tool results are being removed;
- the same search/fetch cycle continuing after the loop guard threshold;
- `The provided context shift strategy did not return a history that fits` on
  ordinary prompts;
- an 8K tool-enabled turn accepting an 8K effective output allowance after
  system and tool-schema tokens are already counted;
- a provider-round, tool, time, or context limit presented as successful
  completion;
- report URLs that do not exist in the fetched evidence sidecar.

For Critical Thinking specifically, healthy runs show isolated model phases and
persisted research checkpoints. Treat a query/assessment phase that accumulates
prior native tool calls, repeats already persisted round queries, advances before
the evidence sidecar is flushed, or accepts `sufficient` without the service-side
evidence floor as a regression.
