import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('updater')

/**
 * A small "Updating Anodex" window that stays up while the update installs.
 *
 * Restart & install closes Anodex and installs silently, so for the length of the
 * install there was nothing on screen at all — an app that had simply vanished, and
 * then came back. This window fills that gap: it opens as Anodex quits, shows a moving
 * bar, and closes itself once Anodex is running again. If the installer finishes and
 * Anodex does not come back, it says so rather than disappearing.
 *
 * Windows PowerShell and WinForms, both part of every Windows 10 and 11 install, so the
 * update ships nothing extra. The script is written fresh for each update and holds no
 * input from anywhere but this app.
 */
export function showUpdateProgressWindow(options: {
  version: string
  /** Anodex's own executable, for the window icon and to recognise it coming back. */
  exePath: string
}): void {
  if (process.platform !== 'win32') return
  try {
    const script = join(tmpdir(), `anodex-update-progress-${Date.now()}.ps1`)
    // With a byte-order mark: Windows PowerShell 5.1 reads a file without one as the
    // local code page, not UTF-8.
    writeFileSync(script, `\ufeff${updateProgressScript(options)}`, 'utf8')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.on('error', (error) => log.warn('Update progress window did not open:', error))
    child.unref()
  } catch (error) {
    // The update itself does not depend on this window.
    log.warn('Update progress window did not open:', error)
  }
}

/** A string safe inside a PowerShell single-quoted literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The PowerShell for {@link showUpdateProgressWindow}. Exported for tests. */
export function updateProgressScript(options: { version: string; exePath: string }): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$version = ${psQuote(options.version)}
$exePath = ${psQuote(options.exePath)}
$startedAt = Get-Date
# Anodex closes a moment after this window opens; anything started after that is the new copy.
$quitGraceSeconds = 4

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Updating Anodex'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(380, 150)
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 24)
$form.ForeColor = [System.Drawing.Color]::FromArgb(230, 230, 230)
$form.TopMost = $true
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath) } catch {}

$title = New-Object System.Windows.Forms.Label
$title.Text = "Updating Anodex to $version"
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 22)
$form.Controls.Add($title)

$detail = New-Object System.Windows.Forms.Label
$detail.Text = 'Installing the update. Anodex will reopen by itself.'
$detail.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$detail.ForeColor = [System.Drawing.Color]::FromArgb(160, 160, 160)
$detail.AutoSize = $true
$detail.Location = New-Object System.Drawing.Point(24, 54)
$form.Controls.Add($detail)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$bar.Location = New-Object System.Drawing.Point(24, 88)
$bar.Size = New-Object System.Drawing.Size(332, 8)
$form.Controls.Add($bar)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Close'
$close.Visible = $false
$close.FlatStyle = 'Flat'
$close.Location = New-Object System.Drawing.Point(281, 108)
$close.Size = New-Object System.Drawing.Size(75, 28)
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

function Test-AnodexBack {
  $threshold = $startedAt.AddSeconds($quitGraceSeconds)
  Get-Process -Name 'Anodex' -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -gt $threshold -and $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}

function Test-Installing {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -like 'Anodex-Setup*' } |
    Select-Object -First 1
}

$sawInstaller = $false
$installerGoneAt = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({
  $elapsed = ((Get-Date) - $startedAt).TotalSeconds
  if (Test-AnodexBack) { $timer.Stop(); $form.Close(); return }
  if (Test-Installing) { $script:sawInstaller = $true; $script:installerGoneAt = $null; return }
  if ($script:sawInstaller -and -not $script:installerGoneAt) { $script:installerGoneAt = Get-Date; $detail.Text = 'Finishing up. Anodex is opening...' }
  $waitedSinceInstall = if ($script:installerGoneAt) { ((Get-Date) - $script:installerGoneAt).TotalSeconds } else { 0 }
  if ($waitedSinceInstall -gt 45 -or $elapsed -gt 600) {
    $timer.Stop()
    $bar.Style = 'Blocks'
    $bar.Value = 0
    $title.Text = 'The update did not finish'
    $detail.Text = 'Open Anodex from the Start menu to try again.'
    $close.Visible = $true
  }
})
$timer.Start()
[void]$form.ShowDialog()
Remove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue
`
}
