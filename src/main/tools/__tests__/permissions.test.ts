import { describe, expect, it } from 'vitest'
import { classifyCommandRisk, needsTurnGate, resolvePermission } from '../permissions'

describe('resolvePermission', () => {
  it('trivial actions never need confirmation, regardless of mode', () => {
    expect(resolvePermission('ask', 'trivial')).toBe('auto')
    expect(resolvePermission('full', 'trivial')).toBe('auto')
    expect(resolvePermission('untethered', 'trivial')).toBe('auto')
  })

  it('ask mode confirms everything except trivial actions', () => {
    expect(resolvePermission('ask', 'safe')).toBe('confirm')
    expect(resolvePermission('ask', 'sensitive')).toBe('confirm')
    expect(resolvePermission('ask', 'destructive')).toBe('confirm')
  })

  it('full mode auto-runs safe actions, confirms sensitive/destructive', () => {
    expect(resolvePermission('full', 'safe')).toBe('auto')
    expect(resolvePermission('full', 'sensitive')).toBe('confirm')
    expect(resolvePermission('full', 'destructive')).toBe('confirm')
  })

  it('untethered mode auto-runs safe/sensitive, still confirms destructive', () => {
    expect(resolvePermission('untethered', 'safe')).toBe('auto')
    expect(resolvePermission('untethered', 'sensitive')).toBe('auto')
    expect(resolvePermission('untethered', 'destructive')).toBe('confirm')
  })
})

describe('needsTurnGate', () => {
  it('never gates untethered mode — that tier is meant to run with almost no prompts', () => {
    expect(needsTurnGate('untethered', 'safe', false)).toBe(false)
    expect(needsTurnGate('untethered', 'sensitive', false)).toBe(false)
    expect(needsTurnGate('untethered', 'trivial', false)).toBe(false)
    expect(needsTurnGate('untethered', 'destructive', false)).toBe(false)
  })

  it('also gates the first safe call in full mode, since that tier auto-runs there too', () => {
    expect(needsTurnGate('full', 'safe', false)).toBe(true)
    expect(needsTurnGate('full', 'safe', true)).toBe(false)
  })

  it('never gates full-mode sensitive/destructive — those already confirm every time', () => {
    expect(needsTurnGate('full', 'sensitive', false)).toBe(false)
    expect(needsTurnGate('full', 'destructive', false)).toBe(false)
  })

  it('never applies to ask mode at any risk — every call already confirms there', () => {
    expect(needsTurnGate('ask', 'safe', false)).toBe(false)
    expect(needsTurnGate('ask', 'sensitive', false)).toBe(false)
    expect(needsTurnGate('ask', 'destructive', true)).toBe(false)
  })
})

describe('classifyCommandRisk', () => {
  it('flags obviously destructive commands', () => {
    expect(classifyCommandRisk('rm -rf node_modules')).toBe('destructive')
    expect(classifyCommandRisk('git push --force origin main')).toBe('destructive')
    expect(classifyCommandRisk('git push origin +main')).toBe('destructive')
    expect(classifyCommandRisk('git reset --hard HEAD~1')).toBe('destructive')
    expect(classifyCommandRisk('DROP TABLE users;')).toBe('destructive')
    expect(classifyCommandRisk('format c: /q')).toBe('destructive')
    expect(classifyCommandRisk('rmdir /s /q build')).toBe('destructive')
    expect(classifyCommandRisk('Remove-Item . -Recurse -Force')).toBe('destructive')
    expect(classifyCommandRisk('rm -r -f build')).toBe('destructive')
  })

  it('treats ordinary commands as sensitive, not destructive', () => {
    expect(classifyCommandRisk('npm test')).toBe('sensitive')
    expect(classifyCommandRisk('git status')).toBe('sensitive')
    expect(classifyCommandRisk('npm install lodash')).toBe('sensitive')
  })

  // Every spelling below is the same command. `sensitive` auto-runs in
  // `untethered`, which is the mode scheduled tasks and agent runs use, so a
  // spelling that slips through is a recursive forced delete executing in a
  // run with nobody watching.
  it('flags a recursive forced delete however the flags are written', () => {
    expect(classifyCommandRisk('rm -f -r build')).toBe('destructive')
    expect(classifyCommandRisk('rm --recursive --force /')).toBe('destructive')
    expect(classifyCommandRisk('rm --force --recursive /')).toBe('destructive')
    expect(classifyCommandRisk('rm -r --force /')).toBe('destructive')
    expect(classifyCommandRisk('rm --recursive -f /')).toBe('destructive')
    expect(classifyCommandRisk('rm -v -r -f build')).toBe('destructive')
  })

  it('flags an abbreviated PowerShell recursive forced delete', () => {
    // PowerShell accepts any unambiguous prefix, so these run identically to
    // the fully spelled parameters the patterns used to require.
    expect(classifyCommandRisk('Remove-Item . -rec -fo')).toBe('destructive')
    expect(classifyCommandRisk('Remove-Item . -Force -Recurse')).toBe('destructive')
  })

  // The three below pass against the pre-fix patterns too. They are not
  // evidence of a fix; they are what stops the broader pattern that replaced
  // those patterns from over-matching, which in an unattended run means
  // refusing ordinary commands rather than letting dangerous ones through.
  it('does not flag a delete that is only recursive, or only forced', () => {
    // Both flags together are the destructive combination; either alone is an
    // ordinary command, and over-classifying means an unattended run refuses it.
    expect(classifyCommandRisk('rm -r build')).toBe('sensitive')
    expect(classifyCommandRisk('rm -f build.txt')).toBe('sensitive')
    expect(classifyCommandRisk('Remove-Item build.txt -Force')).toBe('sensitive')
  })

  it('does not let a second command in the line complete the pair', () => {
    // The force flag here belongs to `grep`, not to the delete.
    expect(classifyCommandRisk('rm -r dist | grep -f pattern')).toBe('sensitive')
    expect(classifyCommandRisk('rm -r dist; echo -f')).toBe('sensitive')
  })

  it('does not mistake a dash inside a filename for a flag', () => {
    expect(classifyCommandRisk('rm file-r.txt file-f.txt')).toBe('sensitive')
  })
})

/**
 * Three ways to destroy work that the list already covered in another syntax.
 *
 * `destructive` is the tier `headlessConfirm` refuses outright, so an
 * unattended run auto-approves everything below it. `git reset --hard` and
 * `git clean -f` are both on the list, which settles that "discards
 * uncommitted work" belongs there — and `git checkout -- .` and `git restore .`
 * do exactly that and were not. `> /dev/sda` is on the list, which settles that
 * raw-device writes belong there — and `dd of=/dev/sda` is the same act.
 *
 * This completes categories the list already asserts rather than widening the
 * policy. The distinction that matters is below: switching branches must stay
 * ordinary, or every normal git workflow starts demanding confirmation.
 */
describe('destructive commands the list had missed', () => {
  it('treats discarding the working tree as destructive', () => {
    for (const command of [
      'git checkout -- .',
      'git checkout .',
      'git checkout -- src/main.ts',
      'git restore .',
      'git restore --worktree src/',
      'git restore src/main.ts'
    ]) {
      expect(classifyCommandRisk(command), command).toBe('destructive')
    }
  })

  it('leaves ordinary git navigation alone', () => {
    // The whole point of scoping this to path arguments: a branch switch
    // destroys nothing, and classifying it would make every workflow confirm.
    for (const command of [
      'git checkout main',
      'git checkout -b feature/thing',
      'git checkout --track origin/main',
      'git restore --staged src/main.ts',
      'git status',
      'git diff'
    ]) {
      expect(classifyCommandRisk(command), command).toBe('sensitive')
    }
  })

  it('treats a raw write to a block device as destructive', () => {
    for (const command of [
      'dd if=/dev/zero of=/dev/sda',
      'dd if=backup.img of=/dev/nvme0n1 bs=4M',
      'dd if=/dev/zero of=/dev/disk2'
    ]) {
      expect(classifyCommandRisk(command), command).toBe('destructive')
    }
  })

  it('leaves an ordinary dd to a file alone', () => {
    expect(classifyCommandRisk('dd if=/dev/zero of=./test.img bs=1M count=10')).toBe('sensitive')
  })
})
