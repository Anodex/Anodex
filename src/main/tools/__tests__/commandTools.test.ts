import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { parseRunCommandVerification, runCommandTool } from '../commandTools'
import { checkLongRunningServer } from '../commandGuidance'
import {
  effectiveToolKind,
  isObservationalCommand,
  observationalCommandIdentity
} from '../commandEffect'
import { captureCalls, createMockContext, createMockDefine } from './test-helpers'

describe('run_command', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-command-'))
  })

  afterEach(async () => {
    // Best-effort. These tests spawn real processes into `workspace`, and on
    // Windows a directory that has just hosted a killed child can stay locked
    // for a moment after it exits — verified as the OS releasing the handle,
    // not a surviving process. Failing a passing test over temp-directory
    // housekeeping would be reporting the wrong thing.
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    }).catch(() => {})
  })

  it('runs a command and reports its exit code and output', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'echo hello' })

    expect(result).toContain('Exit code 0')
    expect(result).toContain('hello')
  })

  it('marks successful shell inspection as read-only progress', async () => {
    const { calls, emit } = captureCalls()
    const ctx = {
      ...createMockContext(workspace),
      emit,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    await tool.handler({ command: process.platform === 'win32' ? 'Get-ChildItem' : 'ls' })

    expect(calls.at(-1)).toMatchObject({ status: 'success', madeProgress: false })
    expect(ctx.progress.madeChange).toBe(false)
  })

  it('classifies wrapped PowerShell reads without hiding real mutations', () => {
    expect(
      isObservationalCommand(
        'powershell -Command "$content = Get-Content js/universe-sandbox.js -Raw; $content.Substring(10000, 10000)"'
      )
    ).toBe(true)
    expect(
      isObservationalCommand(
        'powershell -Command "(Get-Content js/universe-sandbox.js | Select-Object -Skip 100 -First 150) -join "`n""'
      )
    ).toBe(true)
    expect(isObservationalCommand('Set-Content index.html "changed"')).toBe(false)
    expect(isObservationalCommand('npm test')).toBe(false)
  })

  it('canonicalizes equivalent shell reads to one evidence identity', () => {
    expect(observationalCommandIdentity('Get-Content js/universe-sandbox.js -TotalCount 100')).toBe(
      observationalCommandIdentity(
        'powershell -Command "Get-Content js/universe-sandbox.js | Select-Object -First 100"'
      )
    )
  })

  it('marks a command rejected before execution as a no-op', async () => {
    const { calls, emit } = captureCalls()
    const ctx = {
      ...createMockContext(workspace),
      emit,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'findstr /n "one\\|two" index.html' })

    expect(result).toContain('Nothing was run')
    expect(calls.at(-1)).toMatchObject({ status: 'success', madeProgress: false })
    expect(ctx.progress.madeChange).toBe(false)
  })

  it('reports a non-zero exit code without throwing', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'exit 3' })

    expect(result).toContain('Exit code 3')
  })

  it('runs the command inside the workspace directory', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    // `cd` with no output proves nothing; print the cwd instead so the test
    // actually asserts the command ran scoped to the workspace, not just that
    // some command ran somewhere.
    const result = await tool.handler({ command: process.platform === 'win32' ? 'cd' : 'pwd' })

    expect(result.replace(/\\/g, '/')).toContain(workspace.replace(/\\/g, '/'))
  })

  it('truncates very large command output', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    // A command that prints far more than the shared 4000-char model-result
    // cap — the "large output" analog of the large-file tests for the read
    // tools. Also guards against the same double-truncation bug found in
    // read_file: the note must report the command's real total output
    // length, not some other, meaningless intermediate length.
    const command =
      process.platform === 'win32'
        ? 'for /L %i in (1,1,3000) do @echo line%i'
        : 'for i in $(seq 1 3000); do echo line$i; done'
    const result = await tool.handler({ command })

    expect(result.length).toBeLessThan(4100)
    expect(result).toMatch(/truncated, \d+ bytes total/)
  })

  it('says a command timed out instead of reporting a null exit code', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string; timeoutMs?: number }) => Promise<string>
    }

    // Node kills a timed-out child with SIGTERM, and `error.code` is `null` for
    // anything killed by a signal — so this used to reach the model as
    // "Exit code null", with nothing to say it had been killed or why. The most
    // likely response to that is running the identical command again.
    const result = await tool.handler({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      timeoutMs: 1_000
    })

    expect(result).toContain('Timed out after 1000 ms')
    expect(result).not.toContain('Exit code null')
    // And it says what to do differently, since repeating it cannot work.
    expect(result).toContain('timeoutMs')
  })

  it('always shows the timeout on the approval card, including the default', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    // The default is the case most likely to surprise whoever approves it —
    // it is the one they did not choose — and it was the one not shown.
    await tool.handler({ command: 'npm test' })

    expect(requests[0]?.detail).toContain('Timeout: 60000 ms')
  })

  it('asks for confirmation before running, and honours a denial', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'echo should-not-run' })

    expect(requests).toHaveLength(1)
    expect(result).toContain('denied')
  })

  it('shows the configured shell and requested timeout in the approval path', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      commandShell: 'custom-shell',
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string; timeoutMs?: number }) => Promise<string>
    }

    await tool.handler({ command: 'echo hello', timeoutMs: 120_000 })

    expect(requests[0]?.detail).toContain('Shell: custom-shell')
    expect(requests[0]?.detail).toContain('Timeout: 120000 ms')
  })

  it('bounds a long command in the transcript while preserving it for approval', async () => {
    const requests: ToolConfirmRequest[] = []
    const { calls, emit } = captureCalls()
    const command = `echo ${'x'.repeat(2_000)}`
    const ctx = {
      ...createMockContext(workspace),
      emit,
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    await tool.handler({ command })

    expect(requests[0]?.detail).toContain(command)
    expect(calls[0]?.title.length).toBeLessThanOrEqual(360)
    expect(calls[0]?.title).toContain('long command payload omitted')
  })

  it('classifies an obviously destructive command with the destructive risk badge', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    await tool.handler({ command: 'rm -rf /' })

    expect(requests[0]?.risk).toBe('destructive')
  })
})

describe('parseRunCommandVerification', () => {
  it('parses a passing command', () => {
    expect(
      parseRunCommandVerification({
        name: 'run_command',
        status: 'success',
        title: 'Run: npm test',
        detail: 'exit 0'
      })
    ).toEqual({ command: 'npm test', status: 'passed' })
  })

  it('parses a failing command', () => {
    expect(
      parseRunCommandVerification({
        name: 'run_command',
        status: 'success',
        title: 'Run: npm run build',
        detail: 'exit 1'
      })
    ).toEqual({ command: 'npm run build', status: 'failed' })
  })

  it('treats a non-numeric exit code from a command that did exit as failed', () => {
    expect(
      parseRunCommandVerification({
        name: 'run_command',
        status: 'success',
        title: 'Run: npm test',
        detail: 'exit ENOENT'
      })
    ).toEqual({ command: 'npm test', status: 'failed' })
  })

  it('records nothing for a run that was killed rather than finishing', () => {
    // "The tests failed" and "the tests never finished" are different claims,
    // and only one of them is supported by a killed run. These used to arrive
    // as `exit null`, match as not-zero, and be recorded as a real failure.
    for (const detail of ['timed out', 'output limit', 'stopped']) {
      expect(
        parseRunCommandVerification({
          name: 'run_command',
          status: 'success',
          title: 'Run: npm test',
          detail
        })
      ).toBeNull()
    }
  })

  it('returns null for a different tool', () => {
    expect(
      parseRunCommandVerification({
        name: 'read_file',
        status: 'success',
        title: 'Read x',
        detail: undefined
      })
    ).toBeNull()
  })

  it('returns null for a denied or errored call (never reached a real exit code)', () => {
    expect(
      parseRunCommandVerification({
        name: 'run_command',
        status: 'denied',
        title: 'Run: rm -rf /',
        detail: 'Denied by user'
      })
    ).toBeNull()
    expect(
      parseRunCommandVerification({
        name: 'run_command',
        status: 'error',
        title: 'Run: npm test',
        detail: 'Command failed to spawn'
      })
    ).toBeNull()
  })
})

/**
 * Read-shaped shell commands, classified for the ledger's gathering ladder.
 *
 * A live run, told by the ladder to stop gathering, said so in its own reply —
 * "The system is blocking repeated info calls. Let me use a command to read the
 * file content I need" — and then made twenty-two shell reads. Every utility
 * missing from `DIRECT_READ_RE` is a hole of exactly that shape.
 */
describe('shell reads count as gathering, shell writes do not', () => {
  it.each([
    ["sed -n '40,50p' js/app.js", true],
    ["awk 'NR>40 && NR<50' js/app.js", true],
    ['head -n 100 js/app.js | tail -n 30', true],
    ['nl -ba js/app.js', true],
    ['wc -l js/app.js', true],
    ["Select-String -Path 'js/app.js' -Pattern 'ambient'", true],
    ["(Get-Content 'js/app.js') | Select-Object -Index 39,40,41", true],
    // In-place editing is the one form of sed that writes.
    ["sed -i 's/a/b/' js/app.js", false],
    ["sed -i.bak 's/a/b/' js/app.js", false],
    ['npm run build', false],
    ['cat js/app.js > copy.js', false]
  ])('%s -> observational: %s', (command, expected) => {
    expect(isObservationalCommand(command)).toBe(expected)
  })

  it('reports the effective kind a shell read should be counted as', () => {
    expect(
      effectiveToolKind(
        { name: 'run_command', kind: 'command', title: "Run: sed -n '1,5p' a.js" },
        'read'
      )
    ).toBe('read')
    expect(
      effectiveToolKind({ name: 'run_command', kind: 'command', title: 'Run: npm test' }, 'read')
    ).toBe('command')
  })
})

/**
 * Two calls that look like work and are not.
 *
 * Both cost a live run real time: `python -m http.server 8000` blocked until
 * the command timeout and was then killed, and `Start-Process "http://…"`
 * scored as a mutation and reset the ledger's gathering streak.
 */
describe('commands that cannot advance the task', () => {
  it.each([
    'python -m http.server 8000',
    'python3 -m http.server',
    'npx serve .',
    'npm run dev',
    'npm start',
    'vite',
    'php -S localhost:8000',
    'hugo server'
  ])('refuses %s before running it', (command) => {
    const message = checkLongRunningServer(command)
    expect(message).toContain('does not exit')
    expect(message).toContain('preview_html')
  })

  it.each(['npm run build', 'npm test', 'ls -la', 'git status', 'cargo test'])(
    'lets %s run',
    (command) => {
      expect(checkLongRunningServer(command)).toBeNull()
    }
  )

  it('does not count opening a URL in a browser as work', () => {
    // `Start-Process` is in the mutation list, correctly for a real launch —
    // but a browser open changes nothing and gathers nothing, and scoring it as
    // a mutation reset the gathering streak.
    expect(isObservationalCommand('Start-Process "http://localhost:8000/index.html"')).toBe(true)
    expect(isObservationalCommand('start http://localhost:8000/')).toBe(true)
    expect(isObservationalCommand('xdg-open https://example.com')).toBe(true)
  })

  it('still counts a real Start-Process as work', () => {
    expect(isObservationalCommand('Start-Process npm -ArgumentList "run","build"')).toBe(false)
    expect(isObservationalCommand('Start-Process notepad.exe')).toBe(false)
  })

  it('does not count waiting as work', () => {
    // `NON_READ_POWERSHELL_VERB_RE`'s `Start-` prefix scored `Start-Sleep` as a
    // mutation, so a reply that read one file and slept twice looked like it had
    // changed something — which suppressed the "no files were changed" note it
    // should have carried.
    expect(isObservationalCommand('Start-Sleep -Seconds 4')).toBe(true)
    expect(isObservationalCommand('timeout /t 4 /nobreak')).toBe(true)
    expect(isObservationalCommand('sleep 2')).toBe(true)
    expect(isObservationalCommand('ping -n 5 127.0.0.1')).toBe(true)
  })
})
