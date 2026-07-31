import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let logsDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => logsDir }
}))

const { appendLogLine, getLogFileInfo, initLogFile } = await import('../logFile')

const logPath = (): string => path.join(logsDir, 'anodex.log')
const rotatedPath = (): string => path.join(logsDir, 'anodex.1.log')

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anodex-logfile-'))
  initLogFile()
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('logFile', () => {
  it('creates the log directory and reports where it is', () => {
    const info = getLogFileInfo()

    expect(info.available).toBe(true)
    expect(info.path).toBe(logPath())
  })

  it('writes each line straight through, so a crash right after cannot lose it', () => {
    appendLogLine('an error line\n')

    expect(fs.readFileSync(logPath(), 'utf8')).toBe('an error line\n')
  })

  it('preserves write order', () => {
    appendLogLine('first\n')
    appendLogLine('second\n')
    appendLogLine('third\n')

    expect(fs.readFileSync(logPath(), 'utf8')).toBe('first\nsecond\nthird\n')
  })

  it('rotates on the write that crosses the size cap, keeping the previous file', () => {
    const chunk = `${'x'.repeat(64 * 1024)}\n`
    // 32 × 64 KiB is the first count to reach 2 MiB, so the 32nd write rotates.
    const writes = Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(chunk))
    for (let i = 0; i < writes - 1; i += 1) appendLogLine(chunk)

    expect(fs.existsSync(rotatedPath())).toBe(false)

    appendLogLine(chunk)

    expect(fs.statSync(rotatedPath()).size).toBe(writes * Buffer.byteLength(chunk))
    // The active file starts over, so the pair stays bounded.
    expect(fs.existsSync(logPath())).toBe(false)
    appendLogLine('after rotation\n')
    expect(fs.readFileSync(logPath(), 'utf8')).toBe('after rotation\n')
  })

  it('replaces an older rotated file rather than accumulating logs forever', () => {
    fs.writeFileSync(rotatedPath(), 'previous rotation\n')
    const chunk = `${'y'.repeat(64 * 1024)}\n`
    for (let i = 0; i < 32; i += 1) appendLogLine(chunk)

    expect(fs.readFileSync(rotatedPath(), 'utf8').startsWith('y')).toBe(true)
    expect(fs.readdirSync(logsDir).sort()).toEqual(['anodex.1.log'])
  })

  it('picks up the size of a log file left by a previous session', () => {
    appendLogLine('from an earlier run\n')
    initLogFile()

    expect(getLogFileInfo().sizeBytes).toBe('from an earlier run\n'.length)
  })

  it('reports unavailable and stops writing when the directory cannot be used', () => {
    // A file where the log directory should be: mkdir fails, and the sink must
    // degrade quietly instead of throwing into whatever was only logging.
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'anodex-blocked-'))
    logsDir = path.join(blocked, 'logs')
    fs.writeFileSync(logsDir, 'not a directory')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    initLogFile()

    expect(getLogFileInfo().available).toBe(false)
    expect(() => appendLogLine('dropped\n')).not.toThrow()

    fs.rmSync(blocked, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
})
