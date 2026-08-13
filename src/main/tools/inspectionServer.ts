import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import { resolveInWorkspace } from './workspace'
import { createLogger } from '../utils/logger'

const log = createLogger('inspection-server')

/**
 * A short-lived static file server used only by visual inspection.
 *
 * ## Why a server instead of a data: URL
 *
 * `inspect_visual` used to render pages by base64-encoding a transformed copy
 * of the HTML into a `data:text/html` URL. That document has an opaque origin
 * and no base URL, which breaks every origin- and path-sensitive browser
 * feature a modern page depends on: ES modules, import maps, `fetch`, relative
 * asset paths, and anything gated on a secure/normal origin. A page whose
 * sandbox is driven by `<script type="module">` could therefore *never* render
 * under inspection, and Anodex reported that blank render to the model as
 * fact. See `docs/REVIEW_LOG_VISUAL_RUNTIME_EVIDENCE.md`.
 *
 * Serving the real files over `http://127.0.0.1` makes the inspected page load
 * the same way it would in the user's browser, which is the only way a
 * screenshot can be evidence of anything.
 *
 * ## Confinement
 *
 * - Binds to `127.0.0.1` on an ephemeral port; never reachable off-box.
 * - Every request path is resolved through {@link resolveInWorkspace}, so `..`
 *   traversal and symlinks escaping the workspace are refused exactly as they
 *   are for file tools.
 * - Requests must carry a per-inspection random token prefix, so another local
 *   process that happens to guess the port still cannot enumerate the
 *   workspace.
 * - `GET`/`HEAD` only. No directory listings, no writes.
 * - The lifetime is one inspection: {@link InspectionServer.close} is called
 *   from the same `finally` that destroys the render window, and force-destroys
 *   keep-alive sockets so teardown cannot hang.
 */
export interface InspectionServer {
  /** `http://127.0.0.1:<port>` — the origin the page is served from. */
  readonly origin: string
  /** Absolute URL for a workspace-relative path, including the token prefix. */
  urlFor(relativePath: string): string
  /** Stop listening and destroy any open sockets. Safe to call more than once. */
  close(): Promise<void>
}

export interface InspectionServerOptions {
  /**
   * Rewrites HTML documents as they are served. Used to inject the diagnostics
   * collector and preview chrome, so the page under test is byte-identical to
   * what is on disk apart from Anodex's own additions.
   */
  transformHtml?: (html: string, relativePath: string) => string
}

/**
 * Content types by extension.
 *
 * This table is load-bearing, not cosmetic. A browser refuses to execute a
 * `<script type="module">` served with a non-JavaScript MIME type, so getting
 * `.js` wrong here would reproduce the exact blank-canvas failure this whole
 * change exists to fix — just through a different mechanism.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Largest file streamed to the render window, so a stray huge asset cannot stall an inspection. */
const MAX_SERVED_BYTES = 64 * 1024 * 1024

export async function startInspectionServer(
  workspaceRoot: string,
  options: InspectionServerOptions = {}
): Promise<InspectionServer> {
  // Guessing the ephemeral port is not enough to read the workspace.
  const token = randomUUID()
  const sockets = new Set<Socket>()

  const server = createServer((request, response) => {
    handleRequest(request, response, workspaceRoot, token, options).catch((error: unknown) => {
      log.warn('Inspection request failed:', error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  // Keep-alive connections would otherwise keep `server.close()` pending until
  // the render window's sockets time out on their own.
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const port = await listenOnLoopback(server)
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    urlFor(relativePath: string): string {
      const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
      const encoded = clean.split('/').map(encodeURIComponent).join('/')
      return `${origin}/${token}/${encoded}`
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close(() => resolve())
      })
    }
  }
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0 asks the OS for an ephemeral port; binding explicitly to the
    // loopback interface keeps the workspace off every other interface.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      if (!address) {
        reject(new Error('Inspection server did not report a listening port.'))
        return
      }
      resolve(address.port)
    })
  })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string,
  token: string,
  options: InspectionServerOptions
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  const relativePath = requestedPath(request.url ?? '/', token)
  if (relativePath === null) {
    response.writeHead(404)
    response.end()
    return
  }

  let file: string
  try {
    file = resolveInWorkspace(workspaceRoot, relativePath)
  } catch {
    // Outside the workspace — reported as 403 rather than 404 so a genuine
    // traversal attempt is distinguishable from a typo in a test.
    response.writeHead(403)
    response.end()
    return
  }

  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    response.writeHead(404)
    response.end()
    return
  }
  if (info.size > MAX_SERVED_BYTES) {
    response.writeHead(413)
    response.end()
    return
  }

  const extension = extname(file).toLowerCase()
  const contentType = CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE
  const isHtml = extension === '.html' || extension === '.htm'

  // Inspection must always see current disk contents; a cached response could
  // silently show the pre-edit page after a fix and make a broken change look
  // verified.
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  }

  if (isHtml && options.transformHtml) {
    const html = await readFile(file, 'utf-8')
    const transformed = options.transformHtml(html, relativePath)
    const body = Buffer.from(transformed, 'utf-8')
    response.writeHead(200, { ...headers, 'Content-Length': String(body.byteLength) })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
    return
  }

  response.writeHead(200, { ...headers, 'Content-Length': String(info.size) })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
}

/**
 * The workspace-relative path a request is asking for, or null if it does not
 * carry this inspection's token. Query strings and fragments are dropped —
 * cache-busting suffixes are common and must still resolve to the real file.
 */
function requestedPath(requestUrl: string, token: string): string | null {
  const withoutQuery = requestUrl.split(/[?#]/, 1)[0]
  const prefix = `/${token}/`
  if (!withoutQuery.startsWith(prefix)) return null
  const encoded = withoutQuery.slice(prefix.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
