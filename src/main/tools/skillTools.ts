import { skillStore } from '../skills/SkillStore'
import { buildIndex, search } from '../skills/skillSearch'
import { runReadTool } from './helpers'
import type { ToolFactory } from './types'

const DEFAULT_LIMIT = 5

/**
 * Said whenever a skill search comes back empty.
 *
 * `find_skill` and `find_available_tool` are one word apart and both sound like
 * "find me the thing that does X". When a small context defers most of the
 * catalogue behind the gateway, a model that wants a tool it cannot see reaches
 * for the wrong one — and a skill search returning "no matches" gives it no
 * reason to try the other.
 *
 * Measured: on the email script at 8K, one model spent twenty-four calls in a
 * single turn on `find_skill` before concluding "I cannot find a skill to
 * search for an email by subject or to read emails" — while `search_email` and
 * `read_email` sat in the deferred catalogue, one `find_available_tool` away.
 * Five of six models in that matrix failed the same two criteria for the same
 * reason.
 */
const SKILLS_ARE_NOT_TOOLS =
  'Skills are written instructions, not tools. If you are looking for a tool that is not in your ' +
  'current list, call find_available_tool — the catalogue is larger than what is shown.'

/** find_skill — search the local skill catalog by query, returns ranked name/description matches. */
export const findSkillTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search the local skill catalog for reusable instructions relevant to a task. Returns matching skill names and descriptions — call load_skill on one to read its full instructions. Skills are written guidance, not tools: to find a TOOL you cannot see, use find_available_tool instead.',
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
        args,
        run() {
          const skills = skillStore.list(ctx.workspaceRoot)
          if (skills.length === 0) {
            const locations = ctx.workspaceRoot
              ? `"${skillStore.getProjectDir(ctx.workspaceRoot)}" or "${skillStore.getDir()}"`
              : `"${skillStore.getDir()}"`
            return Promise.resolve({
              modelResult:
                `No skills found yet. Add one as a markdown file in ${locations}. ` +
                SKILLS_ARE_NOT_TOOLS,
              detail: '0 skills in catalog'
            })
          }
          const results = search(buildIndex(skills), args.query, DEFAULT_LIMIT)
          if (results.length === 0) {
            return Promise.resolve({
              modelResult: `No matching skills found. ${SKILLS_ARE_NOT_TOOLS}`,
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
        args,
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
