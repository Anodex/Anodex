import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { closeProjectPageServers, projectPageUrl } from '../projectPagePreview'

const project = mkdtempSync(join(tmpdir(), 'anodex-page-preview-'))
writeFileSync(join(project, 'index.html'), '<h1>Home</h1><script>fetch("projects.json")</script>')
writeFileSync(join(project, 'projects.json'), '[{"title":"Pulse"}]')

afterAll(async () => {
  await closeProjectPageServers()
  rmSync(project, { recursive: true, force: true })
})

describe('opening a project page in the browser', () => {
  it('serves the page and the files it loads from one loopback address', async () => {
    // Opened from disk, a page that fetches its data shows nothing; served, it works.
    const url = await projectPageUrl(project, 'index.html')
    expect(url.startsWith('http://127.0.0.1:')).toBe(true)

    expect(await (await fetch(url)).text()).toContain('<h1>Home</h1>')
    const data = await fetch(new URL('projects.json', url))
    expect(await data.json()).toEqual([{ title: 'Pulse' }])
  })

  it('reuses the same server for the same project', async () => {
    const first = new URL(await projectPageUrl(project, 'index.html'))
    const second = new URL(await projectPageUrl(project, 'index.html'))
    expect(second.origin).toBe(first.origin)
  })

  it('refuses what is not a page, is missing, or is outside the project', async () => {
    await expect(projectPageUrl(project, 'projects.json')).rejects.toThrow('web pages')
    await expect(projectPageUrl(project, 'gone.html')).rejects.toThrow('not in the project')
    await expect(projectPageUrl(project, '../outside.html')).rejects.toThrow()
  })
})
