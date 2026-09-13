/**
 * Whether a provider will accept image attachments.
 *
 * Local vision depends on the loaded model having its mmproj projector, which
 * only the engine state knows. Of the cloud providers, the two whose image
 * inputs are verified are allowed; the rest are refused up front rather than
 * failing on the provider after the images were sent.
 *
 * One rule for the chat composer and the agent run editor, so the two can
 * never disagree about whether a picture can be attached.
 */
export function canProviderSeeImages(provider: string, localVision: boolean): boolean {
  if (provider === 'local') return localVision
  return provider === 'anthropic' || provider === 'openai'
}
