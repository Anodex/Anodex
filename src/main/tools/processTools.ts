import type { BackgroundProcessInfo } from '@shared/process.types'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { classifyCommandRisk } from './permissions'
import { checkCommandCompatibility } from './commandGuidance'
import { backgroundProcessService } from '../processes/BackgroundProcessService'

/** How long a start waits to see whether the process dies at once or says where it is serving. */
const START_SETTLE_MS = 4_000
/** Output shown on a start or a read, from the recent end. */
const OUTPUT_TAIL_CHARS = 6_000

/**
 * start_process — run something that keeps running: a dev server, a watcher,
 * the game it just built. `run_command` waits for a command to exit, so it
 * cannot do this; this returns once the process has started and keeps it
 * running, in the project folder, until it is stopped or Anodex quits.
 */
export const startProcessTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Start a long-running command in the background (dev server, file watcher, a local app) and keep it running after this reply. Returns its first output and any local address it serves. Use run_command for commands that finish; use this for ones that do not. Stopped when Anodex quits.',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to start, e.g. "npm run dev".' },
        name: { type: 'string', description: 'Optional short name, e.g. "web server".' }
      },
      required: ['command']
    } as const,
    handler: (args: { command: string; name?: string }) =>
      runGuardedTool(ctx, {
        name: 'start_process',
        kind: 'command',
        title: `Start: ${args.command.length > 200 ? `${args.command.slice(0, 199)}…` : args.command}`,
        args,
        confirmDetail: `Keep running in the background, in ${ctx.workspaceRoot}:\n${args.command}`,
        risk: classifyCommandRisk(args.command),
        async run() {
          const incompatible = checkCommandCompatibility(
            args.command,
            process.platform,
            ctx.commandShell
          )
          if (incompatible) {
            return {
              modelResult: incompatible,
              detail: 'not run: incompatible command',
              madeProgress: false
            }
          }
          const started = backgroundProcessService.start({
            command: args.command,
            name: args.name,
            cwd: ctx.workspaceRoot,
            projectId: ctx.projectId,
            conversationId: ctx.conversationId,
            shell: ctx.commandShell
          })
          const settled = await settle(started.id)
          const tail = backgroundProcessService.output(started.id, OUTPUT_TAIL_CHARS)
          return {
            modelResult: `${describe(settled)}\n\n${tail?.text.trim() || '(no output yet)'}`,
            detail: settled.status === 'running' ? `running · ${settled.id}` : `${settled.status}`,
            madeProgress: true
          }
        }
      })
  })

/** read_process_output — the recent output of a background process. */
export const readProcessOutputTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Read the recent output of a background process started with start_process, to check it is serving or see an error it printed.',
    params: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The process id from start_process.' } },
      required: ['id']
    } as const,
    handler: (args: { id: string }) =>
      runReadTool(ctx, {
        name: 'read_process_output',
        kind: 'read',
        title: `Read output of ${args.id}`,
        args,
        run() {
          const info = ownProcess(ctx.projectId, args.id)
          if (!info) return Promise.resolve({ modelResult: notFound(args.id), madeProgress: false })
          const output = backgroundProcessService.output(args.id, OUTPUT_TAIL_CHARS)
          const note = output?.truncated ? '(earlier output omitted)\n' : ''
          return Promise.resolve({
            modelResult: `${describe(info)}\n\n${note}${output?.text.trim() || '(no output yet)'}`
          })
        }
      })
  })

/** list_processes — what is running for this project. */
export const listProcessesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'List the background processes started for this project, running and recently ended.',
    params: { type: 'object', properties: {} } as const,
    handler: () =>
      runReadTool(ctx, {
        name: 'list_processes',
        kind: 'read',
        title: 'List background processes',
        run() {
          const all = backgroundProcessService.list(ctx.projectId)
          return Promise.resolve({
            modelResult:
              all.length === 0
                ? 'No background processes for this project.'
                : all.map((info) => `- ${describe(info)}`).join('\n')
          })
        }
      })
  })

/**
 * stop_process — stop a background process and everything it started.
 * Trivial risk: it can only stop something Anodex itself started for this
 * project, and stopping is what a person asks for, not something to approve.
 */
export const stopProcessTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: 'Stop a background process started with start_process, and everything it started.',
    params: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The process id from start_process.' } },
      required: ['id']
    } as const,
    handler: (args: { id: string }) =>
      runGuardedTool(ctx, {
        name: 'stop_process',
        kind: 'command',
        title: `Stop ${args.id}`,
        args,
        confirmDetail: `Stop background process ${args.id}`,
        risk: 'trivial',
        async run() {
          if (!ownProcess(ctx.projectId, args.id)) {
            return { modelResult: notFound(args.id), detail: 'not found', madeProgress: false }
          }
          const stopped = await backgroundProcessService.stop(args.id)
          return { modelResult: stopped ? describe(stopped) : notFound(args.id), detail: 'stopped' }
        }
      })
  })

/** Wait until the process has died, said where it is serving, or had a few seconds. */
async function settle(id: string): Promise<BackgroundProcessInfo> {
  const deadline = Date.now() + START_SETTLE_MS
  for (;;) {
    const info = await backgroundProcessService.waitForExit(id, 250)
    if (!info || info.status !== 'running' || info.url || Date.now() >= deadline) {
      return info ?? (backgroundProcessService.get(id) as BackgroundProcessInfo)
    }
  }
}

/** A process from this project only: one project's chat cannot read or stop another's. */
function ownProcess(projectId: string | null, id: string): BackgroundProcessInfo | undefined {
  const info = backgroundProcessService.get(id.trim())
  return info && info.projectId === projectId ? info : undefined
}

function notFound(id: string): string {
  return `No background process "${id}" for this project. list_processes shows the ones there are.`
}

export function describe(info: BackgroundProcessInfo): string {
  const where = info.url ? ` at ${info.url}` : ''
  switch (info.status) {
    case 'running':
      return `"${info.name}" (id ${info.id}) is running${where}. It keeps running after this reply; stop it with stop_process.`
    case 'exited':
      return `"${info.name}" (id ${info.id}) exited with code ${info.exitCode}.`
    case 'stopped':
      return `"${info.name}" (id ${info.id}) was stopped.`
    case 'failed':
      return `"${info.name}" (id ${info.id}) could not start.`
  }
}
