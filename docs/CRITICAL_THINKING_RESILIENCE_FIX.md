# Critical Thinking resilience fix — Log & Plan

**Problem (from user screenshot):** every Critical Thinking run ends on **"The
investigation failed"** with no report; resume fails the same way.

**Root cause:** `CriticalThinkingResearchRunner.run()` has a `try/finally` but
**no `catch`**. When a round's every web search or every fetch fails
(`throwIfEveryOperationFailed`, e.g. a burst of 403s — the documented
18/18-fetch-failure case), the throw unwinds out of `run()` →
`runResearchWaves` → into `CriticalThinkingService.runResearch`'s catch, which
finishes the whole run `failed` with **no report**, discarding every source
earlier steps had already verified. With flaky/blocked fetches, hitting one
all-failed round is near-inevitable, so every run dies. The deterministic
fallback report exists but is only reachable _inside_ `runSynthesis`, which the
throw skips entirely.

## Plan

### Phase 0 — Baseline

- [x] typecheck / lint / test (green before changes — 1418 tests)

### Phase 1 — Fixes

- [x] **A. Runner: a dead round limits its step, never throws.** Replaced
      `throwIfEveryOperationFailed` with a non-throwing `everyOperationFailed`
      predicate; an all-failed search or fetch round now `limitStep('no-progress')`s
      so the wave scheduler continues to other steps and reaches synthesis. The
      specific provider/fetch error is preserved in the per-operation activity log.
- [x] **B. Service: always salvage a report.** New
      `finishWithSalvagedReport(runId, emptyStatus, reason)` builds the deterministic
      fallback report from whatever evidence was verified (same builder + scoring
      `runSynthesis` uses) and finishes `partial` with it; only a run that gathered
      **nothing** reports an outright, actionable failure. `finishAbortedResearch`
      routes the time-out path through the same salvage (it produced no report
      before); a genuine user Stop stays resumable with no forced report.

### Phase 2 — Tests

- [x] Runner: all-failed search / all-failed fetch each limit the step (not throw),
      with the cause preserved in activities. (2 existing throw-expecting tests updated.)
- [x] Service: salvages a fallback report from verified evidence on a synthesis
      throw; reports an actionable failure when nothing was gathered.

### Phase 3 — Verify

- [x] typecheck / lint / test green (1420 tests); committing.

## Findings / notes

- `assertSearchReady` runs at create/approve/resume, so a missing provider is
  NOT the cause here — the failures are runtime search/fetch failures.
- `buildDeterministicFallbackReport` is synchronous (no model call), so salvage
  is cheap and safe even after a time-out.
- Zero-evidence synthesis (`runSynthesis` line ~467) already finishes `partial`
  with an honest "no fetched source" message — left as-is (not a crash).
