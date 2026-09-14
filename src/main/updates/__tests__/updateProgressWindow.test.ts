import { describe, expect, it } from 'vitest'
import { launcherArguments, updateProgressScript } from '../updateProgressWindow'

/** The "Updating Anodex" window shown while a silent update installs on Windows. */
describe('updateProgressScript', () => {
  const script = updateProgressScript({
    version: '0.9.4',
    exePath: "C:/Users/O'Brien/AppData/Local/Programs/Anodex/Anodex.exe",
    shownMarker: "C:/Users/O'Brien/AppData/Local/Temp/anodex-update-progress-1.shown"
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

  it('marks when the window is on screen, which Anodex waits for before quitting', () => {
    expect(script).toContain(
      "$shownMarker = 'C:/Users/O''Brien/AppData/Local/Temp/anodex-update-progress-1.shown'"
    )
    expect(script).toContain('$form.Add_Shown(')
  })
})

/**
 * How the window is started.
 *
 * Spawned directly, it never appeared: Electron keeps Anodex in a Windows job object
 * that ends every process in it when Anodex exits, and the window's PowerShell
 * inherited the job and was ended before it had loaded.
 */
describe('launcherArguments', () => {
  it("starts the script through WMI, so it is not in Anodex's job", () => {
    const args = launcherArguments(
      "C:/Users/O'Brien/AppData/Local/Temp/anodex-update-progress-1.ps1"
    )
    const encoded = args[args.indexOf('-EncodedCommand') + 1]
    const launcher = Buffer.from(encoded, 'base64').toString('utf16le')

    expect(launcher).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
    // Inside a single-quoted PowerShell string, so the apostrophe is doubled.
    expect(launcher).toContain(
      `-File "C:/Users/O''Brien/AppData/Local/Temp/anodex-update-progress-1.ps1"`
    )
    expect(args).toContain('-NonInteractive')
  })
})
