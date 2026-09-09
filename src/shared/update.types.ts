/** State of the auto-updater, broadcast from main to every renderer window. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  // Carries the version being downloaded so the UI can keep naming it: the
  // `download-progress` event itself has no version, and without it the
  // notice fell back to "Anodex null is available" the moment a download began.
  | { state: 'downloading'; version: string; percent: number }
  /** Downloaded, and being checked against the release signing key. */
  | { state: 'verifying'; version: string }
  | { state: 'downloaded'; version: string }
  /**
   * Downloaded and refused: the installer is not what Anodex published, or
   * carries no signature to judge it by. Deliberately distinct from `error` —
   * a failed signature check is a security result, not a network hiccup, and
   * the two should not read the same to somebody looking at the notice.
   */
  | { state: 'rejected'; version: string; reason: string }
  | { state: 'error'; message: string }
