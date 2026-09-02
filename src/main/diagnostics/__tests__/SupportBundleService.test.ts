import { describe, expect, it, vi } from 'vitest'
import type { EngineState } from '@shared/model.types'
import type { DiagnosticEntry } from '@shared/settings.types'
import type { HardwareInfo, SystemInfo } from '@shared/system.types'

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0' } }))
vi.mock('../../llama/LlamaService', () => ({ llamaService: { getState: vi.fn() } }))
vi.mock('../../ipc/system.handlers', () => ({ getHardware: vi.fn() }))
vi.mock('../DiagnosticsReporter', () => ({ diagnosticsReporter: { list: vi.fn() } }))
vi.mock('../logFile', () => ({ getLogFileInfo: vi.fn() }))

const { buildSupportBundle, redactSupportText } = await import('../SupportBundleService')

const system: SystemInfo = {
  appVersion: '0.1.0',
  electronVersion: '40.0.0',
  nodeVersion: '22.0.0',
  chromeVersion: '140.0.0',
  platform: 'win32',
  arch: 'x64',
  userDataPath: 'C:\\Users\\Person\\AppData\\Roaming\\Anodex'
}

const hardware: HardwareInfo = {
  cpu: 'Test CPU',
  cores: 8,
  ram: '32 GB',
  ramBytes: 32 * 1024 ** 3,
  os: 'Windows',
  gpu: 'Test GPU',
  gpuDriver: '1.2.3',
  vram: '12 GB',
  vramBytes: 12 * 1024 ** 3,
  unifiedMemory: false,
  storageFree: '100 GB'
}

const engine: EngineState = {
  status: 'ready',
  model: {
    id: 'model-1',
    name: 'Qwen3 8B',
    path: 'C:\\Models\\Qwen3.gguf',
    sizeBytes: 4,
    source: 'local'
  },
  contextSize: 16384,
  gpuLayersUsed: 32,
  gpuLayersTotal: 36,
  vision: false,
  generating: false
}

const diagnostic: DiagnosticEntry = {
  id: 'diag-1',
  timestamp: Date.UTC(2026, 0, 2),
  severity: 'error',
  category: 'runtime',
  message: 'Request failed with api_key=super-secret',
  detail: 'Opened C:\\Users\\Person\\project\\secret.txt for https://example.com/private?token=abc',
  source: 'main',
  scope: 'runtime'
}

describe('redactSupportText', () => {
  it('removes credentials, URLs, email addresses, and absolute paths', () => {
    const result = redactSupportText(
      'Bearer sk-secret-token api_key=top-secret token: abc@example.com C:\\Users\\Person\\private.txt https://example.com/private?x=1 jane@example.com'
    )

    expect(result.text).not.toContain('secret-token')
    expect(result.text).not.toContain('top-secret')
    expect(result.text).not.toContain('C:\\Users\\Person')
    expect(result.text).not.toContain('example.com')
    expect(result.text).not.toContain('jane@example.com')
    expect(result.text).toContain('<redacted>')
    expect(result.replacements).toBeGreaterThan(0)
  })
})

describe('buildSupportBundle', () => {
  it('includes useful runtime facts while redacting diagnostics and log excerpts', () => {
    const bundle = buildSupportBundle({
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      system,
      hardware,
      engine,
      diagnostics: [diagnostic],
      logText: 'Password: dont-export\nC:\\Users\\Person\\project\\file.ts\n'
    })

    expect(bundle.fileName).toBe('anodex-support-2026-01-02T03-04.txt')
    expect(bundle.diagnosticsCount).toBe(1)
    expect(bundle.content).toContain('Qwen3 8B')
    expect(bundle.content).toContain('Memory: 32 GB')
    expect(bundle.content).not.toContain('super-secret')
    expect(bundle.content).not.toContain('dont-export')
    expect(bundle.content).not.toContain('C:\\Users\\Person')
    expect(bundle.content).toContain('It excludes chats, workspace files, attachments, credentials')
    expect(bundle.redactionCount).toBeGreaterThan(0)
  })
})

/**
 * A support bundle is built to be sent to someone, so anything it fails to
 * redact is disclosed on purpose by a user who believed it was safe.
 *
 * Demonstrated against the real patterns, not assumed. Four leaks:
 *
 *   "apiKey": "tvly-..."   the key/value rule requires the separator to follow
 *                          the word, and JSON puts a quote in between
 *   gsk_...   (Groq)       `\b(?:sk` cannot match inside `gsk`
 *   xai-...   (xAI)        no prefix rule at all
 *   tvly-...  (Tavily)     no prefix rule at all
 *
 * DeepSeek, OpenAI, Anthropic, OpenRouter, Kimi and Qwen keys survived only
 * because they all begin `sk`, which the prefix rule does cover — the
 * key/value rule was not protecting any of them in JSON.
 */
describe('redactSupportText covers every provider Anodex supports', () => {
  const leaks = (text: string): boolean => redactSupportText(text).text.includes(text.slice(-12))

  it('redacts a JSON-quoted credential', () => {
    // Settings and many logged payloads are JSON; a quote sits between the key
    // and its colon.
    expect(leaks('  "apiKey": "tvly-abc123def456ghi789",')).toBe(false)
  })

  it('redacts a Groq key', () => {
    expect(leaks('gsk_abcdef1234567890abcdef')).toBe(false)
  })

  it('redacts an xAI key', () => {
    expect(leaks('xai-abcdef1234567890abcdef')).toBe(false)
  })

  it('redacts a Tavily key', () => {
    expect(leaks('tvly-abcdef1234567890abcd')).toBe(false)
  })

  it('still redacts the formats it already handled', () => {
    for (const key of [
      'sk-abcdef1234567890abcdef',
      'sk-ant-abcdef1234567890abc',
      'AIzaAbCdEf1234567890abcdef',
      'hf_abcdef1234567890abcdef',
      'ghp_abcdef1234567890abcdef'
    ]) {
      expect(leaks(key), key).toBe(false)
    }
  })

  it('leaves ordinary prose alone', () => {
    // Over-redacting a bundle makes it useless for the diagnosis it exists for.
    const prose = 'The model stopped after 6 turns without calling a tool.'
    expect(redactSupportText(prose).text).toBe(prose)
  })
})
