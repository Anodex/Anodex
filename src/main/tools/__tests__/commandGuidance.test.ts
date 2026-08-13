import { describe, expect, it } from 'vitest'
import { checkCommandCompatibility, describeEmptySearchResult } from '../commandGuidance'

describe('checkCommandCompatibility', () => {
  /**
   * The exact command from chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`.
   * `\|` is grep alternation; findstr has no such syntax, so it searched for
   * one long literal, found nothing, and exited quietly — and the model
   * concluded the elements were absent. They were all present.
   */
  it('refuses findstr with grep alternation before it can mislead', () => {
    const message = checkCommandCompatibility(
      'findstr /n "sandbox-container\\|sandboxCanvas\\|sim-controls" "index.html"',
      'win32',
      'powershell.exe'
    )

    expect(message).toContain('does not support `\\|`')
    expect(message).toContain('/c:')
    expect(message).toContain('Select-String')
  })

  it('refuses findstr alternation regardless of platform', () => {
    // The syntax is wrong wherever it runs — findstr only exists on Windows,
    // but the check must not depend on the host reporting win32.
    expect(checkCommandCompatibility('findstr "a\\|b" f.txt', 'linux', '/bin/bash')).toContain(
      'grep syntax'
    )
  })

  it('allows correctly-formed findstr', () => {
    expect(
      checkCommandCompatibility(
        'findstr /r /c:"canvas" /c:"section" index.html',
        'win32',
        'cmd.exe'
      )
    ).toBeNull()
  })

  it('redirects grep to Select-String in a Windows-native shell', () => {
    const message = checkCommandCompatibility('grep -n "foo" bar.js', 'win32', 'powershell.exe')

    expect(message).toContain('not available in this shell')
    expect(message).toContain('Select-String')
    expect(message).toContain('Nothing was run')
  })

  /**
   * Git Bash and WSL genuinely provide coreutils on Windows. Blocking there
   * would be a false rejection of a command that works.
   */
  it('leaves Unix commands alone in a POSIX shell, even on Windows', () => {
    expect(
      checkCommandCompatibility(
        'grep -n "foo" bar.js',
        'win32',
        'C:\\Program Files\\Git\\bin\\bash.exe'
      )
    ).toBeNull()
    expect(checkCommandCompatibility('ls -la', 'win32', '/usr/bin/zsh')).toBeNull()
  })

  it('leaves Unix commands alone on non-Windows platforms', () => {
    expect(checkCommandCompatibility('grep -n "foo" bar.js', 'darwin', undefined)).toBeNull()
  })

  it.each([
    ['sed', 'sed -i s/a/b/ f.txt'],
    ['cat', 'cat package.json'],
    ['which', 'which node'],
    ['head', 'head -20 file.txt']
  ])('redirects %s on a Windows-native shell', (_name, command) => {
    expect(checkCommandCompatibility(command, 'win32', 'cmd.exe')).toContain('Nothing was run')
  })

  it('does not block commands that exist on Windows', () => {
    expect(checkCommandCompatibility('npm run build', 'win32', 'powershell.exe')).toBeNull()
    expect(checkCommandCompatibility('git status', 'win32', 'cmd.exe')).toBeNull()
    expect(checkCommandCompatibility('node script.js', 'win32', 'cmd.exe')).toBeNull()
  })
})

describe('describeEmptySearchResult', () => {
  it('flags an empty search result as ambiguous', () => {
    const note = describeEmptySearchResult('findstr /n "canvas" index.html', '(no output)', false)

    expect(note).toContain('EITHER the pattern genuinely does not occur')
    expect(note).toContain('Do not conclude the term is absent')
  })

  it('stays quiet when the search found something', () => {
    expect(
      describeEmptySearchResult('findstr /n "canvas" index.html', '12: <canvas>', false)
    ).toBeNull()
  })

  it('stays quiet for a non-search command that printed nothing', () => {
    // `mkdir` succeeding silently is not ambiguous.
    expect(describeEmptySearchResult('mkdir build', '(no output)', false)).toBeNull()
  })

  it('stays quiet when the command was killed, since output is expected to be partial', () => {
    expect(describeEmptySearchResult('rg pattern .', '(no output)', true)).toBeNull()
  })

  it.each(['grep -rn x .', 'rg x', 'select-string -Pattern x', 'git ls-files | grep x'])(
    'recognizes %s as a search command',
    (command) => {
      expect(describeEmptySearchResult(command, '(no output)', false)).not.toBeNull()
    }
  )
})
