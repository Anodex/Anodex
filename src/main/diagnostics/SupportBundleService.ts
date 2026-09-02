import { app } from 'electron'
import { readFileSync } from 'node:fs'
import type { DiagnosticEntry } from '@shared/settings.types'
import type { EngineState } from '@shared/model.types'
import type { HardwareInfo, SystemInfo } from '@shared/system.types'
import type { SupportBundlePreview } from '@shared/supportBundle.types'
import { llamaService } from '../llama/LlamaService'
import { getHardware } from '../ipc/system.handlers'
import { diagnosticsReporter } from './DiagnosticsReporter'
import { getLogFileInfo } from './logFile'

const MAX_DIAGNOSTICS = 50
const MAX_LOG_CHARS = 64 * 1024

export interface RedactedText {
  text: string
  replacements: number
}

interface SupportBundleInput {
  createdAt: Date
  system: SystemInfo
  hardware: HardwareInfo
  engine: EngineState
  diagnostics: DiagnosticEntry[]
  logText: string
}

/**
 * Removes the kinds of data that must never be carried in a support report.
 * This is intentionally conservative: an opaque URL or absolute local path is
 * less useful than accidentally exporting private project or account data.
 */
export function redactSupportText(value: string): RedactedText {
  let replacements = 0
  const replace = (pattern: RegExp, replacement: string): void => {
    value = value.replace(pattern, () => {
      replacements += 1
      return replacement
    })
  }

  replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
  // The optional quote after the name matters: settings and most logged
  // payloads are JSON, where a quote sits between the key and its colon. This
  // matched `apiKey=secret` and missed `"apiKey": "secret"` - the form that
  // actually occurs.
  replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b["']?\s*([:=])\s*["']?[^\s"',}]+/gi,
    '<credential>=<redacted>'
  )
  // Every provider Anodex can be configured with, not only those starting
  // `sk`. `gsk` is listed separately because a word boundary cannot match
  // inside `gsk_`, so Groq keys passed through untouched. Mistral has no
  // distinctive prefix and relies on the rule above.
  replace(
    /\b(?:sk|gsk|hf|ghp|github_pat|xox[baprs]|AIza|tvly|xai|BSA)[A-Za-z0-9_-]{10,}\b/g,
    '<redacted>'
  )
  replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
  replace(/\b[A-Za-z]:\\[^\s"'`]+/g, '<path>')
  replace(/(?:file:\/\/)?\/(?:Users|home|var\/folders|tmp)\/[^\s"'`]+/g, '<path>')
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>')

  return { text: value, replacements }
}

export function buildSupportBundle(input: SupportBundleInput): SupportBundlePreview {
  let redactionCount = 0
  const redact = (value: string | undefined): string => {
    if (!value) return ''
    const result = redactSupportText(value)
    redactionCount += result.replacements
    return result.text
  }
  const diagnostics = input.diagnostics.slice(0, MAX_DIAGNOSTICS)
  const sanitizedDiagnostics = diagnostics.map((entry) => ({
    ...entry,
    message: redact(entry.message),
    detail: redact(entry.detail),
    suggestedFix: redact(entry.suggestedFix),
    scope: redact(entry.scope)
  }))
  const sanitizedLog = redact(trimLog(input.logText))
  const logLineCount = sanitizedLog ? sanitizedLog.split('\n').length : 0
  const date = input.createdAt.toISOString()
  const fileStamp = date.replace(/[:.]/g, '-').slice(0, 16)
  const model = input.engine.model

  const lines = [
    'ANODEX SUPPORT BUNDLE',
    `Created: ${date}`,
    '',
    'PRIVACY',
    'This report is generated locally and is never sent automatically.',
    'It excludes chats, workspace files, attachments, credentials, and full local paths.',
    `Redactions applied: ${redactionCount}`,
    '',
    'APP AND SYSTEM',
    `Anodex: ${input.system.appVersion}`,
    `Electron: ${input.system.electronVersion}`,
    `Node: ${input.system.nodeVersion}`,
    `Platform: ${input.system.platform} (${input.system.arch})`,
    '',
    'HARDWARE',
    `CPU: ${input.hardware.cpu}`,
    `Cores: ${input.hardware.cores}`,
    `Memory: ${input.hardware.ram}`,
    `GPU: ${input.hardware.gpu ?? 'Not detected'}`,
    `GPU driver: ${input.hardware.gpuDriver ?? 'Not detected'}`,
    `VRAM: ${input.hardware.vram ?? 'Not detected'}`,
    `Unified memory: ${input.hardware.unifiedMemory ? 'Yes' : 'No'}`,
    `Free storage: ${input.hardware.storageFree ?? 'Not detected'}`,
    '',
    'LOCAL MODEL RUNTIME',
    `Status: ${input.engine.status}`,
    `Model: ${model?.name ?? 'No local model loaded'}`,
    `Context: ${input.engine.contextSize?.toLocaleString() ?? 'Not available'} tokens`,
    `GPU offload: ${
      input.engine.gpuLayersUsed === undefined
        ? 'Not available'
        : `${input.engine.gpuLayersUsed}${
            input.engine.gpuLayersTotal ? ` / ${input.engine.gpuLayersTotal} layers` : ' layers'
          }`
    }`,
    `Vision enabled: ${input.engine.vision ? 'Yes' : 'No'}`,
    '',
    `RECENT DIAGNOSTICS (${sanitizedDiagnostics.length})`,
    sanitizedDiagnostics.length === 0
      ? 'No in-app diagnostic entries were recorded.'
      : sanitizedDiagnostics.map(formatDiagnostic).join('\n\n'),
    '',
    `REDACTED LOG EXCERPT (${logLineCount} lines)`,
    sanitizedLog || 'No current log file was available.'
  ]

  return {
    fileName: `anodex-support-${fileStamp}.txt`,
    content: `${lines.join('\n')}\n`,
    diagnosticsCount: diagnostics.length,
    logLineCount,
    redactionCount
  }
}

export async function createSupportBundlePreview(): Promise<SupportBundlePreview> {
  const hardware = await getHardware()
  const logText = readCurrentLog()
  const system: SystemInfo = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userDataPath: ''
  }

  return buildSupportBundle({
    createdAt: new Date(),
    system,
    hardware,
    engine: llamaService.getState(),
    diagnostics: diagnosticsReporter.list(),
    logText
  })
}

function formatDiagnostic(entry: DiagnosticEntry): string {
  const location = entry.scope ? `${entry.category}/${entry.scope}` : entry.category
  const lines = [
    `[${new Date(entry.timestamp).toISOString()}] ${entry.severity.toUpperCase()} (${location}): ${entry.message}`
  ]
  if (entry.detail) lines.push(`Detail: ${entry.detail}`)
  if (entry.suggestedFix) lines.push(`Suggested fix: ${entry.suggestedFix}`)
  return lines.join('\n')
}

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(-MAX_LOG_CHARS) : value
}

function readCurrentLog(): string {
  const info = getLogFileInfo()
  if (!info.available || !info.path) return ''
  try {
    return readFileSync(info.path, 'utf-8')
  } catch {
    return ''
  }
}
