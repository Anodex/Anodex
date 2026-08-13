import type { WebContents } from 'electron'
import type { BlockedRequestReason } from './externalAssetPolicy'

/**
 * Runtime evidence collected while a page is rendered for `inspect_visual`.
 *
 * ## Why this exists
 *
 * Visual inspection used to return pixels and nothing else. When a page failed
 * at runtime the model saw a black rectangle with no reason attached, and its
 * only remaining move was to re-read source files and guess — which is exactly
 * what happened in the driving incident: 51 tool calls, 53% of them
 * zero-yield, and no diagnosis. A screenshot answers "what does it look like";
 * it cannot answer "why". This module supplies the "why".
 *
 * ## The two collection channels, and why both are needed
 *
 * 1. **Electron's `console-message`** — the browser's own diagnostics. Module
 *    resolution failures, CORS refusals, and MIME-type rejections are emitted
 *    by the renderer itself and do **not** pass through the page's `console`
 *    object, so an in-page patch cannot see them. These are precisely the
 *    messages that explain a blank canvas, which makes this channel the single
 *    most valuable one.
 * 2. **The in-page collector** — `window.onerror` stacks, unhandled promise
 *    rejections, subresource `error` events, and canvas/WebGL measurements.
 *    None of these are visible from the main process.
 *
 * Blocked-request records come from the network filter itself (see
 * `externalAssetPolicy.ts`) and are merged in by the caller.
 */

/** An uncaught error, with whatever location information the page reported. */
export interface PageError {
  message: string
  source?: string
  line?: number
  column?: number
  stack?: string
}

/** A subresource that failed to load (`error` event on a script/link/img). */
export interface ResourceFailure {
  url: string
  tag: string
}

/** Measurements for one `<canvas>`, enough to rule dimension and context faults in or out. */
export interface CanvasMetrics {
  id: string
  /** Layout size in CSS pixels. Zero here explains a blank canvas on its own. */
  cssWidth: number
  cssHeight: number
  /** Backing-store size from the `width`/`height` attributes. */
  attrWidth: number
  attrHeight: number
  /** `webgl2`, `webgl`, `2d`, or `none` when no context could be obtained. */
  contextType: string
}

export interface WebglSupport {
  supported: boolean
  vendor?: string
  renderer?: string
}

/** Everything the in-page collector gathers. */
export interface CollectedPageDiagnostics {
  errors: PageError[]
  rejections: string[]
  resourceFailures: ResourceFailure[]
  canvases: CanvasMetrics[]
  webgl: WebglSupport
  readyState: string
}

/** A console line, from either the page or the browser itself. */
export interface ConsoleEntry {
  level: string
  text: string
}

/** A request the network filter refused. */
export interface BlockedRequest {
  url: string
  reason: BlockedRequestReason
}

/** The complete evidence bundle for one inspection. */
export interface PageDiagnostics extends CollectedPageDiagnostics {
  console: ConsoleEntry[]
  blockedRequests: BlockedRequest[]
}

/** Global the injected collector writes into. */
const GLOBAL_KEY = '__anodexDiagnostics'

/**
 * Script injected at the very top of `<head>`, before any page script, so
 * errors thrown during initial module evaluation are captured rather than
 * missed. Written as a self-contained IIFE with no external references — it is
 * serialized into the served HTML, not bundled.
 */
export const DIAGNOSTICS_COLLECTOR_SCRIPT = `
(function () {
  var state = { errors: [], rejections: [], resourceFailures: [] };
  window.${GLOBAL_KEY} = state;

  window.addEventListener('error', function (event) {
    // A subresource that failed to load reports through the same event, but
    // with the element as target and no Error object.
    if (event.target && event.target !== window && event.target.tagName) {
      state.resourceFailures.push({
        url: String(event.target.src || event.target.href || ''),
        tag: String(event.target.tagName).toLowerCase()
      });
      return;
    }
    state.errors.push({
      message: String(event.message || 'Unknown error'),
      source: event.filename ? String(event.filename) : undefined,
      line: typeof event.lineno === 'number' ? event.lineno : undefined,
      column: typeof event.colno === 'number' ? event.colno : undefined,
      stack: event.error && event.error.stack ? String(event.error.stack) : undefined
    });
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    state.rejections.push(
      reason && reason.stack ? String(reason.stack) : String(reason && reason.message ? reason.message : reason)
    );
  });
})();
`

/**
 * Expression evaluated after render to pull the collector's state plus live
 * canvas/WebGL measurements. Measured at read time rather than load time so it
 * reflects the frame that was actually screenshotted.
 */
const READ_DIAGNOSTICS_EXPRESSION = `
(function () {
  var state = window.${GLOBAL_KEY} || { errors: [], rejections: [], resourceFailures: [] };

  function contextType(canvas) {
    // Requesting a context that already exists returns the same one, so this
    // identifies the context in use without creating a conflicting one.
    try { if (canvas.getContext('webgl2')) return 'webgl2'; } catch (e) {}
    try { if (canvas.getContext('webgl')) return 'webgl'; } catch (e) {}
    try { if (canvas.getContext('2d')) return '2d'; } catch (e) {}
    return 'none';
  }

  var canvases = Array.prototype.slice.call(document.querySelectorAll('canvas')).map(function (canvas) {
    var rect = canvas.getBoundingClientRect();
    return {
      id: canvas.id || '(unnamed)',
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      attrWidth: canvas.width,
      attrHeight: canvas.height,
      contextType: contextType(canvas)
    };
  });

  // Probe on a throwaway canvas so an unsupported driver is reported even when
  // the page has no canvas of its own.
  var webgl = { supported: false };
  try {
    var probe = document.createElement('canvas');
    var gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (gl) {
      webgl.supported = true;
      var info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) {
        webgl.vendor = String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL));
        webgl.renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch (e) {}

  return {
    errors: state.errors,
    rejections: state.rejections,
    resourceFailures: state.resourceFailures,
    canvases: canvases,
    webgl: webgl,
    readyState: document.readyState
  };
})()
`

/** Console levels worth reporting; `info`/`debug`/`log` are noise for diagnosis. */
const REPORTED_CONSOLE_LEVELS = new Set(['error', 'warning', 'warn'])

/** Cap per category, so one noisy page cannot flood the model's context. */
const MAX_ENTRIES_PER_CATEGORY = 12

/**
 * Subscribe to the browser's own console output for one render.
 *
 * Electron changed this event's shape: it historically emitted
 * `(event, level, message, line, sourceId)` with a numeric level, and now emits
 * a single details object with a string level. Both are handled so this keeps
 * working across upgrades rather than silently collecting nothing — a silent
 * diagnostics channel is the failure mode this whole change exists to remove.
 */
export function collectConsoleMessages(webContents: WebContents): ConsoleEntry[] {
  const entries: ConsoleEntry[] = []

  webContents.on('console-message', (...args: unknown[]) => {
    const entry = normalizeConsoleEvent(args)
    if (entry && REPORTED_CONSOLE_LEVELS.has(entry.level.toLowerCase())) entries.push(entry)
  })

  return entries
}

function normalizeConsoleEvent(args: unknown[]): ConsoleEntry | null {
  const [first, second, third] = args

  // Current shape: a single details object.
  if (isRecord(first) && typeof first.message === 'string') {
    return {
      level: typeof first.level === 'string' ? first.level : 'info',
      text: first.message
    }
  }
  // Legacy shape: (event, level, message, ...) with a numeric level.
  if (typeof second === 'number' && typeof third === 'string') {
    return { level: LEGACY_CONSOLE_LEVELS[second] ?? 'info', text: third }
  }
  return null
}

/** Legacy numeric console levels, in Electron's original order. */
const LEGACY_CONSOLE_LEVELS: Record<number, string> = {
  0: 'debug',
  1: 'info',
  2: 'warning',
  3: 'error'
}

/** Read the in-page collector's state. Never throws — diagnostics are best-effort. */
export async function readCollectedDiagnostics(
  webContents: WebContents
): Promise<CollectedPageDiagnostics> {
  try {
    const raw: unknown = await webContents.executeJavaScript(READ_DIAGNOSTICS_EXPRESSION)
    if (!isRecord(raw)) return emptyDiagnostics()
    return {
      errors: asArray<PageError>(raw.errors),
      rejections: asArray<string>(raw.rejections),
      resourceFailures: asArray<ResourceFailure>(raw.resourceFailures),
      canvases: asArray<CanvasMetrics>(raw.canvases),
      webgl: isRecord(raw.webgl) ? (raw.webgl as unknown as WebglSupport) : { supported: false },
      readyState: typeof raw.readyState === 'string' ? raw.readyState : 'unknown'
    }
  } catch {
    // A page that navigated away or a destroyed window: the screenshot is
    // still useful, so this degrades instead of failing the whole inspection.
    return emptyDiagnostics()
  }
}

function emptyDiagnostics(): CollectedPageDiagnostics {
  return {
    errors: [],
    rejections: [],
    resourceFailures: [],
    canvases: [],
    webgl: { supported: false },
    readyState: 'unknown'
  }
}

/** Whether anything was found that could explain a broken render. */
export function hasFailureEvidence(diagnostics: PageDiagnostics): boolean {
  return (
    diagnostics.errors.length > 0 ||
    diagnostics.rejections.length > 0 ||
    diagnostics.resourceFailures.length > 0 ||
    diagnostics.blockedRequests.length > 0 ||
    diagnostics.console.some((entry) => entry.level.toLowerCase() === 'error') ||
    diagnostics.canvases.some((canvas) => canvas.cssWidth === 0 || canvas.cssHeight === 0)
  )
}

/**
 * Render the evidence bundle as the text block appended to the tool result.
 *
 * Ordered by diagnostic value, hardest evidence first: an uncaught error names
 * the fault outright, so it leads. The model is told explicitly when there is
 * nothing to find, because "no errors" is itself a result — it rules out the
 * entire class of runtime-exception hypotheses and redirects attention to
 * layout, styling, or data.
 */
export function formatPageDiagnostics(diagnostics: PageDiagnostics): string {
  const lines: string[] = []

  if (diagnostics.errors.length > 0) {
    lines.push('Uncaught errors:')
    for (const error of diagnostics.errors.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      const at = [error.source, error.line, error.column].filter(Boolean).join(':')
      lines.push(`- ${error.message}${at ? ` (at ${at})` : ''}`)
      if (error.stack) lines.push(`  ${firstStackFrames(error.stack)}`)
    }
  }

  if (diagnostics.rejections.length > 0) {
    lines.push('Unhandled promise rejections:')
    for (const rejection of diagnostics.rejections.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      lines.push(`- ${firstStackFrames(rejection)}`)
    }
  }

  if (diagnostics.blockedRequests.length > 0) {
    lines.push('Requests blocked by the inspection sandbox:')
    for (const blocked of diagnostics.blockedRequests.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      lines.push(`- ${blocked.url} (${BLOCK_REASON_TEXT[blocked.reason]})`)
    }
  }

  if (diagnostics.resourceFailures.length > 0) {
    lines.push('Subresources that failed to load:')
    for (const failure of diagnostics.resourceFailures.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      lines.push(`- <${failure.tag}> ${failure.url || '(no url)'}`)
    }
  }

  const consoleErrors = diagnostics.console.slice(0, MAX_ENTRIES_PER_CATEGORY)
  if (consoleErrors.length > 0) {
    lines.push('Console output:')
    for (const entry of consoleErrors) lines.push(`- [${entry.level}] ${entry.text}`)
  }

  if (diagnostics.canvases.length > 0) {
    lines.push('Canvas elements:')
    for (const canvas of diagnostics.canvases.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      const zeroSize = canvas.cssWidth === 0 || canvas.cssHeight === 0
      lines.push(
        `- #${canvas.id}: ${canvas.cssWidth}x${canvas.cssHeight} CSS px, ` +
          `${canvas.attrWidth}x${canvas.attrHeight} backing store, context ${canvas.contextType}` +
          (zeroSize ? ' — ZERO LAYOUT SIZE, nothing can be visible' : '')
      )
    }
  }

  // Only meaningful for a page that actually draws. Reporting driver status
  // for a text page would be noise in the model's context.
  if (diagnostics.canvases.length > 0) {
    if (!diagnostics.webgl.supported) {
      lines.push('WebGL: NOT AVAILABLE in this renderer — any WebGL canvas will stay blank.')
    } else if (diagnostics.webgl.renderer) {
      lines.push(`WebGL: available (${diagnostics.webgl.renderer}).`)
    }
  }

  if (lines.length === 0) {
    return (
      '\n\nRuntime diagnostics: no uncaught errors, blocked requests, or failed ' +
      'subresources were recorded, and every canvas has a non-zero layout size. ' +
      'A runtime exception is ruled out — if the render still looks wrong, the ' +
      'cause is layout, styling, or data, not a script failure.'
    )
  }

  return `\n\nRuntime diagnostics (read this before inspecting the screenshots — it names the fault directly):\n${lines.join('\n')}`
}

const BLOCK_REASON_TEXT: Record<BlockedRequestReason, string> = {
  'not-declared':
    'not declared by the page, so the inspection sandbox refused it — this is an inspection limit, not a defect in the page',
  'private-address': 'refused: points at a loopback or private-network address',
  'unsupported-scheme': 'refused: not an http(s) request'
}

/** Keep a stack readable without spending the model's context on framework frames. */
function firstStackFrames(stack: string, limit = 3): string {
  return stack
    .split('\n')
    .slice(0, limit)
    .map((line) => line.trim())
    .join(' | ')
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
