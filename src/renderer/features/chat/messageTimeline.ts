/** Return the newest user-authored message, independent of the current scroll section. */
export function findLatestUserRequest<T extends { role: string }>(
  messages: readonly T[]
): T | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index]
  }
  return null
}

export interface PinCurrentRequestInput {
  messageTop: number
  scrollTop: number
  offset?: number
}

/** Whether the newest user request has scrolled far enough above the viewport to pin it. */
export function shouldPinCurrentRequest({
  messageTop,
  scrollTop,
  offset = 16
}: PinCurrentRequestInput): boolean {
  return messageTop < scrollTop - offset
}
