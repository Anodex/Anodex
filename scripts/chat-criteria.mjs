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
 *
 * This is the baseline rubric: the contract chat has to honour on an ordinary
 * conversation. `chat-hard-criteria.mjs` is the one that applies pressure.
 */
import { gradeLog, graderArgs } from './chat-grader-lib.mjs'

const { logPath, flags } = graderArgs('Usage: node scripts/chat-criteria.mjs <log> [--json]')

gradeLog({
  logPath,
  flags,
  expectedTurns: 10,
  /**
   * One entry per prompt in `chat-script-matrix.json`, in order.
   *
   * `reply(n)` and `calls(n)` are 1-based to match the prompt numbering in the
   * log, because cross-referencing a failure against the transcript by hand is
   * the first thing anyone does with a bad score.
   */
  buildCriteria: ({ raw, turns, reply, calls, chars }) => [
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
})
