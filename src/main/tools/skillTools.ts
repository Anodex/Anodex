import { skillStore } from '../skills/SkillStore'
import { buildIndex, search } from '../skills/skillSearch'
import { runReadTool } from './helpers'
import type { ToolFactory } from './types'

const DEFAULT_LIMIT = 5

/** find_skill — search the local skill catalog by query, returns ranked name/description matches. */
export const findSkillTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search the local skill catalog for reusable instructions relevant to a task. Returns matching skill names and descriptions — call load_skill on one to read its full instructions.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to do, in a few words.' }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string }) =>
      runReadTool(ctx, {
        name: 'find_skill',
        kind: 'read',
        title: `Find skill "${args.query}"`,
        run() {
          const skills = skillStore.list(ctx.workspaceRoot)
          if (skills.length === 0) {
            const locations = ctx.workspaceRoot
              ? `"${skillStore.getProjectDir(ctx.workspaceRoot)}" or "${skillStore.getDir()}"`
              : `"${skillStore.getDir()}"`
            return Promise.resolve({
              modelResult: `No skills found yet. Add one as a markdown file in ${locations}.`,
              detail: '0 skills in catalog'
            })
          }
          const results = search(buildIndex(skills), args.query, DEFAULT_LIMIT)
          if (results.length === 0) {
            return Promise.resolve({
              modelResult: 'No matching skills found.',
              detail: 'No matches'
            })
          }
          const byName = new Map(skills.map((skill) => [skill.name, skill]))
          const lines = results.map((result) => {
            const scope = byName.get(result.name)?.scope ?? 'personal'
            return `[${scope}] ${result.name} — ${result.description}`
          })
          return Promise.resolve({
            modelResult: lines.join('\n'),
            detail: `${results.length} matches`
          })
        }
      })
  })

/** load_skill — read a specific skill's full instructions by name. */
export const loadSkillTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Load a skill by exact name (as returned by find_skill) and return its full instructions.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name, from find_skill.' }
      },
      required: ['name']
    } as const,
    handler: (args: { name: string }) =>
      runReadTool(ctx, {
        name: 'load_skill',
        kind: 'read',
        title: `Load skill "${args.name}"`,
        run() {
          const skill = skillStore.get(args.name, ctx.workspaceRoot)
          if (!skill) {
            throw new Error(`No skill named "${args.name}" found. Use find_skill to search.`)
          }
          const missingTools =
            ctx.enabledTools === null
              ? []
              : skill.tools.filter((tool) => !ctx.enabledTools!.has(tool))
          const note =
            missingTools.length > 0
              ? `\n\n(Note: this skill expects ${missingTools.join(', ')}, which ${missingTools.length === 1 ? 'is' : 'are'} not enabled for this run.)`
              : ''
          return Promise.resolve({
            modelResult: `# ${skill.name} (${skill.scope} skill)\n\n${skill.body}${note}`,
            detail: `${skill.scope}:${skill.name}`
          })
        }
      })
  })
