import { app } from 'electron'
import { statSync } from 'node:fs'
import type { MemoryHolder, MemoryUsageReport } from '@shared/settings.types'
import { conversationStore } from '../conversations/ConversationStore'
import { embeddingService } from '../codeIndex/EmbeddingService'

/**
 * What Anodex is holding in memory, and what it is.
 *
 * Asked after a session where the main process sat at 854MB with nothing to say why.
 * Task Manager gives one number per process; this says which process, how much of the
 * main one is JavaScript, and what the large holders are — so a question about memory
 * can be answered with a number instead of a guess.
 *
 * Sizes are what can be measured cheaply. A conversation's is the size of its file on
 * disk, which understates it as objects but is the right order and costs nothing;
 * anything not knowable cheaply says so rather than inventing a figure.
 */
export function memoryUsageReport(): MemoryUsageReport {
  const memory = process.memoryUsage()
  return {
    processes: app.getAppMetrics().map((metric) => ({
      kind: metric.type,
      detail: metric.serviceName ?? metric.name,
      bytes: metric.memory.workingSetSize * 1024
    })),
    mainHeapBytes: memory.heapUsed,
    mainRssBytes: memory.rss,
    holders: [conversationsHolder(), embeddingModelHolder()]
  }
}

/** Conversations the store is holding whole. Archived ones are read on demand. */
function conversationsHolder(): MemoryHolder {
  const held = conversationStore.heldConversationFiles()
  let bytes = 0
  for (const filePath of held) {
    try {
      bytes += statSync(filePath).size
    } catch {
      // Deleted underneath us: not worth failing a diagnostic over.
    }
  }
  return {
    name: 'Conversations held in memory',
    detail: `${held.length} chat${held.length === 1 ? '' : 's'}, as ${(bytes / 1_048_576).toFixed(0)}MB of JSON on disk. Archived chats are read when opened.`,
    bytes
  }
}

function embeddingModelHolder(): MemoryHolder {
  const loaded = embeddingService.isLoaded()
  return {
    name: 'Code search model',
    detail: loaded
      ? 'Loaded. It is let go after a spell with no code search.'
      : 'Not loaded. It loads on the first code search.',
    bytes: null
  }
}
