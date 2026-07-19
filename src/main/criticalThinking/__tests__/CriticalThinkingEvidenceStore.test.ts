import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

    store.record('critical_test', artifact)
    await store.flush()
    const second = { ...artifact, id: 'artifact_2', createdAt: 2 }
    store.record('critical_test', second)
    await store.flush()

    expect(JSON.parse(await readFile(join(directory, 'critical_test.json'), 'utf8'))).toEqual([
      artifact,
      second
    ])
  })
})
