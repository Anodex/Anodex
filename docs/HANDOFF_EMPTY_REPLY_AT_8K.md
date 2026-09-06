# Handoff — a turn that ends with zero characters at 8K

Written 2026-09-05. **Fixed the same day; see §5.** Kept as a handoff because
the two wrong diagnoses (§3) and the wrong fix (§4) are the useful part: the
first correct-looking fix breaks a guard that exists for a real reason, and the
distinction that makes the real fix safe is easy to miss.

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

## 5. The fix

**`madeProgressThisCycle` no longer gates continuation when the transport
stopped at a _proactive_ context checkpoint.**

The signal that distinguishes the two cases was already measured and already
plumbed end to end: `RunGenerationResult.contextEpochCause`, set by
`LlamaVisionService` and carried through `runGeneration`.

| cause          | what it means                                                                                                                                                       | progress required? |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `'proactive'`  | the transport stopped **itself** at a safe boundary: newest tool result complete, room left for a reply, handed over expressly so the runner can compact and resume | no — see below     |
| `'in-turn'`    | the model had its rounds and the window filled underneath it                                                                                                        | yes — unchanged    |
| `'loop-guard'` | the loop guard fired                                                                                                                                                | yes — unchanged    |

Read the comment above `proactiveLimitTokens` in `LlamaVisionService.ts`: the
proactive break exists _so that_ "the bounded chat runner can now summarize this
cycle and start a fresh stateless epoch". The runner was throwing that handover
away. Requiring the cycle to prove progress asks it to prove the very thing the
stop pre-empted — the model never got a round in which to act on the result it
had just received.

This is narrower than "an epoch started", which was the wrong fix in §4: an
epoch starts for all three causes. It is also narrower than "first epoch only",
which would have broken both tests too — they are single-cycle `context-limit`
stops, so `contextEpochCount` is 1 in them as well.

### Why it cannot become the loop the guard prevents

Three independent bounds, none of them new:

1. **Once per turn.** `spentProactiveCheckpointRescue` latches when the rescue
   is what actually carried the cycle forward. A second progress-free checkpoint
   means compaction is not buying the model anything.
2. **The next epoch's preflight.** If a rebuilt epoch does not reclaim room, the
   transport reports `'fixed-context-limit'`, which `isRecoverableGenerationStop`
   deliberately excludes. That kills the turn regardless of the rescue.
3. **`recoveryChurnDetected`.** A turn that only re-reads after recovering still
   ends after `MAX_CONSECUTIVE_RECOVERY_ONLY_CYCLES`.

### The agent surface had already made this call

`AgentRunService` does not treat a turn that ended in a context epoch as idle:

> A turn the runtime ended for lack of room is not the model being idle — it
> never got to act — and now that an epoch answers it, the next turn has a real
> chance. Counting it as idleness ended runs after three, including one on
> bench-1 that had already done the work and whose tests passed.

Same failure, same reasoning, reached on the agent surface first. It gets its
own `consecutiveEpochs` counter rather than a rescue latch, because an agent run
takes many turns where a chat turn takes one. No change was needed there; it is
listed here as corroboration that the chat runner was the outlier.

### Coverage

`src/main/chat/__tests__/boundedChatRunner.test.ts`, three added:

- `continues once when the transport handed over at a proactive checkpoint` —
  the driving failure, `read_email` on a bogus id as the cycle's only activity.
- `keeps an in-turn context stop terminal after a failed call` — pins the
  narrowness. This one passes with or without the fix by design; it is a pin,
  not a proof.
- `spends the proactive checkpoint rescue only once in a turn`.

The first and third were confirmed to **fail** with the gate reverted, so they
are not vacuous. The two guard tests from §4 pass unchanged, as does the rest of
`src/main` (2,912 tests).

**Not yet reproduced against a real model.** The unit tests prove the runner's
behaviour; §7's matrix run would confirm it end to end at 8K.

## 5b. The second bug, which only a live run could find

Fixing the stop revealed that the continuation it enables resumes on the
**wrong question**.

The first live run after the fix scored 9/10 with all seven turns answered, and
turn 7 went from 0 characters to 901. But those 901 characters began:

> **What I did:** You asked me to delete the oldest email in your inbox.

That is prompt **6**. Turn 7 spent five cycles hunting for the oldest email
instead of reporting the bad id.

### Why

```ts
history = startedContextEpoch ? baseHistory : [...history, { role: 'user', content: prompt }, ...]
prompt = CHAT_CONTINUE_PROMPT
```

`baseHistory` is the conversation _before_ this reply. A normal continuation
cycle appends the current question to history; the epoch branch is the only path
that does not. So the resumed model's last user message was the previous turn's
question, followed by a bare "Continue exactly where you left off". The real
question survived only as `Objective:` inside the system-prompt handoff — which
`buildContextEpochSystemPrompt` announces as "authoritative for this
continuation", and which a 27B at 8K quietly lost to the conversation's last
user turn.

That word "authoritative" was the tell. It is a claim the prompt structure never
backed: nothing made the objective outrank a real user message sitting later in
the history. Compare `docs/`'s standing note on checks that read a convention
rather than the thing itself — this is the same shape, in a prompt.

### Why it matters more than it looks

This is **pre-existing** and independent of §5 — every context epoch had it. But
§5 makes the path reachable for turns that previously died there, so shipping §5
alone trades an empty reply for a fluent, confident answer to a question nobody
asked. That is arguably worse: the empty reply at least rendered "This reply ran
out of context space while working."

### The fix

`epochContinuePrompt` restates the request verbatim when a cycle resumes after an
epoch. Goal runs never had the bug — `goalContinuePrompt` already names the
standing goal.

Two existing tests asserted the literal string `'Continue exactly where you left
off'` on an epoch cycle. Their comments say what they actually protect: prompt
phrasing must not become "an implicit control channel" — the runner must never
_classify_ the user's wording. Carrying the prompt through verbatim does not
classify it, so the invariant holds and the literal string was only a proxy for
it. Both assertions now pin the invariant directly. **Check this reasoning before
loosening them further** — it is the same judgement call §4 got wrong.

---

## 6. How much this was worth fixing

**It does not happen at 65,536**, where fixed input is a fraction of the window.
It appeared at 8,192, which today is a stress floor rather than what
`contextSizeFor` recommends for this machine (32,768).

Everything else found at 8K on 2026-09-05 turned out the same way: the budget
starvation, the agent's suite scoring 1 of 6 against 6 of 6, Critical Thinking
reading a tenth of its evidence. A fix here helps users pinned to a small
window; it is invisible to everyone else.

That was an argument about priority, not about correctness — which is why it
was fixed anyway. The reply was still lost, and losing it to eighteen tokens is
unsatisfying however small the audience.

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
