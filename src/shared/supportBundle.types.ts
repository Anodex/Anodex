/**
 * A local, human-readable support report. The content has already passed
 * through the main-process redaction layer before it reaches the renderer.
 */
export interface SupportBundlePreview {
  fileName: string
  content: string
  diagnosticsCount: number
  logLineCount: number
  redactionCount: number
}

/** A null path means the user closed the native Save dialog. */
export interface SupportBundleExportResult {
  path: string | null
}
