import type { DefineChatSessionFunction, WorkspaceToolContext } from '../types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'

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
    email: {
      provider: 'none',
      gmail: {
        enabled: false,
        address: '',
        oauthClientId: '',
        oauthClientSecret: '',
        syncMode: 'metadata',
        sendRequiresApproval: true
      }
    },
    memory: { crossChatEnabled: true, personalEnabled: true },
    enabledTools: null,
    plan: { current: null },
    emit: () => {},
    confirm: () => Promise.resolve({ approved: true })
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
