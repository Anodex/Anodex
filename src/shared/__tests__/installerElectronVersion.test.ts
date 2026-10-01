import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The branded installer must run the same Electron as the app.
 *
 * `scripts/package-app.mjs` refuses to package when they differ, which is right,
 * but it only runs at release time. A pull request that bumps the app's Electron
 * (Dependabot opens one for every patch) passes CI with the installer left behind,
 * and the mismatch surfaces on the tag, after the merge, as a release that will
 * not build. This moves that refusal to the pull request.
 */
describe('installer-shell Electron', () => {
  const root = resolve(__dirname, '../../..')
  const rootLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string }>
  }
  const shell = JSON.parse(
    readFileSync(resolve(root, 'installer-shell', 'package.json'), 'utf8')
  ) as { devDependencies?: Record<string, string> }
  const shellLock = JSON.parse(
    readFileSync(resolve(root, 'installer-shell', 'package-lock.json'), 'utf8')
  ) as { packages?: Record<string, { version?: string }> }

  const appElectron = rootLock.packages?.['node_modules/electron']?.version

  it('pins the exact version the app ships', () => {
    expect(appElectron).toMatch(/^\d+\.\d+\.\d+$/)
    expect(shell.devDependencies?.electron).toBe(appElectron)
  })

  it('has a lockfile that installs that version', () => {
    expect(shellLock.packages?.['node_modules/electron']?.version).toBe(appElectron)
  })
})
