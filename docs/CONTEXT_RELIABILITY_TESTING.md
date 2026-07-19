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
2. Open the actual Anodex project folder, not an empty test folder.
3. Start a new project chat and send:

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
- Repeated exact/alternating calls are blocked instead of looping indefinitely.
- The turn finishes or stops with a specific limit message within 15 minutes.
- A limit is not labeled as a user Stop.
- Logs may show deterministic context checkpoints, but should not show repeated
  GPU-backed mid-turn summary generations.

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

- The UI advances one plan step at a time and shows step X/Y.
- Search leads do not appear as verified pages until `fetch_url` succeeds.
- Evidence count grows while the report remains empty during research.
- `Synthesizing` and `Validating` appear after evidence collection.
- The final report contains clickable citations only to fetched sources.
- The run ends as Complete or clearly labeled Partial, never false Complete.
- Runtime is bounded by 10 minutes per step and one hour total.

## Test 3: Stop, Restart, and Resume

1. Start Test 2 again.
2. After at least one fetched page, click **Stop**.
3. Confirm the run says Stopped and offers **Resume**.
4. Close Anodex during a later active step, then reopen it.
5. Open the same run and click **Resume**.

Pass criteria:

- Existing evidence and completed steps remain present after Stop and restart.
- The interrupted run is labeled Partial/resumable, not Failed or Complete.
- Resume skips completed steps and continues the unfinished step.
- The evidence sidecar exists under app data at
  `critical-thinking/evidence/<run-id>.json`.

## Test 4: Small-Context Failure Semantics

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
- a provider-round, tool, time, or context limit presented as successful
  completion;
- report URLs that do not exist in the fetched evidence sidecar.
