# Critical Thinking quality fixes — fetch signature & assessment validation

Follow-up to the resilience fix (`b18ad98`). Two issues investigated after the
runs stopped crashing empty: why web fetches fail, and why the local model's
coverage assessments kept being rejected as invalid.

## Issue 2 — assessment JSON rejected as invalid (the bigger win)

**Symptom:** most steps showed "A valid evidence coverage assessment is still
required," never reached `sufficient`, and burned rounds until a budget limit.

**Root cause:** `parseResearchAssessment` gated `valid` on
`isNonEmptyStringArray(uncertainties) && ...(remainingGaps) && ...(nextQueries)`.
That helper is vacuously true for `[]`, so it didn't reject _empty_ arrays — it
rejected **missing keys** and format drift. A local model producing the correct
"sufficient, no gaps" decision typically **omits** `remainingGaps`/`nextQueries`
entirely (the assessment prompt itself says to leave `nextQueries` empty when
sufficient), and often writes `"Sufficient"` / `"multiple sources"`. All of
those failed validation → `assessment` came back null → the step could never be
marked sufficient and instead surfaced that gap message every round.

**Fix (`criticalThinkingResearchOutput.ts`):**

- `valid` now requires only the core structured decision — a recognized
  `verdict` and `evidenceBasis` plus `finding` and `rationale`. The gap/query/
  uncertainty arrays are supplementary, not validity gates. The
  verified-source-count check in `assessmentIsSufficient` still guards actual
  completion, so a model can't shortcut to "sufficient" without the sources.
- `validVerdict`/`validEvidenceBasis` normalize formatting drift via
  `normalizeEnumToken` (lowercase, trim, spaces/underscores → hyphens, strip
  trailing punctuation). No synonym invention — only formatting is forgiven, so
  a genuinely different value (`"maybe"`, `"a little"`) still fails.
- Tests: sufficient-with-omitted-keys accepted; `"Sufficient."` /
  `"Multiple Sources"` normalized; unrecognized values still rejected.

## Issue 1 — web fetches 403'd (partial lever)

**Findings:** the earlier header fix (`5ff8143`) added `User-Agent` / `Accept` /
`Accept-Language`, which handles the most basic UA-based blocking. Verified
empirically that Node's `fetch` (undici) **forwards** `Sec-Fetch-*` and
`Sec-Ch-Ua*` client-hint headers rather than stripping them like a browser
would — so sending a fuller, coherent Chrome navigation signature is a real
(not no-op) improvement against WAFs that additionally check those.

**Fix (`webTools.ts`):** expanded `FETCH_HEADERS` to a current, internally
consistent Chrome profile (UA + matching `Sec-Ch-Ua` major version, plus
`Sec-Fetch-*`, `Sec-Ch-Ua-Mobile/Platform`, `Upgrade-Insecure-Requests`),
bumped the stale Chrome major (124 → 133).

**Unavoidable limits (documented in-code):** undici forces `Sec-Fetch-Mode:
cors` (real navigations send `navigate`), and JavaScript-challenge sites
(Cloudflare interstitials, etc.) cannot be passed by any static header set —
those need a real browser engine and are simply unfetchable at this layer.
Combined with the resilience fix, sites that _do_ respond now feed a report;
sites behind a JS wall are skipped without killing the run.

## Gate

typecheck + lint clean, 142 files / 1423 vitest (3 new).
