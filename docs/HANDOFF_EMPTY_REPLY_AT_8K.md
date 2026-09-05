# Handoff — a turn that ends with zero characters at 8K

Written 2026-09-05. This one is **fully diagnosed**. The open question is not
"what is happening" but "is the current behaviour right, and if not, what
replaces it without reintroducing a bug it was built to prevent".

Read §5 before writing any code. A fix was attempted and reverted, and the
reason it was reverted is the most useful thing here.

---

## 1. The symptom

`qwen27b @ 8192`, email matrix, final turn, **reproduced on both passes**:

```
TURN 7/7 | 34s | 0 chars | 2 call(s) | 367 tokens | stop=context-limit | tools: read_email
PROMPT 7: Read the email with message id BOGUS-MESSAGE-ID-99999 and tell me what it says.
```

The user asked a question and the reply was empty. They are not left with
silence — `describeGenerationStop` (`src/renderer/features/chat/generationStopMessages.ts`)
renders "This reply ran out of context space while working" — but they do not
get their answer.

The same shape ended the hard chat rubric's turn 12 in one run of three, so it
is not specific to email.

---

## 2. What is actually happening — settled, from the logs

`boundedChatRunner` already logs everything needed. The failing cycle:

```
[chat:cycle] Bounded cycle ended {
  cycle: 0,
  cycleCeiling: 24,
  stopReason: 'context-limit',
  stopped: true,
  toolCalls: 1,
  fixedTokens: 6388,
  madeProgress: false,        <-- the reason it stopped
  contextEpoch: 1,
  startedContextEpoch: true,  <-- recovery DID start
  continuing: false
}
```

And from the transport, the same turn:

```
inputLimitTokens: 7680, minimumOutput: 983, headroom: 327
proactiveLimitTokens: 6370      (7680 - 983 - 327)
fixedTokens: 6015 -> 6313 -> 6388
```

So, in order:

1. The turn fitted until `read_email` returned.
2. Its result pushed fixed input to **6,388**, over the proactive limit of
   **6,370 — by eighteen tokens**.
3. The transport stopped **proactively** rather than emit a truncated reply.
   This is deliberate (`LlamaVisionService.ts`, search `proactiveLimitTokens`).
4. `boundedChatRunner` **did** build a context epoch (`startedContextEpoch:
true`, `contextEpoch: 1`).
5. It then **discarded it**, because `canContinue` requires
   `madeProgressThisCycle`, and the cycle had produced no visible content and
   no novel tool activity — the `read_email` call errored on a bogus id.

---

## 3. Two wrong diagnoses already made and corrected

Do not repeat these.

- **"`recoveryChurnDetected` blocked recovery."** It cannot.
  `recoveryOnlyCycle` requires a `contextEpoch` to already exist, so on a first
  context-limit stop there is nothing to count.
- **"`epoch: 0` proves recovery never fired."** That `epoch` is
  `LlamaVisionService`'s own per-round counter. `boundedChatRunner`'s is
  `contextEpoch` in the `Bounded cycle ended` line. Two different numbers; the
  logs do not visually distinguish them.

---

## 4. The tempting fix, and why it is wrong

Make a started epoch count as progress:

```ts
const canContinue =
  (recoveredStop || goalStillOpen || stalledWithOpenPlan) &&
  (madeProgressThisCycle || startedContextEpoch) &&   // <-- tempting
  ...
```

This was tried on 2026-09-05. It makes the symptom disappear and **breaks two
existing tests**, both in `src/main/chat/__tests__/boundedChatRunner.test.ts`:

- `does not treat a failed tool call as progress worth another recovery cycle`
- `does not treat an explicitly no-op success as durable progress`

Both assert `toHaveBeenCalledOnce()` on a `context-limit` stop whose only
activity was an error or a no-op. The runner states the rule plainly:

> Error/no-op-only loops remain terminal.

The failing turn **is** an error-only cycle — `read_email` on a deliberately
bogus id. So the observed behaviour is not an oversight; it is the guard doing
what it was built to do. Reverted for that reason.

---

## 5. The actual open question

**Is "error-only cycles are terminal" the right rule when an epoch was started?**

The two cases are genuinely different and the current code cannot tell them
apart:

|                  | what the model was doing                                     | what should happen   |
| ---------------- | ------------------------------------------------------------ | -------------------- |
| the guard's case | looping on a failing call, learning nothing                  | stop — correct today |
| this case        | one legitimate call whose _result size_ exhausted the window | compact and answer   |

In the second, the error is incidental. The reply was lost to arithmetic — over
by eighteen tokens — not to a model going in circles.

Anything that distinguishes them has to be **narrower than "an epoch started"**,
because an epoch starts in both. Candidates, in rough order of how well they
survive the existing tests:

1. **First epoch only.** Allow one continuation when `contextEpochCount === 1`
   and the stop was `context-limit`. A model looping on failures reaches a
   second epoch and stops there. Check this against both tests before writing
   it — they may use a single cycle and pass regardless, which would make this
   safe _and_ untested, so add coverage.
2. **Distinguish "the result was too big" from "the call failed".** The turn had
   `fixedTokens` rising 6,015 → 6,313 → 6,388 across rounds; a call whose result
   _grew_ the context did something, even if it errored. That is real evidence
   of a different situation, and it is already measured.
3. **Revisit the reserve.** 983 `minimumOutput` + 327 `headroom` = 1,310 tokens,
   17% of an 8K window, and this failed by eighteen. Do not touch this without
   reading `minimumViableOutputTokens` in `src/main/llama/localOutputBudget.ts`
   first: the 1,280 floor exists because a round issued with less cannot finish
   a large `write_file`, and a cut-off call is replayed as the same malformed
   request. It is already conditional on the surface having write tools.

---

## 6. Before deciding, weigh whether it is worth fixing at all

**It does not happen at 65,536**, where fixed input is a fraction of the window.
It appeared at 8,192, which today is a stress floor rather than what
`contextSizeFor` recommends for this machine (32,768).

Everything else found at 8K on 2026-09-05 turned out the same way: the budget
starvation, the agent's suite scoring 1 of 6 against 6 of 6, Critical Thinking
reading a tenth of its evidence. A fix here helps users pinned to a small
window; it is invisible to everyone else.

That is an argument about priority, not about correctness. The reply is still
lost, and losing it to eighteen tokens is unsatisfying however small the
audience.

---

## 7. How to reproduce

```bash
node scripts/chat-matrix.mjs <out> qwen27b \
  --script scripts/email-script-matrix.json \
  --criteria scripts/email-criteria.mjs
```

Then read the log for `Bounded cycle ended` around `TURN 7`. It reproduced on
both passes on 2026-09-05, so one run is likely enough to see it — but two runs
agreeing is the bar this repo has learned to use, because a _consistent_ wrong
reading is more convincing than a flaky one, not less.

`scripts/email-criteria.mjs` now reports that turn as `N/A — the turn was cut
short before the model answered` rather than `FAIL`, so the score will read
`9/10 (1 not judged)`. That is the honest reading and it is not the bug; do not
"fix" the rubric back.
