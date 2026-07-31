/**
 * Minimal leveled logger for the main process.
 *
 * Kept dependency-free on purpose. Every line is namespaced and timestamped so
 * output is greppable.
 *
 * A single optional sink can be attached with `setLogSink` — that's how
 * `src/main/diagnostics` mirrors every line into the on-disk log file and
 * surfaces warnings/errors in Settings → Diagnostics. The sink is injected
 * rather than imported so this file stays free of `electron`/`node:fs`, which
 * matters because it's pulled in by modules that run under vitest with no
 * Electron app present.
 *
 * The sink sees *every* level, including lines the console gate below drops in
 * a production build — a packaged app's stdout goes nowhere the user can read,
 * so the file log is the only record, and truncating it to `info` would throw
 * away exactly the context a bug report needs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// Quieter by default in production builds.
const minLevel: LogLevel = process.env.NODE_ENV === 'development' ? 'debug' : 'info'

export type LogSink = (level: LogLevel, scope: string, args: unknown[]) => void

let sink: LogSink | null = null
let inSink = false

/**
 * Attach (or with `null`, detach) the secondary log sink. Only one is
 * supported — this is app-level plumbing, not an event bus.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  // `inSink` guards the one shape that would otherwise be fatal: a sink that
  // logs while handling a line, recursing until the stack blows.
  if (sink && !inSink) {
    inSink = true
    try {
      sink(level, scope, args)
    } catch {
      // A broken sink must never take down the caller that was only logging.
    } finally {
      inSink = false
    }
  }

  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}]`
  const consoleSink =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleSink(prefix, ...args)
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Create a namespaced logger, e.g. `createLogger('llama')`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args)
  }
}
