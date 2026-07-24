export interface VisualPreviewStorageUsage {
  totalBytes: number
  fileCount: number
  conversationCount: number
  limitBytes: number
  conversationLimitBytes: number
}

export interface VisualPreviewClearResult {
  removedBytes: number
  removedFiles: number
}
