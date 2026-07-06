/**
 * Minimal leveled logger for the main process.
 *
 * Kept dependency-free on purpose. Every line is namespaced and timestamped so
 * output is greppable; swap the sink here if file logging is needed later.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// Quieter by default in production builds.
const minLevel: LogLevel = process.env.NODE_ENV === 'development' ? 'debug' : 'info'

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}]`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(prefix, ...args)
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
