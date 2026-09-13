import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isStoredPersonalityPicture, personalityPictureKey } from '../personalityPictureAccess'

const store = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'anodex', 'personality-images')

describe('personalityPictureKey', () => {
  it('names the file, not where it lives', () => {
    const key = personalityPictureKey(join(store, '3f2a.png'))
    expect(key).toBe('3f2a.png')
    expect(key).not.toContain('Users')
  })

  it('is null for a personality without a picture', () => {
    expect(personalityPictureKey(undefined)).toBeNull()
    expect(personalityPictureKey('')).toBeNull()
  })
})

describe('isStoredPersonalityPicture', () => {
  it('serves a picture the app copied in', () => {
    expect(isStoredPersonalityPicture(join(store, '3f2a.png'), store)).toBe(true)
  })

  it('refuses anything outside the store, however it is spelled', () => {
    // A hand-edited or restored setting must not turn this into a file reader.
    expect(isStoredPersonalityPicture(join('C:', 'Users', 'me', '.ssh', 'id_ed25519'), store)).toBe(
      false
    )
    expect(isStoredPersonalityPicture(join(store, '..', 'settings.json'), store)).toBe(false)
    expect(isStoredPersonalityPicture(`${store}-evil${join('/', 'x.png')}`, store)).toBe(false)
    expect(isStoredPersonalityPicture(store, store)).toBe(false)
  })
})
