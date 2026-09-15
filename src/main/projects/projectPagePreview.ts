import { stat } from 'node:fs/promises'
import { startInspectionServer, type InspectionServer } from '../tools/inspectionServer'
import { resolveInWorkspace } from '../tools/workspace'

/**
 * Where a page in a project can be opened in the user's own browser.
 *
 * Served, not opened as a file. A page that loads its data with `fetch` — the
 * website Anodex built in testing reads its projects from `projects.json` — shows
 * nothing when opened from disk, because a `file://` page may not fetch. The same
 * loopback server `inspect_visual` uses serves it the way a real site is served:
 * `127.0.0.1` only, confined to the project folder, behind a random token.
 *
 * One server per project folder, kept for the rest of the session, so a page opened
 * again reuses the address the browser already has open.
 */
const servers = new Map<string, Promise<InspectionServer>>()

export async function projectPageUrl(folderPath: string, relativePath: string): Promise<string> {
  if (!/\.html?$/i.test(relativePath)) throw new Error('Only web pages can be opened in a browser.')
  const absolute = resolveInWorkspace(folderPath, relativePath)
  const file = await stat(absolute).catch(() => null)
  if (!file?.isFile()) throw new Error('That page is not in the project any more.')

  let server = servers.get(folderPath)
  if (!server) {
    server = startInspectionServer(folderPath)
    servers.set(folderPath, server)
    // A server that failed to start is not kept, so the next attempt tries again.
    server.catch(() => servers.delete(folderPath))
  }
  return (await server).urlFor(relativePath)
}

/** Stop every page server. For quitting. */
export async function closeProjectPageServers(): Promise<void> {
  const open = [...servers.values()]
  servers.clear()
  await Promise.allSettled(open.map(async (server) => (await server).close()))
}
