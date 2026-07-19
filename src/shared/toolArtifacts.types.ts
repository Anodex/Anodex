/** Durable, structured output captured before a tool result is truncated for the model. */
export type ToolArtifact = WebSearchArtifact | WebFetchArtifact

interface ToolArtifactBase {
  id: string
  conversationId: string
  messageId: string
  createdAt: number
}

export interface WebSearchResultArtifact {
  title: string
  url: string
  snippet: string
  rank: number
}

export interface WebSearchArtifact extends ToolArtifactBase {
  kind: 'web-search'
  query: string
  provider: string
  results: WebSearchResultArtifact[]
}

export interface EvidencePassage {
  id: string
  text: string
  score: number
}

export interface WebFetchArtifact extends ToolArtifactBase {
  kind: 'web-fetch'
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  title: string
  contentHash: string
  contentChars: number
  truncated: boolean
  passages: EvidencePassage[]
  warnings: string[]
}

export type ToolArtifactDraft =
  | Omit<WebSearchArtifact, 'id' | 'conversationId' | 'messageId' | 'createdAt'>
  | Omit<WebFetchArtifact, 'id' | 'conversationId' | 'messageId' | 'createdAt'>
