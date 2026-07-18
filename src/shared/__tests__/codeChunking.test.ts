import { describe, expect, it } from 'vitest'
import { chunkText, shouldIndexFile } from '../codeChunking'

describe('shouldIndexFile', () => {
  it('accepts a normal-sized code file', () => {
    expect(shouldIndexFile('src/index.ts', 2_000)).toBe(true)
  })

  it('rejects a file with no recognized extension', () => {
    expect(shouldIndexFile('src/llama-addon.node', 2_000)).toBe(false)
  })

  it('rejects an oversized file even with a good extension', () => {
    expect(shouldIndexFile('dist/bundle.js', 1_000_000)).toBe(false)
  })

  it('rejects a zero-byte file', () => {
    expect(shouldIndexFile('src/empty.ts', 0)).toBe(false)
  })

  it('is case-insensitive on the extension', () => {
    expect(shouldIndexFile('README.MD', 500)).toBe(true)
  })
})

describe('chunkText', () => {
  it('returns a single chunk for a short file', () => {
    const chunks = chunkText('line1\nline2\nline3', 'a.ts')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({
      filePath: 'a.ts',
      startLine: 1,
      endLine: 3,
      text: 'line1\nline2\nline3'
    })
  })

  it('splits a long file into overlapping windows', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line${i + 1}`)
    const chunks = chunkText(lines.join('\n'), 'big.ts')

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk's line range is internally consistent with its own text.
    for (const chunk of chunks) {
      const expectedLines = chunk.endLine - chunk.startLine + 1
      expect(chunk.text.split('\n')).toHaveLength(expectedLines)
    }
    // Consecutive chunks overlap rather than leaving a gap.
    expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine)
    // The last chunk reaches the end of the file.
    expect(chunks[chunks.length - 1].endLine).toBe(120)
  })

  it('skips whitespace-only trailing content', () => {
    const chunks = chunkText('real code\n\n   \n', 'a.ts')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('real code')
  })

  it('returns an empty array for an empty file', () => {
    expect(chunkText('', 'a.ts')).toEqual([])
  })
})
