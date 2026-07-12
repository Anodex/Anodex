export interface PinCurrentRequestInput {
  messageTop: number
  scrollTop: number
  offset?: number
}

/** Whether the active user request has scrolled far enough above the viewport to pin it. */
export function shouldPinCurrentRequest({
  messageTop,
  scrollTop,
  offset = 16
}: PinCurrentRequestInput): boolean {
  return messageTop < scrollTop - offset
}
