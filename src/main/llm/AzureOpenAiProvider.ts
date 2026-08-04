import { AzureOpenAI } from 'openai'
import { VERIFY_KEY_TIMEOUT_MS } from './cloudTimeouts'
import type { GenerateOutcome, GenerateParams } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import type { LlmProvider } from './LlmProvider'
import {
  runChatCompletionsLoop,
  summarizeViaChatCompletions,
  verifyKeyViaModelsRetrieve
} from './OpenAiCompatibleProvider'

/**
 * Cloud provider backed by an Azure OpenAI resource. Speaks the same Chat
 * Completions wire protocol as `OpenAiCompatibleProvider.ts`'s providers
 * (reuses its `runChatCompletionsLoop`/`summarizeViaChatCompletions`/
 * `verifyKeyViaModelsRetrieve` directly rather than duplicating them), but
 * isn't one of them: Azure has no fixed base URL or catalog of model ids —
 * a customer provisions their own resource and names their own deployment,
 * and the `openai` SDK's dedicated `AzureOpenAI` client (not the plain
 * `OpenAI` client with a custom `baseURL`) is what actually knows how to
 * build that resource/deployment/api-version-shaped URL and auth header.
 */
class AzureOpenAiProvider implements LlmProvider {
  id = 'azure'

  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const settings = settingsStore.get().provider.azure
    const apiKey = settings.apiKey.trim()
    const resourceName = settings.resourceName.trim()
    const deploymentName = settings.deploymentName.trim()
    if (!apiKey || !resourceName || !deploymentName) {
      throw new Error(
        "Azure OpenAI isn't fully configured. Add an API key, resource name, and deployment name in Settings → AI & Models → Cloud models."
      )
    }

    const client = buildClient(settings)
    // 'azure' maps to an empty catalog on purpose, so this resolves to the
    // conservative default window — a customer names their own deployment and
    // there is no id to look up. See `CLOUD_MODEL_CATALOGS`.
    return runChatCompletionsLoop(client, deploymentName, params, 'azure')
  }
}

function buildClient(
  settings: {
    apiKey: string
    resourceName: string
    deploymentName: string
    apiVersion: string
  },
  /**
   * Only the reachability check passes one. This factory is shared with real
   * generation, where a short ceiling would abort long legitimate replies.
   */
  timeoutMs?: number
): AzureOpenAI {
  return new AzureOpenAI({
    apiKey: settings.apiKey.trim(),
    endpoint: `https://${settings.resourceName.trim()}.openai.azure.com`,
    deployment: settings.deploymentName.trim(),
    apiVersion: settings.apiVersion.trim() || '2024-10-21',
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs })
  })
}

/**
 * Narrow, tool-free summary call used only for cloud context compaction —
 * see `summarizeViaChatCompletions`'s own doc comment for the shared
 * contract every provider's compaction summarizer follows.
 */
export async function summarizeForCompactionAzure(
  transcript: string,
  previousSummary?: string
): Promise<string | null> {
  const settings = settingsStore.get().provider.azure
  const apiKey = settings.apiKey.trim()
  const resourceName = settings.resourceName.trim()
  const deploymentName = settings.deploymentName.trim()
  if (!apiKey || !resourceName || !deploymentName) return null

  const client = buildClient(settings)
  return summarizeViaChatCompletions(
    client,
    deploymentName,
    'Azure OpenAI',
    transcript,
    previousSummary
  )
}

/**
 * Confirm an Azure OpenAI resource/deployment/key combination actually
 * works. `model`/`apiKey` here are the deployment name and API key
 * specifically (Azure has no separate model id to check) — see
 * `verifyKeyViaModelsRetrieve`'s own doc comment for why this never spends
 * tokens.
 */
export async function verifyAzureKey(
  apiKey: string,
  resourceName: string,
  deploymentName: string,
  apiVersion: string
): Promise<void> {
  if (!resourceName.trim()) throw new Error('Enter the Azure resource name first.')
  if (!deploymentName.trim()) throw new Error('Enter the deployment name first.')
  const client = buildClient(
    { apiKey, resourceName, deploymentName, apiVersion },
    VERIFY_KEY_TIMEOUT_MS
  )
  return verifyKeyViaModelsRetrieve(client, deploymentName)
}

export const azureOpenAiProvider: LlmProvider = new AzureOpenAiProvider()
