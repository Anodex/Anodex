import { describe, expect, it } from 'vitest'
import { classifyExclusion, MACHINE_BOUND_NAMES, shouldBackUp } from '../backupPaths'

/** The real top-level contents of a populated `userData` directory. */
const REAL_ENTRIES = [
  'agent-runs',
  'conversation-assets',
  'conversations',
  'critical-thinking',
  'email-auth.json',
  'lockfile',
  'mcp-auth.json',
  'mcp-servers.json',
  'memory',
  'model-reliability',
  'models',
  'projects',
  'projects.json',
  'scheduled-tasks',
  'settings.json',
  'skills',
  'token-activity',
  'Cache',
  'GPUCache',
  'Local Storage',
  'Preferences'
]

describe('shouldBackUp', () => {
  it('keeps every store that holds the user’s own data', () => {
    const kept = REAL_ENTRIES.filter(shouldBackUp)
    expect(kept).toEqual([
      'agent-runs',
      'conversation-assets',
      'conversations',
      'critical-thinking',
      'email-auth.json',
      'mcp-auth.json',
      'mcp-servers.json',
      'memory',
      'model-reliability',
      'projects',
      'projects.json',
      'scheduled-tasks',
      'settings.json',
      'skills',
      'token-activity'
    ])
  })

  it('excludes downloaded model weights, which are gigabytes and re-downloadable', () => {
    expect(shouldBackUp('models')).toBe(false)
  })

  it('excludes the lockfile, which breaks a restored copy', () => {
    expect(shouldBackUp('lockfile')).toBe(false)
  })

  it('excludes Chromium runtime state', () => {
    for (const name of ['Cache', 'Code Cache', 'GPUCache', 'Local Storage', 'Preferences']) {
      expect(shouldBackUp(name)).toBe(false)
    }
  })

  it('keeps an unrecognised entry rather than dropping it', () => {
    // A store added by a future feature must land in backups without anyone
    // remembering to update this file — silently missing data is the one
    // failure a backup cannot have.
    expect(shouldBackUp('some-future-store')).toBe(true)
  })
})

describe('classifyExclusion', () => {
  it('separates regenerable runtime state from re-downloadable weights', () => {
    expect(classifyExclusion('GPUCache')?.reason).toBe('runtime')
    expect(classifyExclusion('models')?.reason).toBe('redownloadable')
  })

  it('returns null for anything that is actually backed up', () => {
    expect(classifyExclusion('conversations')).toBeNull()
  })
})

describe('MACHINE_BOUND_NAMES', () => {
  it('names files that are copied but will not decrypt on another machine', () => {
    for (const name of MACHINE_BOUND_NAMES) {
      expect(shouldBackUp(name)).toBe(true)
    }
  })
})
