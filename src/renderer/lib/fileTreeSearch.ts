import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'

/**
 * Filters a workspace file tree down to nodes matching `query` by name
 * (case-insensitive substring). A folder is kept if its own name matches or
 * any descendant matches, recursively filtered to just those descendants —
 * so a search narrows the tree instead of only flattening a match list,
 * keeping folder context visible the way VS Code's explorer search does.
 */
export function filterFileTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes

  const filtered: WorkspaceTreeNode[] = []
  for (const node of nodes) {
    const nameMatches = node.name.toLowerCase().includes(needle)
    if (node.type === 'file') {
      if (nameMatches) filtered.push(node)
      continue
    }

    const children = filterFileTree(node.children, needle)
    if (nameMatches || children.length > 0) {
      filtered.push({ ...node, children })
    }
  }
  return filtered
}
