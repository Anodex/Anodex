import { app } from 'electron'
import type { KnownFolders } from './folderAccess'

/**
 * The everyday folders, where this computer keeps them.
 *
 * Asked of Electron rather than built from the home folder, because a Desktop
 * is not always `~/Desktop`: OneDrive moves it on Windows, and other languages
 * rename it on Linux. A folder Electron cannot name is left out rather than
 * guessed.
 */
export function readKnownFolders(): KnownFolders {
  const read = (name: 'desktop' | 'documents' | 'downloads' | 'home'): string | undefined => {
    try {
      return app.getPath(name)
    } catch {
      return undefined
    }
  }
  return {
    home: read('home'),
    desktop: read('desktop'),
    documents: read('documents'),
    downloads: read('downloads')
  }
}
