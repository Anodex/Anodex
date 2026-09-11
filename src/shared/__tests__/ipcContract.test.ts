import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IpcChannel } from '../ipc'

/**
 * Drift guards for the main ⇄ renderer contract.
 *
 * `ipc.ts` calls itself the single source of truth, and the half of that claim
 * TypeScript can prove is already proven: the preload bridge is declared as
 * `const api: AnodexApi`, so a missing or misspelt method there is a compile
 * error. What no compiler checks is the *channel* half — the strings are only
 * ever compared at runtime, by Electron, in a different process.
 *
 * These read the real source rather than a fixture, so they fail on the commit
 * that introduces the drift instead of on the bug report that follows it.
 */

const SRC = join(process.cwd(), 'src')

function sourceText(dir: string): string {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) text += sourceText(path)
    else if (/\.tsx?$/.test(entry.name)) text += `\n${readFileSync(path, 'utf-8')}`
  }
  return text
}

/** Every leaf of `IpcChannel`, as `{ path: 'Models.list', value: 'models:list' }`. */
function channels(): Array<{ path: string; value: string }> {
  const flat: Array<{ path: string; value: string }> = []
  for (const [namespace, group] of Object.entries(IpcChannel)) {
    for (const [key, value] of Object.entries(group)) {
      flat.push({ path: `${namespace}.${key}`, value })
    }
  }
  return flat
}

const mainSource = sourceText(join(SRC, 'main'))
const preloadSource = sourceText(join(SRC, 'preload'))
const all = channels()

const reference = (path: string): RegExp =>
  new RegExp(`IpcChannel\\.${path.replace('.', '\\.')}\\b`)

describe('IPC channel names', () => {
  it('declares at least one channel per namespace', () => {
    expect(all.length).toBeGreaterThan(100)
  })

  it('never reuses a channel string', () => {
    // Two entries sharing a string means one `ipcMain.handle` silently replaces
    // the other — Electron keeps only the last handler registered per channel,
    // so the losing feature fails with no error at either end.
    const byValue = new Map<string, string[]>()
    for (const { path, value } of all) {
      byValue.set(value, [...(byValue.get(value) ?? []), path])
    }
    const reused = [...byValue].filter(([, paths]) => paths.length > 1)

    expect(reused).toEqual([])
  })

  it('namespaces every channel string', () => {
    // `models:list`, not `list` — an unprefixed name is one rename away from
    // colliding with another feature's.
    const unprefixed = all.filter(({ value }) => !value.includes(':'))

    expect(unprefixed).toEqual([])
  })
})

/**
 * Channels whose audience is the paired phone and nothing else.
 *
 * Two kinds. `Remote.notification` is pushed: `RemoteBridge` sends it straight down
 * the socket, so it never passes through preload and never reaches the renderer.
 *
 * The uploads are the other kind — invoked *by* the phone. The desktop renderer
 * attaches a file by picking it off its own disk, so it has no reason to chunk one
 * up and send it to itself; every one of these would be a round trip to fetch bytes
 * it already has.
 *
 * Listing them keeps the guard above honest about the difference between
 * "unreachable by mistake" and "not addressed to the renderer".
 */
const PHONE_ONLY = new Set([
  'Remote.notification',
  'Attachments.beginUpload',
  'Attachments.uploadChunk',
  'Attachments.completeUpload',
  'Attachments.abortUpload',
  'Attachments.discardUpload',
  // The renderer imports `parseWhen` directly; it has no reason to ask the main
  // process to run a pure function it already has. This exists because the phone
  // is Kotlin and cannot, and a second parser over there would drift from this one
  // without anything reporting it.
  'Scheduler.parseWhen',
  // The desktop's own meter computes this projection in the renderer, from three
  // stores it already holds. The phone holds none of them — not the settings, not
  // the system prompt the turn will carry, not the tool schemas — so it has to be
  // able to read the number instead of deriving it. The renderer has no reason to
  // ask main for something it can work out locally, and a second implementation
  // over in Kotlin would be a second set of answers to the same four questions.
  'Chat.contextUsage'
])

describe('IPC channel wiring', () => {
  it('has a main-process reference for every declared channel', () => {
    // A channel nothing in main handles or broadcasts is dead weight the
    // renderer can still call — and calling it rejects.
    const orphaned = all.filter(({ path }) => !reference(path).test(mainSource))

    expect(orphaned.map((c) => c.path)).toEqual([])
  })

  it('has a preload reference for every declared channel the renderer can use', () => {
    // The renderer only ever reaches main through the preload bridge, so a
    // channel absent from it cannot be used at all — unless the renderer is not
    // its audience, which is the one exception below.
    const unreachable = all.filter(
      ({ path }) => !PHONE_ONLY.has(path) && !reference(path).test(preloadSource)
    )

    expect(unreachable.map((c) => c.path)).toEqual([])
  })

  it('keeps the phone-only exceptions actually phone-only', () => {
    // The carve-out above is a hole in a drift guard, so it is itself pinned: a
    // channel listed there that turns up in preload has become a renderer channel
    // and should be checked like every other one.
    const misfiled = [...PHONE_ONLY].filter((path) => reference(path).test(preloadSource))

    expect(misfiled).toEqual([])
  })

  it('registers an ipcMain handler for every channel the preload invokes', () => {
    // The failure this catches is a rejected `invoke` at runtime — "No handler
    // registered for ..." — surfacing in the renderer as an unhandled rejection
    // rather than anywhere near the missing handler.
    const missing = all.filter(({ path }) => {
      const escaped = path.replace('.', '\\.')
      const invoked = new RegExp(`ipcRenderer\\.(invoke|send)\\(\\s*IpcChannel\\.${escaped}\\b`)
      const handled = new RegExp(`ipcMain\\.(handle|on)\\(\\s*IpcChannel\\.${escaped}\\b`)
      return invoked.test(preloadSource) && !handled.test(mainSource)
    })

    expect(missing.map((c) => c.path)).toEqual([])
  })

  it('routes every registration through IpcChannel rather than a bare string', () => {
    // A hardcoded name is invisible to every check above, including the
    // duplicate check — which is how two features quietly end up sharing one.
    const literals = new Set<string>()
    for (const source of [mainSource, preloadSource]) {
      for (const match of source.matchAll(
        /ipc(?:Main|Renderer)\.(?:handle|on|invoke|send)\(\s*'([^']+)'/g
      )) {
        literals.add(match[1])
      }
    }

    expect([...literals]).toEqual([])
  })
})
