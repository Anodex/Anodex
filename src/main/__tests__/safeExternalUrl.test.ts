import { describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn((): Promise<void> => Promise.resolve())
vi.mock('electron', () => ({ shell: { openExternal } }))

const { isSafeExternalUrl, openExternalSafely } = await import('../safeExternalUrl')

describe('isSafeExternalUrl', () => {
  it('allows the two schemes a browser is for', () => {
    expect(isSafeExternalUrl('https://example.com/page?q=1#x')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
  })

  it.each([
    // Hands the file to whatever application claims it.
    'file:///C:/Windows/System32/calc.exe',
    // The Follina delivery scheme, and its neighbours.
    'ms-msdt:/id PCWDiagnostic',
    'ms-officecmd:{"id":3}',
    'search-ms:query=x',
    // Runs in whatever context resolves it.
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    // A UNC path reached through a scheme the OS understands.
    'smb://attacker/share',
    // Not a URL at all.
    'not a url',
    ''
  ])('refuses %s', (value) => {
    expect(isSafeExternalUrl(value)).toBe(false)
  })

  it('refuses credentials embedded in the URL', () => {
    // Reads as one host, goes to another.
    expect(isSafeExternalUrl('https://www.paypal.com@evil.example/login')).toBe(false)
    expect(isSafeExternalUrl('https://user:pass@example.com')).toBe(false)
  })

  it('is not fooled by case in the scheme', () => {
    expect(isSafeExternalUrl('FILE:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('HTTPS://example.com')).toBe(true)
  })
})

describe('openExternalSafely', () => {
  it('opens a safe URL and reports it did', async () => {
    openExternal.mockClear()
    await expect(openExternalSafely('https://example.com')).resolves.toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('never reaches the operating system with an unsafe one', async () => {
    openExternal.mockClear()
    await expect(openExternalSafely('file:///C:/Windows/System32/calc.exe')).resolves.toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports failure rather than throwing into a click handler', async () => {
    openExternal.mockClear()
    openExternal.mockRejectedValueOnce(new Error('no handler'))
    await expect(openExternalSafely('https://example.com')).resolves.toBe(false)
  })
})
