/**
 * Rotating on-disk log file for the main process.
 *
 * A packaged Electron app's main-process stdout goes nowhere the user can read,
 * so without this every model-load failure, native crash, mailbox error and
 * failed update is unrecoverable after the fact. Two files are kept
 * (`anodex.log` + `anodex.1.log`) at 2 MB each — bounded, and still long enough
 * to cover the session a bug report is about.
 *
 * **Writes are synchronous, deliberately.** An earlier version queued them and
 * appended asynchronously; that produced two real bugs its tests caught: a line
 * written urgently (an error, a crash handler) could land *before* queued lines
 * that preceded it, and anything still in flight at quit was lost. Both are
 * fatal to a log's usefulness — order and durability are the only things it has
 * to get right. Nothing in this app logs at high frequency (the highest is once
 * per generation round; terminal output logs per session, not per chunk), so a
 * short `appendFileSync` is cheaper than a correct queue.
 *
 * This module must never use `createLogger` — logging a logging failure is how
 * you get an infinite loop. Failures here disable the file sink and report once
 * on the console.
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const FILE_NAME = 'anodex.log'
const ROTATED_NAME = 'anodex.1.log'

let filePath: string | null = null
let rotatedPath: string | null = null
let bytesWritten = 0
let disabled = false

function fail(reason: string, error: unknown): void {
  if (disabled) return
  disabled = true
  // Direct console use is intentional — see the module comment.
  console.error(`[diagnostics] file logging disabled (${reason}):`, error)
}

/** Open (creating if needed) the log file. Safe to call once at startup. */
export function initLogFile(): void {
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    filePath = path.join(dir, FILE_NAME)
    rotatedPath = path.join(dir, ROTATED_NAME)
    bytesWritten = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  } catch (error) {
    fail('could not open the log directory', error)
  }
}

function rotate(): void {
  if (!filePath || !rotatedPath) return
  try {
    // libuv's rename replaces an existing destination on every platform, so the
    // previous rotated file is dropped without a separate unlink. Nothing holds
    // an open handle here — every write closes before returning.
    fs.renameSync(filePath, rotatedPath)
    bytesWritten = 0
  } catch (error) {
    fail('could not rotate the log file', error)
  }
}

/** Append one already-formatted line. */
export function appendLogLine(line: string): void {
  if (disabled || !filePath) return
  try {
    fs.appendFileSync(filePath, line)
    bytesWritten += Buffer.byteLength(line)
    if (bytesWritten >= MAX_BYTES) rotate()
  } catch (error) {
    fail('could not append to the log file', error)
  }
}

/** Where the log lives and how big it is, for the Diagnostics page. */
export function getLogFileInfo(): { path: string; sizeBytes: number; available: boolean } {
  if (!filePath) return { path: '', sizeBytes: 0, available: false }
  let sizeBytes = bytesWritten
  try {
    sizeBytes = fs.statSync(filePath).size
  } catch {
    // Not yet created — the tracked count is close enough.
  }
  return { path: filePath, sizeBytes, available: !disabled }
}
