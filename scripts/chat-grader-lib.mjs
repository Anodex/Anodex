#!/usr/bin/env node
/**
 * The machinery every chat grader shares: log parsing, turn accessors, and the
 * pass/fail report.
 *
 * There is more than one rubric — `chat-criteria.mjs` scores the chat contract
 * a projectless conversation has to honour, `chat-hard-criteria.mjs` scores the
 * behaviours that only show up under pressure — and both read the same autorun
 * log format. Copying the parser into the second grader is the obvious way to
 * write it and the wrong one: `parseTurns` already carries a fix that is not
 * obvious from reading it (character counts come from the TURN line because the
 * REPLY line is truncated, so measuring the text scores "brief answer" exactly
 * backwards). A second copy starts correct and drifts, and the copy that drifts
 * is the one nobody re-derives that reasoning for.
 *
 * A grader here is therefore only its criteria: what it means for chat to be
 * good, with nothing about how a log is read.
 */
import { readFileSync } from 'node:fs'

/**
 * Run one rubric against one log and exit with the result.
 *
 * `buildCriteria` receives the parsed transcript plus the 1-based accessors, so
 * a rubric never touches the raw log shape. It returns the criteria array; each
 * entry is `{ id, why, test }`, and `why` is printed only on failure because
 * that is the only time anyone needs it.
 *
 * Exits 0 only on a clean sweep. A partial score is a failure: these runs feed
 * a matrix that has to distinguish "this model passes" from "this model mostly
 * passes", and an exit code that softens at 9/10 cannot.
 */
export function gradeLog({ logPath, flags = [], expectedTurns, buildCriteria }) {
  const raw = readFileSync(logPath, 'utf-8')
  const turns = parseTurns(raw)

  /** 1-based reply text, or '' when the run never reached that turn. */
  const reply = (n) => turns[n - 1]?.reply ?? ''
  /** 1-based tool names for a turn, or [] when the run never reached it. */
  const calls = (n) => turns[n - 1]?.tools ?? []
  /** The turn's own reported reply length, which the log records untruncated. */
  const chars = (n) => turns[n - 1]?.chars ?? Number.MAX_SAFE_INTEGER
  /** How many calls the turn made, which is not the length of `calls(n)`. */
  const callCount = (n) => turns[n - 1]?.callCount ?? 0

  const criteria = buildCriteria({ raw, turns, reply, calls, chars, callCount })

  const results = criteria.map((criterion) => {
    let passed = false
    try {
      passed = criterion.test() === true
    } catch {
      // A criterion that throws is a criterion that did not pass. Rubrics index
      // into turns that an aborted run never produced, and a crashed grader
      // reports nothing at all about the nine turns that did happen.
      passed = false
    }
    return { id: criterion.id, passed, why: criterion.why }
  })

  const score = results.filter((result) => result.passed).length
  const complete = turns.length >= expectedTurns

  if (flags.includes('--json')) {
    console.log(
      JSON.stringify({
        log: logPath,
        turns: turns.length,
        complete,
        score,
        total: criteria.length,
        results
      })
    )
  } else {
    console.log(`${logPath}`)
    console.log(
      `turns completed: ${turns.length}/${expectedTurns}${complete ? '' : '  <-- INCOMPLETE RUN'}`
    )
    for (const result of results) {
      console.log(
        `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}${result.passed ? '' : `  — ${result.why}`}`
      )
    }
    console.log(`score: ${score}/${criteria.length}`)
  }

  process.exit(score === criteria.length ? 0 : 1)
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
export function parseTurns(text) {
  const turns = []
  for (const line of text.split(/\r?\n/)) {
    const turn = line.match(
      /TURN (\d+)\/\d+ \| \d+s \| (\d+) chars \| (\d+) call\(s\)(?:[^|]*)?(?:\|[^|]*)*?(?:\| tools: ([^|]+))?$/
    )
    if (turn) {
      const index = Number(turn[1]) - 1
      turns[index] = {
        chars: Number(turn[2]),
        // The TURN line reports how many calls were made *and* a `tools:` list
        // of the distinct names. Those are different numbers whenever a model
        // calls the same tool twice — "2 call(s) | tools: remember_fact" — so a
        // rubric asking "did it call remember_fact twice" has to read the count
        // and cannot get it by measuring the name list.
        callCount: Number(turn[3]),
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
      turns[index] = {
        chars: 0,
        callCount: 0,
        tools: [],
        ...(turns[index] ?? {}),
        reply: replyLine[2]
      }
    }
  }
  return turns
}

/** Read the log path and flags a grader was invoked with. */
export function graderArgs(usage) {
  const [logPath, ...flags] = process.argv.slice(2)
  if (!logPath) {
    console.error(usage)
    process.exit(2)
  }
  return { logPath, flags }
}
