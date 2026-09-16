/**
 * Main-process half of the Diagnostics report.
 *
 * Every `createLogger` line in the main process funnels through here (via
 * `setLogSink`) and lands in two places:
 *   1. the rotating on-disk log file — every level, full stacks, the artifact to
 *      attach to a bug report;
 *   2. Settings → Diagnostics — warnings and errors only, pushed live to open
 *      windows and replayed from a ring buffer for windows that open (or
 *      reload, or crash and come back) after the fact.
 *
 * Point 2's ring buffer is the load-bearing part: startup failures and renderer
 * crashes happen when there is no window listening, and those are exactly the
 * failures a user needs to see.
 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { IpcChannel } from '@shared/ipc'
import { setResultErrorReporter, type AnodexError } from '@shared/result'
import type { DiagnosticEntry } from '@shared/settings.types'
import { broadcastToWindows } from '../broadcast'
import { setLogSink, type LogLevel } from '../utils/logger'
import {
  MAX_DETAIL_CHARS,
  categoryForScope,
  formatLogArgs,
  formatLogLine,
  severityForConnection,
  severityForLevel,
  subsystemOf,
  suggestedFixFor,
  truncate
} from './diagnosticsFormat'
import { appendLogLine, initLogFile } from './logFile'

/**
 * Main-side retention. Independent of the user's own history limit, which the
 * renderer store applies to the merged (main + in-app) list.
 */
const MAX_ENTRIES = 500

/**
 * How close two records have to be before they are taken to be one failure.
 *
 * Every IPC handler follows the same shape: `log.warn(...)` and then
 * `return err(...)` in the same catch block, microseconds apart. A second is
 * enormous next to that gap and tiny next to the gap between two real failures.
 */
const SAME_EVENT_MS = 1000

/**
 * How much of a returned failure's detail has to appear in a log line before
 * the two are called the same event. Short strings like "Not found" turn up in
 * unrelated places, and merging the wrong pair loses a real failure.
 */
const MIN_MATCH_CHARS = 12

export interface ReportInput {
  severity: DiagnosticEntry['severity']
  category: DiagnosticEntry['category']
  message: string
  detail?: string
  suggestedFix?: string
  /** Logger scope this came from, shown next to the category in the UI. */
  scope?: string
}

class DiagnosticsReporter {
  private entries: DiagnosticEntry[] = []
  private started = false

  /**
   * Open the log file and start capturing. Call as early in startup as
   * possible — before other subsystems init, so their failures are recorded.
   */
  init(): void {
    if (this.started) return
    this.started = true

    initLogFile()
    appendLogLine(
      `\n=== Anodex ${app.getVersion()} — session started ${new Date().toISOString()} ` +
        `(electron ${process.versions.electron}, node ${process.versions.node}, ` +
        `${process.platform}/${process.arch}) ===\n`
    )

    setLogSink((level, scope, args) => this.onLog(level, scope, args))
    setResultErrorReporter((error) => this.onResultError(error))
  }

  private onLog(level: LogLevel, scope: string, args: unknown[]): void {
    const timestamp = Date.now()
    const formatted = formatLogArgs(args)

    // The file takes every level, untruncated.
    appendLogLine(formatLogLine(timestamp, level, scope, formatted))

    const severity = severityForLevel(level)
    if (!severity) return

    const text = `${formatted.message}\n${formatted.detail ?? ''}`
    this.record(
      {
        severity: severityForConnection(severity, text, scope),
        category: categoryForScope(scope),
        message: formatted.message,
        detail: formatted.detail,
        suggestedFix: suggestedFixFor(text, scope),
        scope
      },
      timestamp
    )
  }

  /**
   * Record a failure returned to the renderer through `err()`. Reported as a
   * warning, not an error: many are ordinary conditions ("no workspace
   * selected", "that file no longer exists") rather than something broken. The
   * value is the detail — the renderer only ever receives a short sentence, so
   * without this the technical cause was reaching nobody at all.
   *
   * One failure, one entry. Handlers log the cause and then return it, so a
   * single `catch` produced two rows in Diagnostics: the logger's, filed under
   * its scope, and this one, filed under the error code. Same event, read by
   * the user as two things wrong. When the log line is already there this
   * attaches the code to it instead of adding a second row. The log *file*
   * still takes both lines — it is the complete record, and the codes are what
   * a support report is read by.
   */
  private onResultError(error: AnodexError): void {
    const text = `${error.message}\n${error.detail ?? ''}`

    const alreadyLogged = this.findRecentRecordOf(error)
    if (alreadyLogged) {
      appendLogLine(
        formatLogLine(Date.now(), 'warn', error.code, {
          message: error.message,
          detail: error.detail
        })
      )
      this.attachCode(alreadyLogged, error.code)
      return
    }

    this.report({
      severity: severityForConnection('warning', text, error.code),
      category: categoryForScope(error.code),
      message: error.message,
      detail: error.detail ? `code: ${error.code}\n${error.detail}` : `code: ${error.code}`,
      suggestedFix: suggestedFixFor(text, error.code),
      scope: error.code
    })
  }

  /**
   * Record a diagnostic raised directly rather than through a logger — crash
   * handlers, which have structured context a log line would flatten.
   */
  report(input: ReportInput): void {
    const timestamp = Date.now()
    appendLogLine(
      formatLogLine(
        timestamp,
        input.severity === 'error' ? 'error' : 'warn',
        input.scope ?? 'app',
        {
          message: input.message,
          detail: input.detail
        }
      )
    )
    this.record(input, timestamp)
  }

  /**
   * The log line this returned failure came from, if it was written moments ago.
   * Matched on the detail — `toErrorMessage(error)` in the handler, the same
   * string the logger was handed — rather than on the message, because the two
   * messages are deliberately different: one is for a developer reading a log,
   * the other for a person reading a dialog.
   */
  private findRecentRecordOf(error: AnodexError): DiagnosticEntry | undefined {
    const detail = error.detail?.trim()
    if (!detail || detail.length < MIN_MATCH_CHARS) return undefined

    const cutoff = Date.now() - SAME_EVENT_MS
    // `entries` is newest-first, so this finds the closest match, not the oldest.
    return this.entries.find(
      (entry) =>
        entry.timestamp >= cutoff && `${entry.message}\n${entry.detail ?? ''}`.includes(detail)
    )
  }

  /** Put the failure code on an entry that was recorded without one. */
  private attachCode(entry: DiagnosticEntry, code: string): void {
    const line = `code: ${code}`
    if (entry.detail?.includes(line)) return
    entry.detail = truncate(entry.detail ? `${line}\n${entry.detail}` : line, MAX_DETAIL_CHARS)
    broadcastToWindows(IpcChannel.Diagnostics.entry, entry)
  }

  /**
   * Note that an operation has succeeded, so its earlier failures stop asking
   * for attention.
   *
   * Diagnostics had no way to hear good news. A mailbox that failed to connect
   * and connected a minute later left the failure counted as unresolved for the
   * rest of the session — the count only ever went up, and the page said
   * "needs attention" about something that had already fixed itself. 0.9.21
   * softened one case of this at the moment of recording (a network blip is not
   * a fault); this is the general shape, after the fact.
   *
   * Matched by scope prefix, because an entry's scope is either the logger's
   * (`email:imap`) or the failure code (`email.sync-failed`) and `email`
   * catches both. Resolving is deliberately broad: if the subsystem is working
   * now, its older complaints are stale whatever they said.
   */
  resolved(...operations: string[]): void {
    const at = Date.now()
    for (const entry of this.entries) {
      if (entry.resolvedAt !== undefined) continue
      // `info` is already not counted as a fault; leave it as plain history.
      if (entry.severity === 'info') continue
      const scope = subsystemOf(entry.scope)
      if (!scope || !operations.some((op) => scope === op || scope.startsWith(op))) continue
      entry.resolvedAt = at
      broadcastToWindows(IpcChannel.Diagnostics.entry, entry)
    }
  }

  private record(input: ReportInput, timestamp: number): void {
    const entry: DiagnosticEntry = {
      id: randomUUID(),
      timestamp,
      severity: input.severity,
      category: input.category,
      message: input.message,
      // The in-app entry is capped; the file above holds the whole thing.
      detail: input.detail ? truncate(input.detail, MAX_DETAIL_CHARS) : undefined,
      suggestedFix: input.suggestedFix,
      source: 'main',
      scope: input.scope,
      appVersion: app.getVersion()
    }

    this.entries.unshift(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES

    broadcastToWindows(IpcChannel.Diagnostics.entry, entry)
  }

  /**
   * Every main-process warning/error since launch, newest first. A window calls
   * this on mount so it picks up whatever happened before it existed.
   */
  list(): DiagnosticEntry[] {
    return [...this.entries]
  }

  /**
   * Mark a clean exit. Writes are synchronous, so there is nothing to flush —
   * the value here is the marker itself: a session with no "ended" line was
   * killed rather than quit, which is the first thing worth knowing when
   * reading a log about a crash.
   */
  shutdown(): void {
    appendLogLine(`=== session ended ${new Date().toISOString()} ===\n`)
  }
}

export const diagnosticsReporter = new DiagnosticsReporter()
