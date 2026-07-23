import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCloudVisionCompatible,
  createVisualInputQueue,
  drainVisualInputs,
  enqueueVisualInput,
  hasExpectedVisionImageSignature,
  readVisionImage,
  reopenRecentHistoryImages
} from '../imageInputs'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe('vision image inputs', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-vision-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('validates and reads a bounded workspace image', async () => {
    const path = join(workspace, 'result.png')
    await writeFile(path, Buffer.concat([PNG_SIGNATURE, Buffer.from('pixels')]))

    const image = await readVisionImage(path, 'result.png')

    expect(image.mimeType).toBe('image/png')
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(hasExpectedVisionImageSignature(path, PNG_SIGNATURE)).toBe(true)
  })

  it('reopens the newest historical image without persisting its bytes', async () => {
    const path = join(workspace, 'history.png')
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('history')])
    await writeFile(path, bytes)

    const selected = await reopenRecentHistoryImages(
      [
        {
          role: 'user',
          content: 'Earlier',
          attachments: [
            {
              path,
              name: 'history.png',
              kind: 'image',
              mimeType: 'image/png',
              sizeBytes: bytes.length
            }
          ]
        }
      ],
      1
    )

    expect(selected.get(0)?.[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('bounds tool-produced visual inputs across a response', () => {
    const queue = createVisualInputQueue(1)
    const image = {
      path: 'result.png',
      name: 'result.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      sizeBytes: 5
    }

    enqueueVisualInput(queue, image)
    expect(drainVisualInputs(queue)).toEqual([image])
    expect(() => enqueueVisualInput(queue, image)).toThrow(/limit reached/i)
  })

  it('rejects BMP before a cloud request while preserving local support', () => {
    const bmp = {
      path: 'scan.bmp',
      name: 'scan.bmp',
      mimeType: 'image/bmp',
      dataUrl: 'data:image/bmp;base64,Qk0=',
      sizeBytes: 2
    }
    expect(() => assertCloudVisionCompatible([bmp])).toThrow(/convert.*PNG or JPEG/i)
    expect(() =>
      enqueueVisualInput(createVisualInputQueue(4, new Set(['image/png'])), bmp)
    ).toThrow(/active provider cannot inspect/i)
  })
})
