export const DEFAULT_TOOL_GROUP_COLLAPSE_THRESHOLD = 6

export function shouldStartToolGroupExpanded(
  callCount: number,
  threshold = DEFAULT_TOOL_GROUP_COLLAPSE_THRESHOLD
): boolean {
  return callCount <= threshold
}
