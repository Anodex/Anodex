import { ipcMain } from 'electron'
import { IpcChannel, type VerifyProviderKeyRequest } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import { verifyAnthropicKey } from '../llm/AnthropicProvider'
import { verifyOpenAiKey } from '../llm/OpenAiProvider'

/** IPC handler for testing whether a cloud provider API key actually works. */
export function registerProviderHandlers(): void {
  ipcMain.handle(IpcChannel.Provider.verifyKey, async (_event, request: VerifyProviderKeyRequest) => {
    const apiKey = request.apiKey.trim()
    if (!apiKey) return err('provider.no-key', 'No API key entered.')

    try {
      if (request.provider === 'anthropic') await verifyAnthropicKey(apiKey, request.model)
      else await verifyOpenAiKey(apiKey, request.model)
      return ok(true as const)
    } catch (error) {
      return err('provider.verify-failed', toErrorMessage(error))
    }
  })
}
