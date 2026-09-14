import { describe, expect, it } from 'vitest'
import { updateProgressScript } from '../updateProgressWindow'

/** The "Updating Anodex" window shown while a silent update installs on Windows. */
describe('updateProgressScript', () => {
  const script = updateProgressScript({
    version: '0.9.4',
    exePath: "C:/Users/O'Brien/AppData/Local/Programs/Anodex/Anodex.exe"
  })

  it('names the version and says Anodex will reopen', () => {
    expect(script).toContain("$version = '0.9.4'")
    expect(script).toContain('Anodex will reopen by itself.')
  })

  it('quotes the executable path so an apostrophe cannot end the string', () => {
    expect(script).toContain("$exePath = 'C:/Users/O''Brien/AppData")
  })

  it('closes when a new Anodex window appears, and says so when the install never comes back', () => {
    expect(script).toContain('Test-AnodexBack')
    expect(script).toContain('The update did not finish')
  })

  it('updates state from the timer at script scope, and stays plain ASCII', () => {
    expect(script).toContain('$script:sawInstaller = $true')
    // Windows PowerShell 5.1 misreads anything else in a file without a byte-order mark.
    expect([...script].every((char) => char === '\n' || (char >= ' ' && char <= '~'))).toBe(true)
  })
})
