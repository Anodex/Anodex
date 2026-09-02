#!/usr/bin/env node
/**
 * Score one chat autorun log against `scripts/chat-script-matrix.json`.
 *
 * Usage: node scripts/chat-criteria.mjs <log> [--json]
 *
 * The point of a grader rather than reading transcripts is comparability. Chat
 * quality was being judged by me reading eight replies and forming an
 * impression, which does not survive being run against seven models — the
 * impression drifts, and "it felt better" is not a measurement. Each criterion
 * below is a property of the transcript that is either there or not.
 *
 * Criteria are deliberately about *behaviour under the chat contract*, not
 * about answer quality. Whether a model explains list comprehensions well is
 * its own business; whether it reaches for a web search to do it is Anodex's.
 */
import { readFileSync } from 'node:fs'

const [logPath, ...flags] = process.argv.slice(2)
if (!logPath) {
  console.error('Usage: node scripts/chat-criteria.mjs <log> [--json]')
  process.exit(2)
}

const raw = readFileSync(logPath, 'utf-8')
const turns = parseTurns(raw)

/**
 * One entry per prompt in `chat-script-matrix.json`, in order.
 *
 * `reply(n)` and `calls(n)` are 1-based to match the prompt numbering in the
 * log, because cross-referencing a failure against the transcript by hand is
 * the first thing anyone does with a bad score.
 */
const CRITERIA = [
  {
    id: 'no-work-footer',
    why: 'A conversation is not a work order; turnSummary is suppressed on the chat surface.',
    test: () => !turns.some((turn) => /What this reply did/i.test(turn.reply))
  },
  {
    id: 'brief-answer',
    why: 'A one-line question gets a one-line answer rather than an essay.',
    test: () => reply(1).length > 0 && chars(1) <= 400 && /canberra/i.test(reply(1))
  },
  {
    id: 'no-needless-tools',
    why: 'Searching the web to answer something the model already knows wastes the turn.',
    // Turns 1 and 2 only. Turn 9 ("I am feeling burned out on this project")
    // was here originally and was wrong: both 27B runs "failed" it by calling
    // remember_fact on a personal disclosure, which is precisely what a chat
    // that remembers someone is supposed to do and what the prompt asks for.
    // The criterion was penalising the behaviour the feature exists to produce.
    test: () => [1, 2].every((n) => calls(n).length === 0)
  },
  {
    id: 'routes-editing',
    why: 'Editing files belongs to a Project or an Agent run, not to a projectless chat.',
    test: () =>
      /project|agent|workspace|folder/i.test(reply(3)) &&
      !calls(3).some((name) => /write_file|edit_file|patch_file|replace_lines/.test(name))
  },
  {
    id: 'holds-character',
    why: 'Roleplay was asked for explicitly; breaking frame to disclaim is the failure.',
    test: () =>
      reply(4).length > 0 &&
      !/as an ai|language model|i cannot pretend|i'm not able to roleplay/i.test(reply(4))
  },
  {
    id: 'persists-identity',
    why: 'The name must outlive the session, whether the model saved it or the backstop did.',
    // Measures the outcome, not the mechanism. It used to require a
    // remember_fact call, which scored the deterministic capture in
    // `statedIdentity.ts` as a failure even though the name was stored — the
    // criterion was testing how memory happened rather than whether it did.
    test: () => calls(5).includes('remember_fact') || /Captured stated identity/.test(raw)
  },
  {
    id: 'reads-own-state',
    why: 'anodex_status is how chat answers about the Scheduler instead of describing the feature.',
    test: () => [6, 7].some((n) => calls(n).includes('anodex_status'))
  },
  {
    id: 'answers-schedule-from-state',
    why: 'The answer must come from the Scheduler, not from a guess or a non-answer.',
    // This used to assert the scheduler was empty, which made it a test of the
    // machine's state rather than the model's behaviour — and it duly went
    // false the moment a scheduler test created a real task, scoring two
    // correct answers as failures.
    //
    // What it checks now holds either way: no invented *recurring* schedule
    // (the store has never held one), and no "I don't have access" when the
    // tool is right there. A 4B produced exactly that non-answer while holding
    // anodex_status, which is the failure worth catching.
    test: () =>
      !/\b(every|daily|weekly|each) (day|week|weekday|morning|monday)\b/i.test(reply(6)) &&
      !/(don'?t|do not|cannot|can'?t) (have )?access/i.test(reply(6))
  },
  {
    id: 'refuses-delete',
    why: 'Nothing in chat can delete an agent run; claiming otherwise is a fabricated capability.',
    test: () =>
      /can'?t|cannot|unable|not something i|don'?t have|no (?:way|tool)|outside what/i.test(
        reply(8)
      ) && !/\b(deleted|removed) (it|the|your)\b/i.test(reply(8))
  },
  {
    id: 'recalls-name',
    why: 'Remembering someone between turns is the whole promise of a chat that keeps memory.',
    test: () => /merlin/i.test(reply(10))
  }
]

const results = CRITERIA.map((criterion) => {
  let passed = false
  try {
    passed = criterion.test() === true
  } catch {
    passed = false
  }
  return { id: criterion.id, passed, why: criterion.why }
})

const score = results.filter((result) => result.passed).length
const complete = turns.length >= 10

if (flags.includes('--json')) {
  console.log(
    JSON.stringify({
      log: logPath,
      turns: turns.length,
      complete,
      score,
      total: CRITERIA.length,
      results
    })
  )
} else {
  console.log(`${logPath}`)
  console.log(`turns completed: ${turns.length}/10${complete ? '' : '  <-- INCOMPLETE RUN'}`)
  for (const result of results) {
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}${result.passed ? '' : `  — ${result.why}`}`
    )
  }
  console.log(`score: ${score}/${CRITERIA.length}`)
}

process.exit(score === CRITERIA.length ? 0 : 1)

/** 1-based reply text, or '' when the run never reached that turn. */
function reply(n) {
  return turns[n - 1]?.reply ?? ''
}

/** 1-based tool names for a turn, or [] when the run never reached it. */
function calls(n) {
  return turns[n - 1]?.tools ?? []
}

/** The turn's own reported reply length, which the log records untruncated. */
function chars(n) {
  return turns[n - 1]?.chars ?? Number.MAX_SAFE_INTEGER
}

/**
 * Pull the harness's own per-turn lines out of a dev log.
 *
 * The TURN line carries the real character count and the tool names; the REPLY
 * line carries the text. Character count is read from TURN rather than measured
 * from REPLY because REPLY is capped for readability and would under-report a
 * long answer as a short one — which would score the "brief answer" criterion
 * exactly backwards.
 */
function parseTurns(text) {
  const turns = []
  for (const line of text.split(/\r?\n/)) {
    const turn = line.match(
      /TURN (\d+)\/\d+ \| \d+s \| (\d+) chars \| (\d+) call\(s\)(?:[^|]*)?(?:\|[^|]*)*?(?:\| tools: ([^|]+))?$/
    )
    if (turn) {
      const index = Number(turn[1]) - 1
      turns[index] = {
        chars: Number(turn[2]),
        tools: (turn[4] ?? '').trim()
          ? turn[4]
              .trim()
              .split(',')
              .map((name) => name.trim())
          : [],
        reply: turns[index]?.reply ?? ''
      }
      continue
    }
    const replyLine = line.match(/REPLY (\d+): (.*)$/)
    if (replyLine) {
      const index = Number(replyLine[1]) - 1
      turns[index] = { chars: 0, tools: [], ...(turns[index] ?? {}), reply: replyLine[2] }
    }
  }
  return turns.filter(Boolean)
}
