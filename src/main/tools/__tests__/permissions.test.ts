import { describe, expect, it } from 'vitest'
import { classifyCommandRisk, resolvePermission } from '../permissions'

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

describe('classifyCommandRisk', () => {
  it('flags obviously destructive commands', () => {
    expect(classifyCommandRisk('rm -rf node_modules')).toBe('destructive')
    expect(classifyCommandRisk('git push --force origin main')).toBe('destructive')
    expect(classifyCommandRisk('git reset --hard HEAD~1')).toBe('destructive')
    expect(classifyCommandRisk('DROP TABLE users;')).toBe('destructive')
    expect(classifyCommandRisk('format c: /q')).toBe('destructive')
  })

  it('treats ordinary commands as sensitive, not destructive', () => {
    expect(classifyCommandRisk('npm test')).toBe('sensitive')
    expect(classifyCommandRisk('git status')).toBe('sensitive')
    expect(classifyCommandRisk('npm install lodash')).toBe('sensitive')
  })
})
