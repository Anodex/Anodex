/** Durable, structured output captured before a tool result is truncated for the model. */
export type ToolArtifact = WebSearchArtifact | WebFetchArtifact

interface ToolArtifactBase {
  id: string
  conversationId: string
  messageId: string
  createdAt: number
  /** Optional durable ownership when an artifact belongs to a staged research round. */
  research?: {
    stepId: string
    roundId: string
  }
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

export type WebSearchArtifactDraft = Omit<
  WebSearchArtifact,
  'id' | 'conversationId' | 'messageId' | 'createdAt'
>

export type WebFetchArtifactDraft = Omit<
  WebFetchArtifact,
  'id' | 'conversationId' | 'messageId' | 'createdAt'
>

export type ToolArtifactDraft = WebSearchArtifactDraft | WebFetchArtifactDraft
