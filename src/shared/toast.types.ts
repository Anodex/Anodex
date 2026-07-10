/** Content for a desktop toast (see `main/toastWindow.ts`). */
export interface ToastContent {
  title: string
  body: string
  /** If set, clicking the toast opens this conversation instead of just focusing the window. */
  conversationId?: string
}
