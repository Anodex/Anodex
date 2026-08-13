import { resolveInWorkspace, toWorkspaceRelative } from '../tools/workspace'

/**
 * Converts a link in a visible preview into a workspace-confined HTML path.
 * Non-project URLs, fragments, query strings, and traversal never become
 * navigable targets for computer control.
 */
export function resolveProjectPreviewHref(
  workspaceRoot: string,
  currentPath: string,
  href: string
): string | null {
  try {
    const base = new URL(`https://anodex.local/${currentPath}`)
    const url = new URL(href, base)
    if (url.origin !== 'https://anodex.local' || url.search || url.hash) return null
    const requested = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!/\.html?$/i.test(requested)) return null
    return toWorkspaceRelative(workspaceRoot, resolveInWorkspace(workspaceRoot, requested))
  } catch {
    return null
  }
}
