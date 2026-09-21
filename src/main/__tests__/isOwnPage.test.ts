import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: class {},
  clipboard: {},
  ipcMain: { on: () => undefined, handle: () => undefined },
  shell: { openExternal: () => Promise.resolve() },
  screen: {}
}))

const { isOwnPage } = await import('../window')

const DEV = 'http://localhost:5173/'

/**
 * What the main window's `will-navigate` guard lets through.
 *
 * Both directions matter and the failure modes are opposite. Too strict and
 * the app blocks its own reload, which in a dev run means the window goes
 * blank and stays blank. Too loose and the guard does nothing, which is the
 * state this replaced.
 */
describe('isOwnPage', () => {
  it('lets the packaged renderer load from disk', () => {
    expect(
      isOwnPage(
        'file:///C:/Program%20Files/Anodex/resources/app.asar/out/renderer/index.html',
        undefined
      )
    ).toBe(true)
  })

  it('lets the dev server reload itself, whatever it appends', () => {
    expect(isOwnPage('http://localhost:5173/', DEV)).toBe(true)
    expect(isOwnPage('http://localhost:5173/index.html?t=1729', DEV)).toBe(true)
    expect(isOwnPage('http://localhost:5173/#/settings', DEV)).toBe(true)
  })

  it('does not mistake another port or host for the dev server', () => {
    // A different origin is a different program, even on localhost.
    expect(isOwnPage('http://localhost:5174/', DEV)).toBe(false)
    expect(isOwnPage('http://127.0.0.1:5173/', DEV)).toBe(false)
    expect(isOwnPage('https://localhost:5173/', DEV)).toBe(false)
  })

  it('sends the open web outward', () => {
    expect(isOwnPage('https://example.com', DEV)).toBe(false)
    expect(isOwnPage('https://example.com', undefined)).toBe(false)
  })

  it('does not treat a lookalike host as the dev server', () => {
    // `localhost:5173.evil.example` starts with the dev origin as a string
    // and is a different machine entirely.
    expect(isOwnPage('http://localhost:5173.evil.example/', DEV)).toBe(false)
    expect(isOwnPage('http://localhost:5173@evil.example/', DEV)).toBe(false)
  })

  it('refuses what is not a URL, and a packaged build with no dev server', () => {
    expect(isOwnPage('not a url', DEV)).toBe(false)
    expect(isOwnPage('http://localhost:5173/', undefined)).toBe(false)
  })
})
