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
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
