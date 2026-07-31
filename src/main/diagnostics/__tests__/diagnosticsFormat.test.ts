import { describe, expect, it } from 'vitest'
import {
  MAX_DETAIL_CHARS,
  categoryForScope,
  formatLogArgs,
  formatLogLine,
  severityForLevel,
  suggestedFixFor,
  truncate
} from '../diagnosticsFormat'

describe('formatLogArgs', () => {
  it('uses the first string as the headline and the error stack as detail', () => {
    const error = new Error('EACCES: permission denied')
    error.stack = 'Error: EACCES: permission denied\n    at write (fs.js:1)'

    const result = formatLogArgs(['Failed to save the conversation:', error])

    expect(result.message).toBe('Failed to save the conversation')
    expect(result.detail).toBe('Error: EACCES: permission denied\n    at write (fs.js:1)')
  })

  it('keeps structured context alongside an error', () => {
    const result = formatLogArgs(['Model load failed', new Error('boom'), { path: 'C:/m.gguf' }])

    expect(result.message).toBe('Model load failed')
    expect(result.detail).toContain('boom')
    expect(result.detail).toContain('C:/m.gguf')
  })

  it('describes a nested cause', () => {
    const cause = new Error('socket hang up')
    cause.stack = 'Error: socket hang up'
    const error = new Error('request failed', { cause })
    error.stack = 'Error: request failed'

    expect(formatLogArgs(['Sync failed:', error]).detail).toBe(
      'Error: request failed\nCaused by: Error: socket hang up'
    )
  })

  it('falls back to the first value when nothing was logged as a string', () => {
    const error = new Error('unexpected end of JSON input')
    error.stack = 'SyntaxError: unexpected end of JSON input\n    at parse'

    const result = formatLogArgs([error])

    expect(result.message).toBe('SyntaxError: unexpected end of JSON input')
    expect(result.detail).toContain('at parse')
  })

  it('survives a circular object rather than throwing inside the logger', () => {
    const circular: Record<string, unknown> = { name: 'ctx' }
    circular.self = circular

    const result = formatLogArgs(['Broke', circular])

    expect(result.message).toBe('Broke')
    expect(result.detail).toContain('[circular]')
  })

  it('never returns an empty headline', () => {
    expect(formatLogArgs([]).message).toBe('Unknown event')
    expect(formatLogArgs(['   ']).message).toBe('Unknown event')
  })

  it('collapses a multi-line headline to its first line', () => {
    expect(formatLogArgs(['first line\nsecond line']).message).toBe('first line')
  })
})

describe('categoryForScope', () => {
  it.each([
    ['llama', 'model'],
    ['llama:vision', 'model'],
    ['downloader', 'model'],
    ['embedding-service', 'model'],
    ['anthropic', 'provider'],
    ['openai', 'provider'],
    ['email:imap', 'integration'],
    ['mcp:servers', 'integration'],
    ['github', 'integration'],
    ['conversations', 'file'],
    ['settings', 'file'],
    ['ipc:chat', 'runtime'],
    ['window', 'runtime'],
    ['scheduler-service', 'runtime'],
    ['something-new', 'general']
  ])('maps %s to %s', (scope, category) => {
    expect(categoryForScope(scope)).toBe(category)
  })
})

describe('severityForLevel', () => {
  it('surfaces only warnings and errors in the app', () => {
    expect(severityForLevel('error')).toBe('error')
    expect(severityForLevel('warn')).toBe('warning')
    expect(severityForLevel('info')).toBeNull()
    expect(severityForLevel('debug')).toBeNull()
  })
})

describe('suggestedFixFor', () => {
  it('points GPU memory failures at the GPU layers setting', () => {
    expect(suggestedFixFor('ggml_backend_cuda: out of memory')).toContain('GPU layers')
  })

  it('points a rejected key at provider connections', () => {
    expect(suggestedFixFor('Request failed with status 401 invalid_api_key')).toContain('API key')
  })

  it('recognizes a quota failure separately from an auth failure', () => {
    expect(suggestedFixFor('429 insufficient_quota')).toContain('quota')
  })

  it('stays silent when nothing is confidently known', () => {
    expect(suggestedFixFor('Something unexpected happened')).toBeUndefined()
  })

  it('does not blame the network for a dropped loopback connection to the local engine', () => {
    const text = 'Email thread digest failed\nError: Connection error.\nCaused by: read ECONNRESET'

    // Without the scope it reads as an ordinary network failure...
    expect(suggestedFixFor(text)).toContain('network connection')
    // ...but inside the local engine it is Anodex's own bundled server.
    const local = suggestedFixFor(text, 'llama')
    expect(local).toContain('local model server')
    expect(local).not.toContain('VPN')
  })

  it('still gives the local engine ordinary advice for non-connection failures', () => {
    expect(suggestedFixFor('ENOSPC: no space left on device', 'llama')).toContain('disk is full')
  })
})

describe('IPC failure codes', () => {
  it('classifies a failure code the same way as a logger scope', () => {
    expect(categoryForScope('models.load-failed')).toBe('model')
    expect(categoryForScope('email.send-failed')).toBe('integration')
    expect(categoryForScope('workspace.read-failed')).toBe('file')
    expect(categoryForScope('model-reliability')).toBe('model')
  })
})

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short')
  })

  it('says how much was dropped and where to find it', () => {
    const result = truncate('x'.repeat(MAX_DETAIL_CHARS + 25), MAX_DETAIL_CHARS)

    expect(result).toContain('25 more characters')
    expect(result).toContain('log file')
  })
})

describe('formatLogLine', () => {
  it('writes one head line and indents the detail under it', () => {
    const line = formatLogLine(0, 'error', 'llama', {
      message: 'Load failed',
      detail: 'Error: boom\n    at load'
    })

    expect(line).toBe(
      '[1970-01-01T00:00:00.000Z] [ERROR] [llama] Load failed\n    Error: boom\n        at load\n'
    )
  })

  it('ends with a newline when there is no detail', () => {
    expect(formatLogLine(0, 'warn', 'email', { message: 'Retrying' })).toBe(
      '[1970-01-01T00:00:00.000Z] [WARN] [email] Retrying\n'
    )
  })
})
