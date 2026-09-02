import type { DefineChatSessionFunction, WorkspaceToolContext } from '../types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { createTaskLedger } from '../taskLedger'
import { createTurnProgress } from '../turnProgress'

/**
 * A minimal mock for `node-llama-cpp`'s `defineChatSessionFunction`.
 * The returned "tool" exposes the handler so tests can invoke it directly.
 */
export function createMockDefine(): DefineChatSessionFunction {
  return ((config: { handler: (args: unknown) => Promise<string> }) => {
    return config as unknown as ReturnType<DefineChatSessionFunction>
  }) as unknown as DefineChatSessionFunction
}

export function createMockContext(workspaceRoot: string): WorkspaceToolContext {
  return {
    conversationId: 'test-conversation',
    messageId: 'test-message',
    projectId: null,
    workspaceRoot,
    userFiles: [],
    permissionMode: 'ask',
    commandShell: undefined,
    webSearch: {
      provider: 'none',
      apiKey: '',
      searchEngineId: '',
      baseUrl: 'http://localhost:8080',
      resultCount: 5,
      requireApproval: false
    },
    imageGeneration: undefined,
    email: {
      accounts: [],
      primaryAccountId: null,
      sendRequiresApproval: true
    },
    memory: { crossChatEnabled: true, personalEnabled: true, confirmBeforeSaving: false },
    enabledTools: null,
    disabledTools: new Set(),
    plan: { current: null },
    turnGate: { approved: false },
    goalRun: false,
    progress: createTurnProgress(),
    modelResultBudget: { current: null },
    ledger: createTaskLedger(),
    emit: () => {},
    confirm: () => Promise.resolve({ approved: true }),
    mcpTools: []
  }
}

export function captureCalls<T extends ToolCall>(): { calls: T[]; emit: (call: T) => void } {
  const calls: T[] = []
  return {
    calls,
    emit: (call: T) => calls.push(call)
  }
}

export function captureConfirmations(): {
  requests: ToolConfirmRequest[]
  confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
} {
  const requests: ToolConfirmRequest[] = []
  return {
    requests,
    confirm: (request: ToolConfirmRequest) => {
      requests.push(request)
      return Promise.resolve({ approved: true })
    }
  }
}

/**
 * Split a tool result into its content and the trailing `[evidence E<n> …]`
 * handle, when one is present.
 *
 * Every sizeable result now carries one — see `retainAsEvidence` in
 * `helpers.ts` — so assertions about the content itself have to look past it.
 * Shared here rather than duplicated per suite so a change to the handle's
 * shape breaks one place.
 */
export function splitEvidenceMarker(result: string): [string, string | null] {
  const lastNewline = result.lastIndexOf('\n')
  if (lastNewline < 0) return [result, null]
  const candidate = result.slice(lastNewline + 1)
  return /^\[evidence E\d+ · /.test(candidate)
    ? [result.slice(0, lastNewline), candidate]
    : [result, null]
}

/**
 * Pay pdf.js's import cost before a PDF test is timed.
 *
 * `extractPdfText` imports `pdfjs-dist` dynamically, so the first test to read
 * a PDF loads the whole library inside its own five-second budget. That is
 * invisible on a fast machine — 77ms locally — and fatal on a slow one.
 *
 * Measured: CI run 33437718168 failed only on `windows-latest`, with
 * `Test timed out in 5000ms` on the first PDF test, while ubuntu and macOS
 * passed. That run's summary names the cause: `import 56.10s` of a 62s total,
 * so module loading was the cost, not the test.
 *
 * Called from a `beforeAll` in the two files that read PDFs rather than from a
 * global setup file: warming it everywhere charged all 322 test files for what
 * two of them need, and measured 72s of added setup across the suite.
 *
 * Raising `testTimeout` instead would have hidden the problem rather than moved
 * it, and cost every other test its ability to fail on a real hang.
 */
export async function warmPdfParser(): Promise<void> {
  await import('pdfjs-dist/legacy/build/pdf.mjs')
}
