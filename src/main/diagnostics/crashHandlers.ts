/**
 * Process-level failure capture.
 *
 * These are the failures that previously left no trace at all: an unhandled
 * rejection deep in a service, the renderer dying, or the native inference child
 * process being killed. Each becomes a real Diagnostics entry with a suggested
 * next step, and lands in the log file synchronously in case the process is
 * about to go down.
 */

import { app } from 'electron'
import { diagnosticsReporter } from './DiagnosticsReporter'
import { suggestedFixFor } from './diagnosticsFormat'

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack?.trim() || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function headlineOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name
  const [line] = describe(value).split('\n')
  return line || 'Unknown failure'
}

/** Wire process/app-level crash reporting. Call once, before the first window. */
export function registerCrashHandlers(): void {
  // Node would exit the process on an uncaught exception; Electron's default is
  // to keep running. We keep that behavior deliberately — a stray rejection in
  // one subsystem shouldn't close a window full of the user's work — but record
  // it loudly, since it does mean some operation silently didn't finish.
  process.on('uncaughtException', (error) => {
    const detail = describe(error)
    diagnosticsReporter.report({
      severity: 'error',
      category: 'runtime',
      message: `Unhandled error: ${headlineOf(error)}`,
      detail,
      suggestedFix:
        suggestedFixFor(detail) ??
        'An operation failed partway through. If the app now behaves oddly, restart it and send this log.',
      scope: 'uncaught'
    })
  })

  process.on('unhandledRejection', (reason) => {
    const detail = describe(reason)
    diagnosticsReporter.report({
      severity: 'error',
      category: 'runtime',
      message: `Unhandled promise rejection: ${headlineOf(reason)}`,
      detail,
      suggestedFix:
        suggestedFixFor(detail) ??
        'A background task failed without reporting. If a feature stopped responding, restart it and send this log.',
      scope: 'uncaught'
    })
  })

  // The window itself died. The live broadcast has nowhere to go, which is why
  // the reporter keeps a ring buffer — the reloaded window replays it.
  app.on('render-process-gone', (_event, _webContents, details) => {
    diagnosticsReporter.report({
      severity: 'error',
      category: 'runtime',
      message: `The app window stopped unexpectedly (${details.reason})`,
      detail: `reason: ${details.reason}\nexitCode: ${details.exitCode}`,
      suggestedFix:
        details.reason === 'oom'
          ? 'The window ran out of memory. Very long conversations are the usual cause — start a new chat, or archive old ones.'
          : 'Reopen the window. If this repeats, send this log file with the steps that led to it.',
      scope: 'renderer'
    })
  })

  // Covers the GPU process and any utility child — including the native
  // inference backend, whose crashes are this project's known hardware-specific
  // failure mode.
  app.on('child-process-gone', (_event, details) => {
    const clean = details.reason === 'clean-exit'
    diagnosticsReporter.report({
      severity: clean ? 'warning' : 'error',
      category: details.type === 'GPU' ? 'runtime' : 'model',
      message: `A ${details.type} process stopped (${details.reason})`,
      detail: `type: ${details.type}\nreason: ${details.reason}\nexitCode: ${details.exitCode}${
        details.name ? `\nname: ${details.name}` : ''
      }`,
      suggestedFix: clean
        ? undefined
        : 'If this happened while loading or running a model, reload it with GPU layers set to 0 in Settings → AI Models — a clean CPU-only load points at the GPU backend or driver.',
      scope: 'child-process'
    })
  })
}
