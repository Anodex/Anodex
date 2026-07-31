import { ipcMain } from 'electron'
import { IpcChannel, type VerifyProviderKeyRequest } from '@shared/ipc'
import type { CloudProviderId } from '@shared/providerUsage.types'
import { ok, err, toErrorMessage } from '@shared/result'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { verifyAnthropicKey } from '../llm/AnthropicProvider'
import { verifyOpenAiKey } from '../llm/OpenAiProvider'
import { verifyAzureKey } from '../llm/AzureOpenAiProvider'
import { verifyOpenAiCompatibleKey } from '../llm/OpenAiCompatibleProvider'
import { OPEN_AI_COMPATIBLE_CONFIGS, MODEL_CATALOGS_BY_PROVIDER } from '../llm/cloudProviderConfigs'
import { providerUsageStore } from '../llm/ProviderUsageStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'

/** IPC handlers for cloud provider key verification and live usage snapshots. */
export function registerProviderHandlers(): void {
  ipcMain.handle(
    IpcChannel.Provider.verifyKey,
    async (_event, request: VerifyProviderKeyRequest) => {
      const apiKey = request.apiKey.trim()
      if (!apiKey) return err('provider.no-key', 'No API key entered.')

      try {
        if (request.provider === 'anthropic') {
          await verifyAnthropicKey(apiKey, request.model)
        } else if (request.provider === 'openai') {
          await verifyOpenAiKey(apiKey, request.model)
        } else if (request.provider === 'azure') {
          await verifyAzureKey(
            apiKey,
            request.resourceName ?? '',
            request.deploymentName ?? '',
            request.apiVersion ?? ''
          )
        } else {
          await verifyOpenAiCompatibleKey(
            OPEN_AI_COMPATIBLE_CONFIGS[request.provider],
            apiKey,
            request.model
          )
        }
        return ok(true as const)
      } catch (error) {
        return err('provider.verify-failed', toErrorMessage(error))
      }
    }
  )

  // Refreshes `todayTokens` from `TokenActivityStore` on every call, so a
  // freshly opened dropdown reflects usage from earlier today even before
  // this session's first generation (rateLimit stays whatever was last
  // captured live this session, `null` if none yet).
  ipcMain.handle(IpcChannel.Provider.getUsageSnapshot, () => {
    providerUsageStore.recordTodayTokens(
      'anthropic',
      tokenActivityStore.getTodayTokensForModelIds(ANTHROPIC_MODELS.map((m) => m.id))
    )
    providerUsageStore.recordTodayTokens(
      'openai',
      tokenActivityStore.getTodayTokensForModelIds(OPENAI_MODELS.map((m) => m.id))
    )
    for (const [id, models] of Object.entries(MODEL_CATALOGS_BY_PROVIDER)) {
      providerUsageStore.recordTodayTokens(
        id as CloudProviderId,
        tokenActivityStore.getTodayTokensForModelIds(models.map((m) => m.id))
      )
    }
    return providerUsageStore.getAll()
  })
}
