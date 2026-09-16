import { hasInflightGeneration } from '../chat/inflightGenerations'
import { agentRunService } from '../agents/AgentRunService'
import { hasWaitingConfirmation } from '../ipc/tools.handlers'
import { hasActiveDownload } from '../llama/modelDownloader'

/**
 * Whether Anodex could quit right now without taking anything with it.
 *
 * Installing an update quits the app and starts it again, so an automatic
 * install waits for a moment where that costs nothing. Each of these is work
 * that a restart would destroy rather than postpone:
 *
 * - a reply being written, here or on a phone — the turn is lost mid-sentence;
 * - an agent run — the same, across as many turns as it had left;
 * - a prompt waiting for someone to approve it — the answer would arrive to a
 *   different process, and the tool call behind it is already half-made;
 * - a model being downloaded — tens of gigabytes, begun again from nothing.
 *
 * What is deliberately *not* here: an open window, an unsent draft, a terminal
 * the user has open. Those survive a restart, and waiting for a machine nobody
 * is at to have no windows open would mean never updating at all.
 */
export function nothingInFlight(): boolean {
  return (
    !hasInflightGeneration() &&
    !agentRunService.isRunning() &&
    !hasWaitingConfirmation() &&
    !hasActiveDownload()
  )
}
