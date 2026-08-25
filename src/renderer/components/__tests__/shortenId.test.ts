import { describe, expect, it } from 'vitest'
import { shortenId } from '../shortenId'

/**
 * Anodex already prefixes every surface distinctly. The short form has to keep
 * that prefix, because it is the thing that says which surface a record came
 * from at a glance.
 */
describe('shortenId', () => {
  it('keeps the prefix and the identifying segment, drops the random tail', () => {
    expect(shortenId('run_mt90zawo_qhcfg')).toBe('run_mt90zawo')
    expect(shortenId('critical_msgz2z0u_3akvf')).toBe('critical_msgz2z0u')
    expect(shortenId('task_mre8uedj_38acz')).toBe('task_mre8uedj')
    expect(shortenId('p_mt6bc8wx_0mno0')).toBe('p_mt6bc8wx')
  })

  it('keeps a uuid-shaped chat id readable', () => {
    expect(shortenId('c_26ea88bf-ed7e-4724-9298-348067e5574a')).toBe('c_26ea88bf')
  })

  it('never loses the prefix that identifies the surface', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['run_mt90zawo_qhcfg', 'run_'],
      ['critical_msgz2z0u_3akvf', 'critical_'],
      ['task_mre8uedj_38acz', 'task_'],
      ['p_mt6bc8wx_0mno0', 'p_'],
      ['c_26ea88bf-ed7e-4724-9298-348067e5574a', 'c_'],
      ['agent_conv_mt90zawo_b120d', 'agent_conv_']
    ]
    for (const [id, prefix] of cases) {
      expect(shortenId(id).startsWith(prefix)).toBe(true)
    }
  })

  it('leaves an id that is already short alone', () => {
    expect(shortenId('task_abc')).toBe('task_abc')
  })
})
