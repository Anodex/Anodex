import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRun } from '@shared/agentRun.types'
import { seriesIdOf } from '@shared/agentRun.types'
import { createLogger } from '../utils/logger'

const log = createLogger('agent-journal')

/**
 * What an ongoing agent remembers about its own previous runs.
 *
 * A recurring agent that forgets is a cron job with a language model attached.
 * "Pretend you have fifty dollars and grow it in stocks, tracking your picks"
 * only means anything if the run on Tuesday can see what Monday bought and
 * why — otherwise every run starts over and the goal is never actually
 * pursued, only restated.
 *
 * ## Why a file, and why Markdown
 *
 * Because it has to be readable by the person whose agent it is. The value of
 * an unattended run is entirely in being able to check on it afterwards, and
 * a memory you can only inspect through the app that wrote it is one you
 * cannot audit when the app is the thing behaving oddly. It is also the same
 * choice `SkillStore` already made for skills, for the same reason.
 *
 * ## What this is not
 *
 * This is narrative, written by Anodex: what a run was asked to do, and what
 * it said it did. It is deliberately **not** where the agent keeps its own
 * working state. A portfolio is not a fact that accumulates, it is a value
 * that changes, and appending "holds 2 AAPL" after "holds 3 AAPL" produces a
 * history that contradicts itself.
 *
 * The agent's own state belongs in ordinary files in its project folder,
 * which it can already read and write with the tools it already has, and
 * which the user can open, diff and put in git. This journal's job is to make
 * sure the next run knows those files exist and what happened last time.
 */

/** Where a series keeps its journal. */
export function journalPathFor(seriesId: string): string {
  return join(app.getPath('userData'), 'agent-series', seriesId, 'JOURNAL.md')
}

/**
 * Everything written about this series so far, or null when it has no history.
 *
 * Read fresh every time rather than cached, matching `SkillStore`: the file is
 * small, runs are minutes or hours apart, and a stale answer here is a run
 * acting on a portfolio that has since changed.
 */
export function readJournal(seriesId: string): string | null {
  try {
    // Inside the guard for the same reason as the write: `journalPathFor`
    // asks Electron where userData lives, and that throws as readily as the
    // read does. Outside it, a run could not even build its first prompt.
    const path = journalPathFor(seriesId)
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf-8').trim()
    return text.length > 0 ? text : null
  } catch (error) {
    // A journal that cannot be read must not stop the run. Losing continuity
    // degrades the agent; refusing to start removes it.
    log.warn('Could not read the journal for series', seriesId, String(error))
    return null
  }
}

/**
 * Add what a finished run did.
 *
 * Append-only, because the record of what an unattended process did while
 * nobody was watching is worth more than a tidy one. A run that failed is
 * exactly as worth recording as one that succeeded — more so, since the next
 * run should not repeat it.
 */
export function appendRunToJournal(run: AgentRun, at: Date = new Date()): void {
  const seriesId = seriesIdOf(run)
  try {
    // Inside the guard, not above it. `journalPathFor` asks Electron where
    // userData lives, and that call can throw as readily as the write can —
    // which would take the run down through the one path this function
    // promises never to fail.
    const path = journalPathFor(seriesId)
    mkdirSync(join(app.getPath('userData'), 'agent-series', seriesId), { recursive: true })
    appendFileSync(path, renderJournalEntry(run, at), 'utf-8')
  } catch (error) {
    log.warn('Could not write the journal for series', seriesId, String(error))
  }
}

/**
 * One run, as a section.
 *
 * The status is stated plainly rather than implied by the summary's tone,
 * because "stopped" and "done" read almost identically in prose and the next
 * run needs to know which it was. A run that produced no summary says so
 * instead of leaving a blank the next run has to interpret.
 */
export function renderJournalEntry(run: AgentRun, at: Date): string {
  const when = at.toISOString().replace('T', ' ').slice(0, 16)
  const lines = [
    '',
    `## ${when} — ${run.status}`,
    '',
    `- Goal: ${run.goal}`,
    `- Turns used: ${run.turnsUsed}`
  ]
  if (run.flaggedTurns > 0) {
    // Surfaced here on purpose: an unattended run that claimed outcomes it
    // did not produce is the one case where the summary below should not be
    // taken at face value.
    lines.push(
      `- **${run.flaggedTurns} turn(s) claimed an outcome that did not happen** — treat this entry's summary with suspicion.`
    )
  }
  lines.push('')
  lines.push(run.summary?.trim() || '_No summary: the run ended without reporting what it did._')
  if (run.lastError) lines.push('', `Error: ${run.lastError.trim()}`)
  lines.push('')
  return lines.join('\n')
}
