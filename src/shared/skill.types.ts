/** Types for the local skill catalog — reusable, discoverable instruction bundles. */

/**
 * A single skill: one markdown file with small YAML-ish frontmatter, stored in
 * `userData/skills/*.md`. `tools` documents which tool names the skill's
 * instructions expect to be available — it's informational (surfaced by
 * `load_skill`), not a live gate; actual tool access is still controlled by
 * `ToolRuntimeContext.enabledTools`.
 */
export interface Skill {
  name: string
  description: string
  keywords: string[]
  tools: string[]
  /** The markdown body after the frontmatter block — the skill's instructions. */
  body: string
  /** Absolute path to the source file, for diagnostics. */
  filePath: string
}

/** One ranked match from a skill-catalog search. */
export interface SkillSearchResult {
  name: string
  description: string
  score: number
}
