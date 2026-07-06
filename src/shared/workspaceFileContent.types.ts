/** Result of reading a workspace file's contents for the in-app viewer/editor. */
export type WorkspaceFileContent =
  | { kind: 'text'; content: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; sizeBytes: number }
