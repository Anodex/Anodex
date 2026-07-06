import { describe, expect, it } from 'vitest'
import { detectLang, isImageFile } from '../fileTypeIcons'

describe('detectLang', () => {
  it('detects common web/coding extensions, case-insensitively', () => {
    expect(detectLang('app.JS')).toBe('javascript')
    expect(detectLang('Component.tsx')).toBe('typescript')
    expect(detectLang('main.py')).toBe('python')
    expect(detectLang('package.json')).toBe('json')
    expect(detectLang('styles.scss')).toBe('css')
    expect(detectLang('index.html')).toBe('html5')
    expect(detectLang('README.md')).toBe('markdown')
    expect(detectLang('config.yaml')).toBe('yaml')
    expect(detectLang('lib.rs')).toBe('rust')
    expect(detectLang('main.go')).toBe('go')
  })

  it('recognizes git dotfiles that have no extension', () => {
    expect(detectLang('.gitignore')).toBe('git')
    expect(detectLang('.gitattributes')).toBe('git')
  })

  it('returns null for a name with no extension', () => {
    expect(detectLang('Dockerfile')).toBeNull()
    expect(detectLang('LICENSE')).toBeNull()
  })

  it('returns null for an unrecognized extension', () => {
    expect(detectLang('image.png')).toBeNull()
    expect(detectLang('archive.zip')).toBeNull()
  })

  it('does not misdetect a leading-dot filename with no further extension', () => {
    expect(detectLang('.env')).toBeNull()
  })
})

describe('isImageFile', () => {
  it('recognizes common image formats, case-insensitively', () => {
    for (const name of [
      'photo.png',
      'avatar.JPG',
      'pic.jpeg',
      'anim.gif',
      'hero.webp',
      'icon.svg',
      'legacy.bmp',
      'favicon.ico',
      'shot.AVIF',
      'scan.tiff'
    ]) {
      expect(isImageFile(name)).toBe(true)
    }
  })

  it('returns false for non-image files and extensionless names', () => {
    expect(isImageFile('main.ts')).toBe(false)
    expect(isImageFile('README.md')).toBe(false)
    expect(isImageFile('archive.zip')).toBe(false)
    expect(isImageFile('Dockerfile')).toBe(false)
    expect(isImageFile('.env')).toBe(false)
  })
})
