import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatHistoryTurn } from '@shared/chat.types'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: { handle: vi.fn() }
}))

const {
  attachmentsForTurn,
  discardRunAttachments,
  importRunAttachments,
  runAttachmentsDirectory,
  safeAttachmentFileName
} = await import('../agentRunAttachments')

/** The smallest byte run the image signature check accepts as a PNG. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82
])

let sourceDir = ''

function source(name: string, bytes: Buffer | string): { path: string; name: string } {
  const path = join(sourceDir, name)
  writeFileSync(path, bytes)
  return { path, name }
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'anodex-run-attach-'))
  sourceDir = mkdtempSync(join(tmpdir(), 'anodex-run-src-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(sourceDir, { recursive: true, force: true })
})

describe('importRunAttachments', () => {
  /**
   * A run works unattended and can be retried days later. Referencing the
   * original meant a reference image the user tidied away after pressing Start
   * was gone from a run that had been told it had it.
   */
  it('copies each file into the run, so the originals can go away', async () => {
    const image = source('nebula.png', PNG)
    const spec = source('spec.md', '# Spec\n\nBuild the thing.')

    const attached = await importRunAttachments('run_a', [image, spec])

    expect(attached.map((file) => file.name)).toEqual(['nebula.png', 'spec.md'])
    for (const file of attached) {
      expect(file.path.startsWith(runAttachmentsDirectory('run_a'))).toBe(true)
      expect(existsSync(file.path)).toBe(true)
    }
    rmSync(image.path)
    expect(existsSync(attached[0].path)).toBe(true)
  })

  it('pins images so every later turn still sees them', async () => {
    const [image, text] = await importRunAttachments('run_a', [
      source('ref.png', PNG),
      source('notes.txt', 'notes')
    ])

    expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png', visionContextPinned: true })
    expect(text).toMatchObject({ kind: 'text' })
    expect(text.visionContextPinned).toBeUndefined()
  })

  it('refuses what a chat message would refuse, and leaves nothing behind', async () => {
    const binary = source('blob.dat', Buffer.from([1, 0, 2, 0, 3]))

    await expect(importRunAttachments('run_b', [binary])).rejects.toThrow(/blob\.dat/)
    expect(existsSync(runAttachmentsDirectory('run_b'))).toBe(false)
  })

  it('keeps two files with the same name apart', async () => {
    const first = source('a.txt', 'first')
    const other = mkdtempSync(join(tmpdir(), 'anodex-run-src2-'))
    const secondPath = join(other, 'a.txt')
    writeFileSync(secondPath, 'second')

    const attached = await importRunAttachments('run_c', [
      first,
      { path: secondPath, name: 'a.txt' }
    ])
    rmSync(other, { recursive: true, force: true })

    expect(new Set(attached.map((file) => file.path)).size).toBe(2)
  })
})

describe('discardRunAttachments', () => {
  it('removes the run folder, and is quiet when there is none', async () => {
    await importRunAttachments('run_d', [source('n.txt', 'x')])
    await discardRunAttachments('run_d')
    expect(existsSync(runAttachmentsDirectory('run_d'))).toBe(false)
    await expect(discardRunAttachments('run_never')).resolves.toBeUndefined()
  })
})

describe('attachmentsForTurn', () => {
  it('carries everything on the turn whose history does not hold them yet', async () => {
    const attached = await importRunAttachments('run_e', [
      source('ref.png', PNG),
      source('spec.md', 'Deep blacks must remain deep.')
    ])

    const turn = await attachmentsForTurn(attached, [], 'Goal: build it')

    expect(turn.attachments).toEqual(attached)
    expect(turn.images.map((image) => image.name)).toEqual(['ref.png'])
    expect(turn.prompt).toContain('Goal: build it')
    expect(turn.prompt).toContain('- ref.png (image')
    expect(turn.prompt).toContain('--- Attached file: spec.md ---\nDeep blacks must remain deep.')
  })

  it('adds nothing once history already carries them', async () => {
    const attached = await importRunAttachments('run_f', [source('ref.png', PNG)])
    const history: ChatHistoryTurn[] = [{ role: 'user', content: 'Goal', attachments: attached }]

    const turn = await attachmentsForTurn(attached, history, 'Continue')

    expect(turn).toEqual({ attachments: undefined, prompt: 'Continue', images: [] })
  })

  /**
   * A context epoch drops the message that carried them. On a small window —
   * exactly where epochs happen — the run would otherwise lose its references.
   */
  it('carries them again after the message that held them was dropped', async () => {
    const attached = await importRunAttachments('run_g', [source('ref.png', PNG)])
    const afterEpoch: ChatHistoryTurn[] = [{ role: 'assistant', content: 'Working' }]

    const turn = await attachmentsForTurn(attached, afterEpoch, 'Continue')

    expect(turn.attachments).toEqual(attached)
    expect(turn.images).toHaveLength(1)
  })

  it("does not mistake a person's own attachment for the run's", async () => {
    const attached = await importRunAttachments('run_h', [source('ref.png', PNG)])
    const history: ChatHistoryTurn[] = [
      {
        role: 'user',
        content: 'Look at this too',
        attachments: [{ path: 'C:/elsewhere/other.png', name: 'other.png', sizeBytes: 1 }]
      }
    ]

    const turn = await attachmentsForTurn(attached, history, 'Continue')

    expect(turn.attachments).toEqual(attached)
  })

  it('leaves a run with no attachments untouched', async () => {
    expect(await attachmentsForTurn(undefined, [], 'Goal')).toEqual({
      attachments: undefined,
      prompt: 'Goal',
      images: []
    })
  })
})

describe('safeAttachmentFileName', () => {
  it('replaces characters no file system accepts and keeps the rest', () => {
    expect(safeAttachmentFileName('a:b/c*?.png')).toBe('a_b_c__.png')
    expect(safeAttachmentFileName('back\\slash.txt')).toBe('back_slash_.txt')
    expect(safeAttachmentFileName('   ')).toBe('attachment')
  })
})
