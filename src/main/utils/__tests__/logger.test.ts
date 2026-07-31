import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, setLogSink, type LogLevel } from '../logger'

afterEach(() => {
  setLogSink(null)
  vi.restoreAllMocks()
})

describe('log sink', () => {
  it('receives every level, including ones the console gate would drop', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: LogLevel[] = []
    setLogSink((level) => seen.push(level))

    const log = createLogger('test')
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')

    expect(seen).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('passes the scope and raw arguments through untouched', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = vi.fn()
    setLogSink(sink)
    const error = new Error('boom')

    createLogger('llama:vision').error('Load failed:', error, { path: 'm.gguf' })

    expect(sink).toHaveBeenCalledWith('error', 'llama:vision', [
      'Load failed:',
      error,
      { path: 'm.gguf' }
    ])
  })

  it('does not let a throwing sink break the caller that was only logging', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setLogSink(() => {
      throw new Error('sink is broken')
    })

    expect(() => createLogger('test').error('still logs')).not.toThrow()
    expect(consoleError).toHaveBeenCalled()
  })

  it('does not recurse when the sink itself logs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger('test')
    let calls = 0
    setLogSink(() => {
      calls += 1
      // A sink that logs (e.g. reporting its own write failure) must not
      // re-enter itself — that would be an unbounded stack.
      log.error('sink failed to write')
    })

    log.error('original')

    expect(calls).toBe(1)
  })

  it('stops delivering once detached', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = vi.fn()
    setLogSink(sink)
    setLogSink(null)

    createLogger('test').error('ignored')

    expect(sink).not.toHaveBeenCalled()
  })
})
