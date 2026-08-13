import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startInspectionServer, type InspectionServer } from '../inspectionServer'

describe('startInspectionServer', () => {
  let workspace: string
  let server: InspectionServer | null = null

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-inspect-server-'))
    await writeFile(join(workspace, 'index.html'), '<head></head><body>page</body>')
    await mkdir(join(workspace, 'js'), { recursive: true })
    await writeFile(join(workspace, 'js', 'app.js'), 'export const x = 1')
    await writeFile(join(workspace, 'style.css'), 'body { color: red }')
  })

  afterEach(async () => {
    await server?.close()
    server = null
    await rm(workspace, { recursive: true, force: true })
  })

  it('binds to loopback only', async () => {
    server = await startInspectionServer(workspace)

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  /**
   * Load-bearing, not cosmetic: a browser refuses to execute a
   * `<script type="module">` served with a non-JavaScript MIME type, so getting
   * this wrong would reproduce the blank-canvas failure through a new route.
   */
  it('serves JavaScript with a module-executable content type', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(server.urlFor('js/app.js'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
  })

  it('serves CSS and HTML with their own content types', async () => {
    server = await startInspectionServer(workspace)

    const css = await fetch(server.urlFor('style.css'))
    const html = await fetch(server.urlFor('index.html'))

    expect(css.headers.get('content-type')).toContain('text/css')
    expect(html.headers.get('content-type')).toContain('text/html')
  })

  it('never caches, so a post-edit inspection cannot see stale content', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(server.urlFor('index.html'))

    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('applies the HTML transform to documents but not to other assets', async () => {
    server = await startInspectionServer(workspace, {
      transformHtml: (html) => html.replace('<head>', '<head><!--injected-->')
    })

    const html = await fetch(server.urlFor('index.html')).then((r) => r.text())
    const js = await fetch(server.urlFor('js/app.js')).then((r) => r.text())

    expect(html).toContain('<!--injected-->')
    expect(js).toBe('export const x = 1')
  })

  it('refuses requests without the per-inspection token', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(`${server.origin}/index.html`)

    expect(response.status).toBe(404)
  })

  it('refuses traversal outside the workspace', async () => {
    server = await startInspectionServer(workspace)
    const tokenPrefix = server.urlFor('').replace(/\/$/, '')

    const response = await fetch(`${tokenPrefix}/../../secrets.txt`, { redirect: 'manual' })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('returns 404 for a missing file rather than hanging', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(server.urlFor('does-not-exist.js'))

    expect(response.status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(server.urlFor('index.html'), { method: 'POST' })

    expect(response.status).toBe(405)
  })

  it('resolves paths carrying a cache-busting query string', async () => {
    server = await startInspectionServer(workspace)

    const response = await fetch(`${server.urlFor('js/app.js')}?v=12345`)

    expect(response.status).toBe(200)
  })

  it('stops accepting connections once closed', async () => {
    const closing = await startInspectionServer(workspace)
    const url = closing.urlFor('index.html')

    await closing.close()

    await expect(fetch(url)).rejects.toThrow()
  })
})
