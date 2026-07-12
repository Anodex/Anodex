/** Types for the local skill catalog — reusable, discoverable instruction bundles. */

export type SkillScope = 'project' | 'personal'

/**
 * A single skill: one markdown file with small YAML-ish frontmatter, stored in
 * either the active project's `.anodex/skills/*.md` directory or the user's
 * personal `userData/skills/*.md` directory. `tools` documents which tool names
 * the skill's instructions expect to be available — it's informational
 * (surfaced by `load_skill`), not a live gate; actual tool access is still
 * controlled by `ToolRuntimeContext.enabledTools`.
 */
export interface Skill {
  name: string
  description: string
  scope: SkillScope
  keywords: string[]
  tools: string[]
  /** The markdown body after the frontmatter block — the skill's instructions. */
  body: string
  /** Absolute path to the source file, for diagnostics. */
  filePath: string
}

/** Skill metadata safe to expose to renderer UI — no markdown body or absolute file path. */
export type SkillSummary = Pick<Skill, 'name' | 'description' | 'scope' | 'keywords'>

/** Renderer request to read one editable skill markdown document. */
export interface SkillReadRequest {
  projectId?: string | null
  scope: SkillScope
  name: string
}

/** Renderer request to validate and save one skill markdown document. */
export interface SkillSaveRequest {
  projectId?: string | null
  scope: SkillScope
  /** Existing name when editing; omitted/null when creating a new skill. */
  originalName?: string | null
  content: string
}

/** Editable skill document safe for renderer UI. */
export interface SkillDocument {
  name: string
  scope: SkillScope
  content: string
}

/** One ranked match from a skill-catalog search. */
export interface SkillSearchResult {
  name: string
  description: string
  scope: SkillScope
  score: number
}
