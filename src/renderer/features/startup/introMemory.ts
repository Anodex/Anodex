const KEY = 'anodex:introPlayedVersion'

/** The app version the full startup intro last played for, if any. */
export function introPlayedFor(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Remember that this version has had its intro, so the next launch is brief. */
export function rememberIntroPlayed(version: string): void {
  try {
    localStorage.setItem(KEY, version)
  } catch {
    // Storage unavailable: every launch plays the full intro, which is safe.
  }
}
