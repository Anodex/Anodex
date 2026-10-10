import { lazyImport } from '../utils/lazyImport'

/** The OpenAI SDK, read when a cloud or local-vision request first needs it. */
export const loadOpenAiSdk = lazyImport(() => import('openai'))

/** The Anthropic SDK, read when Claude is first used. */
export const loadAnthropicSdk = lazyImport(() => import('@anthropic-ai/sdk'))

/**
 * Whether `error` is the SDK's own "you aborted this request". Only a request
 * already made can throw it, so the SDK is loaded by the time this is asked.
 */
export function isOpenAiAbort(error: unknown): boolean {
  const sdk = loadOpenAiSdk.loaded()
  return Boolean(sdk && error instanceof sdk.APIUserAbortError)
}

export function isAnthropicAbort(error: unknown): boolean {
  const sdk = loadAnthropicSdk.loaded()
  return Boolean(sdk && error instanceof sdk.APIUserAbortError)
}
