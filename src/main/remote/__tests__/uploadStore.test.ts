import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = { path: '' }

vi.mock('electron', () => ({
  app: { getPath: () => userData.path }
}))

const {
  MAX_UPLOAD_BYTES,
  abortAllUploads,
  acceptChunk,
  beginUpload,
  finishUpload,
  pendingUploadCount,
  rehydrateUploadedImage,
  safeDisplayName,
  uploadDirectory
} = await import('../uploadStore')

/**
 * What a phone is allowed to put on this machine's disk.
 *
 * This is the first thing in the product that lets a remote device write a file
 * here, so the tests that matter are the refusals. The rule the whole design rests
 * on is that a finished file only exists once the whole of it has arrived and been
 * checked — nothing downstream should ever be handed a half file.
 */
describe('uploads from a phone', () => {
  beforeEach(async () => {
    userData.path = await mkdtemp(join(tmpdir(), 'anodex-upload-'))
  })

  afterEach(async () => {
    await abortAllUploads()
  })

  const png = () =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(24, 7)
    ])

  it('takes a whole file and puts it on disk', async () => {
    const bytes = png()
    const started = await beginUpload({ name: 'shot.png', sizeBytes: bytes.length })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await acceptChunk(started.id, bytes.subarray(0, 10).toString('base64'))
    await acceptChunk(started.id, bytes.subarray(10).toString('base64'))

    const done = await finishUpload(started.id)
    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(await readFile(done.path)).toEqual(bytes)
    expect(done.name).toBe('shot.png')
    expect(done.mimeType).toBe('image/png')
  })

  it('refuses a file bigger than the ceiling before a byte arrives', async () => {
    // The point of checking at the start: a file that was never going to be
    // accepted should cost one round trip, not a whole transfer.
    const started = await beginUpload({ name: 'huge.png', sizeBytes: MAX_UPLOAD_BYTES + 1 })
    expect(started.ok).toBe(false)
    expect(pendingUploadCount()).toBe(0)
  })

  it('refuses a kind of file Anodex would not read anyway', async () => {
    for (const name of ['run.exe', 'script.sh', 'archive.zip', 'vector.svg']) {
      expect((await beginUpload({ name, sizeBytes: 100 })).ok, name).toBe(false)
    }
  })

  it('stops a sender that exceeds what it declared', async () => {
    const started = await beginUpload({ name: 'a.txt', sizeBytes: 4 })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const refused = await acceptChunk(started.id, Buffer.alloc(64).toString('base64'))
    expect(refused.ok).toBe(false)

    // And the slot and its bytes go with it, rather than being left open.
    expect(pendingUploadCount()).toBe(0)
    expect(await readdir(uploadDirectory())).toEqual([])
  })

  it('leaves nothing behind when an upload stops halfway', async () => {
    const bytes = png()
    const started = await beginUpload({ name: 'half.png', sizeBytes: bytes.length })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await acceptChunk(started.id, bytes.subarray(0, 8).toString('base64'))

    const done = await finishUpload(started.id)
    expect(done.ok).toBe(false)

    // The failure that would matter most: a partial file sitting under the final
    // name, indistinguishable from a whole one.
    expect(await readdir(uploadDirectory())).toEqual([])
  })

  it('refuses an image that is not the image it claims to be', async () => {
    // An extension is a claim. The magic bytes are evidence, and this is the case
    // where the two disagree.
    const bytes = Buffer.from('#!/bin/sh\necho hello\n')
    const started = await beginUpload({ name: 'innocent.png', sizeBytes: bytes.length })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await acceptChunk(started.id, bytes.toString('base64'))
    const done = await finishUpload(started.id)

    expect(done.ok).toBe(false)
    expect(await readdir(uploadDirectory())).toEqual([])
  })

  it('never lets a sender choose the name on disk', async () => {
    const bytes = Buffer.from('notes')
    const started = await beginUpload({
      name: '../../../.ssh/authorized_keys.txt',
      sizeBytes: bytes.length
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await acceptChunk(started.id, bytes.toString('base64'))
    const done = await finishUpload(started.id)
    expect(done.ok).toBe(true)
    if (!done.ok) return

    // The file lands in the upload directory under a name we generated. The
    // traversal survives only as a display string, where it cannot do anything.
    expect(done.path.startsWith(uploadDirectory())).toBe(true)
    expect(done.path).not.toContain('..')
    expect(done.path).not.toContain('authorized_keys')
  })

  it('keeps a display name printable', () => {
    expect(safeDisplayName('report\u0000with\u001fcontrol.txt')).toBe('reportwithcontrol.txt')
    expect(safeDisplayName('a/b\\c.txt')).toBe('a b c.txt')
    expect(safeDisplayName('   ')).toBe('Attachment')
    expect(safeDisplayName('x'.repeat(400)).length).toBe(120)
  })

  it('rehydrates an uploaded image so its bytes need not travel twice', async () => {
    const bytes = png()
    const started = await beginUpload({ name: 'shot.png', sizeBytes: bytes.length })
    if (!started.ok) throw new Error('setup')
    await acceptChunk(started.id, bytes.toString('base64'))
    const done = await finishUpload(started.id)
    if (!done.ok) throw new Error('setup')

    const image = await rehydrateUploadedImage(done.path)
    expect(image?.mimeType).toBe('image/png')
    expect(image?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(image?.sizeBytes).toBe(bytes.length)
  })

  it('will not rehydrate a path outside the upload directory', async () => {
    // A path in a chat request is a request, not a fact. This is the check that
    // stops one naming any readable file on the machine and getting it back as
    // base64 in the next turn.
    expect(await rehydrateUploadedImage('/etc/passwd')).toBeNull()
    expect(await rehydrateUploadedImage(join(userData.path, '..', 'elsewhere.png'))).toBeNull()
  })

  it('refuses a chunk for an upload that was never opened', async () => {
    const refused = await acceptChunk('not-a-real-id', Buffer.from('hi').toString('base64'))
    expect(refused.ok).toBe(false)
  })
})
