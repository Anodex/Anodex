import { describe, expect, it } from 'vitest'
import { resolveRequestedFolder, sameFolder } from '../folderAccess'

const linux = {
  home: '/home/sam',
  desktop: '/home/sam/Desktop',
  documents: '/home/sam/Documents',
  downloads: '/home/sam/Downloads'
}
const windows = {
  home: 'C:\\Users\\Sam',
  desktop: 'C:\\Users\\Sam\\OneDrive\\Desktop',
  documents: 'C:\\Users\\Sam\\Documents',
  downloads: 'C:\\Users\\Sam\\Downloads'
}
const winEnv = { SystemDrive: 'C:', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }

describe('resolveRequestedFolder', () => {
  it('names a folder from home, an everyday folder, or a full path', () => {
    expect(resolveRequestedFolder('~/projects/site', linux, 'linux')).toEqual({
      ok: true,
      path: '/home/sam/projects/site'
    })
    expect(resolveRequestedFolder('Desktop/minecraft-server', linux, 'linux')).toEqual({
      ok: true,
      path: '/home/sam/Desktop/minecraft-server'
    })
    expect(resolveRequestedFolder('/srv/games', linux, 'linux')).toEqual({
      ok: true,
      path: '/srv/games'
    })
  })

  it('follows a Desktop the OS has moved, rather than assuming ~/Desktop', () => {
    expect(resolveRequestedFolder('desktop\\minecraft', windows, 'win32', winEnv)).toEqual({
      ok: true,
      path: 'C:\\Users\\Sam\\OneDrive\\Desktop\\minecraft'
    })
  })

  it('refuses a whole drive, the whole home folder, and system folders', () => {
    for (const [request, folders, platform, env] of [
      ['/', linux, 'linux', {}],
      ['~', linux, 'linux', {}],
      ['/etc/nginx', linux, 'linux', {}],
      ['C:\\', windows, 'win32', winEnv],
      ['c:\\windows\\system32', windows, 'win32', winEnv],
      ['C:\\Users\\Sam', windows, 'win32', winEnv],
      ['/System/Library', { home: '/Users/sam' }, 'darwin', {}]
    ] as const) {
      expect(resolveRequestedFolder(request, folders, platform, env)).toMatchObject({ ok: false })
    }
  })

  it('does not mistake a folder that only starts like a system one for it', () => {
    expect(resolveRequestedFolder('/usrdata/games', linux, 'linux')).toMatchObject({ ok: true })
  })

  it('asks for a real path rather than guessing at a bare name', () => {
    expect(resolveRequestedFolder('minecraft', linux, 'linux')).toMatchObject({ ok: false })
  })
})

describe('sameFolder', () => {
  it('ignores case where the file system does, and trailing separators', () => {
    expect(sameFolder('C:\\Users\\Sam\\Game\\', 'c:\\users\\sam\\game', 'win32')).toBe(true)
    expect(sameFolder('/home/sam/Game', '/home/sam/game', 'linux')).toBe(false)
    expect(sameFolder('/home/sam/game/', '/home/sam/game', 'linux')).toBe(true)
  })
})

describe("the user's own temp folder", () => {
  it('is allowed even where it sits under a system folder, as on macOS', () => {
    const mac = { home: '/Users/sam', temp: '/var/folders/36/xyz/T' }
    expect(resolveRequestedFolder('/var/folders/36/xyz/T/scratch', mac, 'darwin')).toEqual({
      ok: true,
      path: '/var/folders/36/xyz/T/scratch'
    })
    expect(resolveRequestedFolder('/var/log', mac, 'darwin')).toMatchObject({ ok: false })
  })
})
