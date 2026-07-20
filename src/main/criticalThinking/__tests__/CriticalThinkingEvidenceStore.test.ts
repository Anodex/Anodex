import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { CriticalThinkingEvidenceStore } from '../CriticalThinkingEvidenceStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('CriticalThinkingEvidenceStore', () => {
  it('persists artifacts in an atomic per-run sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-evidence-'))
    temporaryDirectories.push(directory)
    const store = new CriticalThinkingEvidenceStore()
    store.init(directory)
    const artifact: ToolArtifact = {
      id: 'artifact_1',
      conversationId: 'critical_test',
      messageId: 'message_1',
      createdAt: 1,
      kind: 'web-search',
      query: 'test',
      provider: 'test',
      results: []
    }

    expect(store.record('critical_test', artifact)).toBe(true)
    expect(store.record('critical_test', artifact)).toBe(false)
    await store.flush()
    const second = { ...artifact, id: 'artifact_2', createdAt: 2 }
    expect(store.record('critical_test', second)).toBe(true)
    await store.flush()

    expect(JSON.parse(await readFile(join(directory, 'critical_test.json'), 'utf8'))).toEqual([
      artifact,
      second
    ])
  })

  it('cannot reload stale evidence while a queued delete is pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-evidence-delete-'))
    temporaryDirectories.push(directory)
    const store = new CriticalThinkingEvidenceStore()
    store.init(directory)
    const oldArtifact: ToolArtifact = {
      id: 'artifact_old',
      conversationId: 'critical_test',
      messageId: 'message_old',
      createdAt: 1,
      kind: 'web-search',
      query: 'old',
      provider: 'test',
      results: []
    }
    store.record('critical_test', oldArtifact)
    await store.flush()

    store.delete('critical_test')
    expect(store.list('critical_test')).toEqual([])
    const replacement = { ...oldArtifact, id: 'artifact_new', query: 'new' }
    store.record('critical_test', replacement)
    await store.flush()

    expect(JSON.parse(await readFile(join(directory, 'critical_test.json'), 'utf8'))).toEqual([
      replacement
    ])
  })

  it('ignores malformed artifacts instead of exposing unsafe persisted shapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-evidence-malformed-'))
    temporaryDirectories.push(directory)
    await writeFile(
      join(directory, 'critical_test.json'),
      JSON.stringify([
        { id: 'missing-everything-else' },
        {
          id: 'artifact_bad_fetch',
          conversationId: 'critical_test',
          messageId: 'message_bad',
          createdAt: 1,
          kind: 'web-fetch',
          finalUrl: 'https://example.com',
          passages: null
        }
      ]),
      'utf8'
    )
    const store = new CriticalThinkingEvidenceStore()
    store.init(directory)

    expect(store.list('critical_test')).toEqual([])
  })

  it('retains the failed and unattempted tail of a write batch for retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-evidence-retry-'))
    temporaryDirectories.push(directory)
    const store = new CriticalThinkingEvidenceStore()
    store.init(directory)
    const artifact = (id: string, runId: string): ToolArtifact => ({
      id,
      conversationId: runId,
      messageId: `message_${id}`,
      createdAt: 1,
      kind: 'web-search',
      query: id,
      provider: 'test',
      results: []
    })
    const blockedTemporaryPath = join(directory, `critical_second.json.${process.pid}.tmp`)
    await mkdir(blockedTemporaryPath)

    store.record('critical_first', artifact('first', 'critical_first'))
    store.record('critical_second', artifact('second', 'critical_second'))
    store.record('critical_third', artifact('third', 'critical_third'))
    await expect(store.flush()).rejects.toBeInstanceOf(Error)

    await rm(blockedTemporaryPath, { recursive: true, force: true })
    await store.flush()
    await expect(readFile(join(directory, 'critical_second.json'), 'utf8')).resolves.toContain(
      'second'
    )
    await expect(readFile(join(directory, 'critical_third.json'), 'utf8')).resolves.toContain(
      'third'
    )
  })
})
