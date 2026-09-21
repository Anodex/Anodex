import { shell } from 'electron'
import { createLogger } from './utils/logger'

const log = createLogger('external-url')

/**
 * Whether a URL is safe to hand to the operating system.
 *
 * `shell.openExternal` does not open a browser. It asks the OS to open the
 * URL with whichever application claims that scheme, and on Windows that
 * includes a long list of registered handlers — `file:` runs the default
 * application for the file, and assorted `ms-*:` schemes have been the
 * delivery mechanism for real remote-code bugs. So the scheme has to be
 * checked before the URL leaves the app, not after.
 *
 * `htmlPreviewWindow` already did this inline and the main window did not,
 * which is the whole reason this is a function: the rule was right, it just
 * was not in one place, and the two windows that skipped it are the two that
 * show content Anodex did not write — web-search results in a reply, and
 * anything a model puts a link around.
 *
 * Credentials in the URL are refused too. `https://user:pass@host` is a valid
 * URL and a well-worn way to make a link read as one host while going to
 * another.
 */
export function isSafeExternalUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return !url.username && !url.password
}

/**
 * Open a URL in the user's browser, or refuse it and say so.
 *
 * Refusing is deliberately quiet from the user's point of view — a link that
 * does nothing is the correct outcome for a link that should not exist, and
 * an error dialog here would be a prompt to try again. The log line is for
 * whoever is reading diagnostics afterwards.
 */
export async function openExternalSafely(value: string): Promise<boolean> {
  if (!isSafeExternalUrl(value)) {
    log.warn('Refused to open a URL that is not plain http(s)', value.slice(0, 120))
    return false
  }
  try {
    await shell.openExternal(value)
    return true
  } catch (error) {
    log.error('Failed to open external URL:', value, error)
    return false
  }
}
