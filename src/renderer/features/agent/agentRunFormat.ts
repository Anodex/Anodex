/**
 * Presentation helpers shared by the Agent list (`AgentView`) and a single
 * run's drill-in log (`AgentRunConversation`), so both label a run's status,
 * provider and budgets the exact same way.
 */
import type { AgentRun, AgentRunStatus } from '@shared/agentRun.types'
import { agentRunModelLabel, agentRunProviderVendor } from '@shared/agentRunProviders'
import type { IconName } from '../../components/Icon'

/** A run that has stopped moving on its own — done, stopped, or errored. */
export function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === 'done' || status === 'stopped' || status === 'error'
}

/**
 * Short "backend used" label for a run, e.g. "Local", "Claude · Claude Sonnet 5".
 *
 * Reads the vendor and model name from the shared provider registry rather than
 * branching per provider. The branching version tested for local, then
 * Anthropic, and fell through to OpenAI — so once agent runs accepted all
 * twelve providers it rendered a DeepSeek run as "OpenAI · deepseek-v4-flash",
 * naming the wrong vendor on the one row whose job is to say what did the work.
 */
export function providerLabel(run: AgentRun): string {
  const vendor = agentRunProviderVendor(run.provider)
  const model = agentRunModelLabel(run.provider, run.model)
  return model ? `${vendor} · ${model}` : vendor
}

/** Local runs use the engine icon; every cloud run shares a generic cloud-model icon. */
export function providerIcon(run: AgentRun): IconName {
  return run.provider === 'local' ? 'cpu' : 'sparkle'
}

/** Compact token count for a status badge, e.g. 12400 -> "12.4k". */
export function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** How long a span of work took, e.g. "0.8s", "18.6s", "2m 04s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export const STATUS_ICON: Record<AgentRunStatus, IconName> = {
  running: 'activity',
  'needs-review': 'eye',
  done: 'check',
  stopped: 'stop',
  error: 'alert'
}

export const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: 'Running',
  'needs-review': 'Needs review',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error'
}
