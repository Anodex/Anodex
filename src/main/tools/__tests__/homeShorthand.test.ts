import { describe, expect, it } from 'vitest'
import { expandHomeShorthand } from '../homeShorthand'

describe('expandHomeShorthand', () => {
  it('reads the POSIX, PowerShell and cmd ways of naming home', () => {
    for (const raw of ['~', '$HOME', '${HOME}', '$env:USERPROFILE', '$env:HOME', '%USERPROFILE%']) {
      expect(expandHomeShorthand(raw, '/home/sam', 'linux'), raw).toBe('/home/sam')
    }
  })

  it('joins the rest with the platform’s own separators', () => {
    expect(expandHomeShorthand('~/Documents/notes', '/home/sam', 'linux')).toBe(
      '/home/sam/Documents/notes'
    )
    expect(expandHomeShorthand('$HOME\\Downloads', 'C:\\Users\\Sam', 'win32')).toBe(
      'C:\\Users\\Sam\\Downloads'
    )
    expect(expandHomeShorthand('%userprofile%/Desktop', 'C:\\Users\\Sam', 'win32')).toBe(
      'C:\\Users\\Sam\\Desktop'
    )
  })

  it('leaves alone a path that only starts with the same letters', () => {
    for (const raw of ['~backup', '$HOMEWORK/essay', 'Documents', '/srv/games', 'C:\\Data']) {
      expect(expandHomeShorthand(raw, '/home/sam', 'linux'), raw).toBeNull()
    }
  })
})
