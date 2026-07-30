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
  severityForLevel,
  suggestedFixFor,
  truncate
} from './diagnosticsFormat'
import { appendLogLine, initLogFile } from './logFile'

/**
 * Main-side retention. Independent of the user's own history limit, which the
 * renderer store applies to the merged (main + in-app) list.
 */
const MAX_ENTRIES = 500

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

    this.record(
      {
        severity,
        category: categoryForScope(scope),
        message: formatted.message,
        detail: formatted.detail,
        suggestedFix: suggestedFixFor(`${formatted.message}\n${formatted.detail ?? ''}`, scope),
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
   */
  private onResultError(error: AnodexError): void {
    this.report({
      severity: 'warning',
      category: categoryForScope(error.code),
      message: error.message,
      detail: error.detail ? `code: ${error.code}\n${error.detail}` : `code: ${error.code}`,
      suggestedFix: suggestedFixFor(`${error.message}\n${error.detail ?? ''}`, error.code),
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
      scope: input.scope
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
