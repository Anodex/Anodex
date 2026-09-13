import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { resolveMemoryDir } from '../MemoryStore'

const USER_DATA = join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'anodex')

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA } }))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

/**
 * The override exists so a benchmark run can own its memory store, and the
 * thing worth pinning is that it changes nothing for anybody who has not asked
 * for it. A default launch that quietly wrote its memory somewhere else would
 * lose the user's facts without ever failing.
 */
afterEach(() => {
  delete process.env.ANODEX_MEMORY_DIR
})

describe('resolveMemoryDir', () => {
  it('uses userData/memory when nothing is set', () => {
    expect(resolveMemoryDir()).toBe(join(USER_DATA, 'memory'))
  })

  it('uses ANODEX_MEMORY_DIR when a run asked for its own store', () => {
    process.env.ANODEX_MEMORY_DIR = join('C:', 'runs', 'qwen27b-8k.memory')

    expect(resolveMemoryDir()).toBe(join('C:', 'runs', 'qwen27b-8k.memory'))
  })

  it('ignores an empty or whitespace value rather than writing to the process cwd', () => {
    // `ANODEX_MEMORY_DIR=` is how a shell unsets a variable it still exports,
    // and an empty path would resolve to somewhere arbitrary rather than to
    // nowhere. Treated as absent, which is what it means.
    for (const blank of ['', '   ']) {
      process.env.ANODEX_MEMORY_DIR = blank
      expect(resolveMemoryDir()).toBe(join(USER_DATA, 'memory'))
    }
  })

  it('does not touch the real store when an override is in force', () => {
    // The whole point: the user's own memory is never read, written or cleared
    // to make a measurement possible.
    process.env.ANODEX_MEMORY_DIR = join('C:', 'runs', 'scratch')

    expect(resolveMemoryDir()).not.toContain(USER_DATA)
  })
})
