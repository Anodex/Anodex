/**
 * Pure formatting/classification helpers behind the main-process diagnostics
 * report. Kept separate from `DiagnosticsReporter`/`logFile` (which own the
 * `electron`- and `fs`-coupled side) so the interesting logic — what a raw
 * `log.error('...', err)` call turns into on screen — is unit-testable, the same
 * split `agentBudgets.ts` and `tokenActivityMath.ts` already use.
 */

import type { DiagnosticEntry } from '@shared/settings.types'
import type { LogLevel } from '../utils/logger'

type Category = DiagnosticEntry['category']

/** Headline length — the summary line in Settings → Diagnostics stays one line. */
const MAX_MESSAGE_CHARS = 180
/** Detail cap for the in-app entry. The log file keeps the untruncated text. */
export const MAX_DETAIL_CHARS = 2000

/**
 * Logger scope → which Diagnostics category the failure belongs under.
 * Ordered: the first match wins, so more specific prefixes go first.
 */
const SCOPE_CATEGORIES: Array<[RegExp, Category]> = [
  // Local inference: the engine, model files, downloads, embeddings, vision.
  [/^(llama|scanner|downloader|model-reliability|hf-catalog|embedding-service|vision)/, 'model'],
  // Cloud LLM providers.
  [/^(anthropic|openai|cloud-provider)/, 'provider'],
  // External services Anodex connects out to.
  [/^(email|mcp|github)/, 'integration'],
  // On-disk state: stores, the workspace, the code index.
  [
    /^(workspace|conversations|conversation-assets|projects|project-memory|memory-store|skill-store|skill-catalog|change-catalog|critical-thinking-store|critical-thinking-evidence|agent-run-store|scheduler-store|settings|token-activity|code-index|visual-preview-assets)/,
    'file'
  ],
  // Everything else in the running app: window/terminal/services/IPC.
  [
    /^(main|window|terminal|keep-awake|toast-window|context-menu|updater|ipc:|agent-run-service|scheduler-service|critical-thinking-service|code-indexer)/,
    'runtime'
  ]
]

/** Classify a logger scope (`createLogger('llama:vision')`) for the UI. */
export function categoryForScope(scope: string): Category {
  for (const [pattern, category] of SCOPE_CATEGORIES) {
    if (pattern.test(scope)) return category
  }
  return 'general'
}

/** Warnings and errors reach the Diagnostics page; everything reaches the file. */
export function severityForLevel(level: LogLevel): DiagnosticEntry['severity'] | null {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  return null
}

function describeError(error: Error): string {
  const stack = typeof error.stack === 'string' ? error.stack.trim() : ''
  // A stack normally already begins with "Name: message", so prefer it whole.
  if (stack) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined ? stack : `${stack}\nCaused by: ${describeUnknown(cause)}`
  }
  return `${error.name}: ${error.message}`
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return describeError(value)
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return String(value)
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(
      value,
      (_key, inner: unknown) => {
        if (inner instanceof Error) return describeError(inner)
        if (typeof inner === 'bigint') return inner.toString()
        if (typeof inner === 'object' && inner !== null) {
          if (seen.has(inner)) return '[circular]'
          seen.add(inner)
        }
        return inner
      },
      2
    )
  } catch {
    // Even the circular-safe replacer can fail (a throwing getter, a BigInt in
    // an exotic position). Name the type rather than emitting "[object Object]".
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name
    return `[unserializable ${typeof name === 'string' ? name : 'value'}]`
  }
}

/** Cut `text` to `max` characters, marking that something was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… truncated (${text.length - max} more characters — see the full log file)`
}

export interface FormattedLog {
  /** One-line headline for the entry. */
  message: string
  /** Stacks and structured context, untruncated. */
  detail?: string
}

/**
 * Turn a `log.error('Failed to load model:', err, { path })`-shaped call into a
 * headline plus detail. The first string argument becomes the headline (that's
 * how every call site in this codebase is written); Errors and objects become
 * the detail, with stacks kept intact.
 */
export function formatLogArgs(args: unknown[]): FormattedLog {
  const details: string[] = []
  let message: string | null = null

  for (const arg of args) {
    if (message === null && typeof arg === 'string') {
      message = arg
      continue
    }
    details.push(describeUnknown(arg))
  }

  if (message === null) {
    // No string argument at all — promote the first value's own description.
    const [first, ...rest] = details
    message = first ? firstLine(first) : 'Unknown event'
    const detail = [first, ...rest].filter(Boolean).join('\n\n')
    return { message: headline(message), detail: detail || undefined }
  }

  return {
    message: headline(message),
    detail: details.length > 0 ? details.join('\n\n') : undefined
  }
}

function firstLine(text: string): string {
  const [line] = text.split('\n')
  return line ?? text
}

function headline(text: string): string {
  // Call sites end the human part with ':' before the error argument.
  const trimmed = firstLine(text).trim().replace(/:$/, '')
  return trimmed.length > MAX_MESSAGE_CHARS
    ? `${trimmed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : trimmed || 'Unknown event'
}

/**
 * Actionable next step for the failures whose fix is genuinely knowable from
 * the text. Deliberately short and conservative — a wrong suggestion is worse
 * than none, so anything ambiguous gets no hint and the user reads the detail.
 */
const FIXES: Array<[RegExp, string]> = [
  [
    /out of memory|cuda error|vram|failed to allocate|ggml_backend|device memory/i,
    'The model likely does not fit in GPU memory. In Settings → AI Models, lower GPU layers (0 forces CPU-only) or choose a smaller quantization.'
  ],
  [
    /process (exited|gone|crashed)|SIGSEGV|SIGABRT|native crash|exit code 3221225477/i,
    'The native inference process stopped. Reload the model with GPU layers set to 0 in Settings → AI Models — if it loads CPU-only, the GPU backend or driver is the cause.'
  ],
  [
    /\b(401|403)\b|invalid[_ ]api[_ ]key|unauthorized|authentication failed/i,
    'The service rejected the credential. Re-enter the API key in Settings → AI Models → Provider connections, or re-link the account.'
  ],
  [
    /\b429\b|rate limit|quota|insufficient_quota|too many requests/i,
    'The provider is rate-limiting or out of quota. Wait and retry, or switch to another provider or the local model.'
  ],
  [
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i,
    'The request never reached the service. Check the network connection, and any VPN or firewall that might block it.'
  ],
  [
    /EACCES|EPERM|operation not permitted|access is denied/i,
    'Anodex does not have permission for that path. Check the folder permissions, or move the project somewhere your user account owns.'
  ],
  [/ENOSPC|no space left/i, 'The disk is full. Free up space, then retry.'],
  [
    /ENOENT|no such file or directory|not found on disk/i,
    'A file Anodex expected is missing or was moved. Re-select it (models: Settings → AI Models; projects: the project folder picker).'
  ],
  [
    /EMFILE|too many open files/i,
    'Too many files are open at once. Restart Anodex; if it recurs on a large project, narrow the workspace folder.'
  ],
  [
    /JSON|unexpected token|corrupt|malformed/i,
    'A stored file could not be parsed. The detail names it — moving that file aside lets Anodex rebuild it from defaults.'
  ]
]

/** Best-effort suggested next step, or undefined when nothing is confidently known. */
export function suggestedFixFor(text: string): string | undefined {
  for (const [pattern, fix] of FIXES) {
    if (pattern.test(text)) return fix
  }
  return undefined
}

/** Render one line for the on-disk log file. Stacks stay multi-line, indented. */
export function formatLogLine(
  timestamp: number,
  level: LogLevel,
  scope: string,
  formatted: FormattedLog
): string {
  const head = `[${new Date(timestamp).toISOString()}] [${level.toUpperCase()}] [${scope}] ${formatted.message}`
  if (!formatted.detail) return `${head}\n`
  const indented = formatted.detail
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
  return `${head}\n${indented}\n`
}
