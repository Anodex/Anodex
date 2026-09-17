import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * Everything a paired phone can reach, pinned.
 *
 * `channelPolicy.ts` chose a denylist on purpose, and a denylist fails open: a
 * channel added tomorrow is remotely reachable unless somebody remembers to deny
 * it. That file justified the choice by naming this test — which did not exist.
 * The two tests that did touch the policy checked hand-typed channel names, so
 * nothing ever compared the rules against the channels that actually exist, and
 * five had meanwhile drifted into reach that the rules already covered under
 * another name.
 *
 * So this is the mitigation, written to do the job the comment claimed. It reads
 * the generated protocol artifact — the same file the phone is built against —
 * and compares what the policy lets through against the list below.
 *
 * **When this fails, do not paste the new channel in to make it pass.** A diff
 * here is the question "should a phone be able to do this?" arriving at the one
 * moment anybody will ever be asked it. Answer it, then either deny the channel
 * in `channelPolicy.ts` or add it here deliberately.
 *
 * It earned its keep immediately: widening the policy to the owner's decision
 * moved forty-odd channels into reach at once, and this list refused to let that
 * happen without somebody writing every one of them down.
 */
const REACHABLE_FROM_A_PHONE = [
  'agent:approve-plan',
  'agent:create',
  'agent:delete',
  'agent:list',
  'agent:reject-plan',
  'agent:runs-changed',
  'agent:stop',
  'agent:turns',
  'attachments:abort-upload',
  'attachments:begin-upload',
  'attachments:complete-upload',
  'attachments:discard-upload',
  'attachments:pick-image',
  'attachments:read-file',
  'attachments:upload-chunk',
  'backup:backup-data',
  'backup:export-conversation',
  'backup:reveal-path',
  'changes:list',
  'chat:compact',
  'chat:context-usage',
  'chat:history-compacted',
  'chat:replay-suggestion',
  'chat:send',
  'chat:set-live-thinking',
  'chat:set-live-tokens',
  'chat:stop',
  'chat:stream',
  'chat:summarize',
  'chat:thinking-stream',
  'chat:title',
  'chat:working',
  'checkpoints:inspect',
  'checkpoints:list',
  'checkpoints:restore',
  'checkpoints:rollback',
  'checkpoints:undo',
  'computer-control:changed',
  'computer-control:get',
  'computer-control:list-desktop-targets',
  'computer-control:pause',
  'computer-control:resume',
  'computer-control:start',
  'computer-control:stop',
  'context-menu:show',
  'conversations:attachment-preview',
  'conversations:branch-for-edit',
  'conversations:changed',
  'conversations:clear-visual-previews',
  'conversations:delete',
  'conversations:delete-all',
  'conversations:delete-archived',
  'conversations:delete-permanent',
  'conversations:get',
  'conversations:get-state',
  'conversations:get-visual-preview-usage',
  'conversations:list-archived',
  'conversations:list-summaries',
  'conversations:list-without-messages',
  'conversations:read-visual-preview',
  'conversations:restore',
  'conversations:save',
  'conversations:search',
  'conversations:set-state',
  'conversations:thinking',
  'critical-thinking:approve',
  'critical-thinking:create',
  'critical-thinking:delete',
  'critical-thinking:list',
  'critical-thinking:resume',
  'critical-thinking:runs-changed',
  'critical-thinking:stop',
  'critical-thinking:stream',
  'devices:changed',
  'devices:list',
  'devices:rename',
  'devices:unpair',
  'diagnostics:entry',
  'diagnostics:get-log-file',
  'diagnostics:get-memory-usage',
  'diagnostics:get-support-bundle-preview',
  'diagnostics:list',
  'diagnostics:reveal-log-file',
  'email:apply-flag',
  'email:connect-oauth',
  'email:connect-password',
  'email:create-draft',
  'email:digest-threads',
  'email:discover',
  'email:get-status',
  'email:get-thread-messages',
  'email:get-unread-thread-count',
  'email:list-accounts',
  'email:list-mailboxes',
  'email:list-threads',
  'email:load-remote-images',
  'email:move',
  'email:read-message',
  'email:remove-account',
  'email:save-attachment',
  'email:search',
  'email:send',
  'email:set-primary-account',
  'email:set-sync-mode',
  'git:commit',
  'git:create-branch',
  'git:get-status',
  'git:init',
  'git:list-branches',
  'git:push',
  'git:switch-branch',
  'github:connect',
  'github:detect-repository',
  'github:disconnect',
  'github:get-state',
  'mcp:add',
  'mcp:connect',
  'mcp:disconnect-auth',
  'mcp:get-statuses',
  'mcp:list',
  'mcp:list-tools',
  'mcp:remove',
  'mcp:set-enabled',
  'mcp:set-static-token',
  'mcp:status-changed',
  'mcp:test-connection',
  'mcp:update',
  'memory:changed',
  'memory:create',
  'memory:delete',
  'memory:list',
  'memory:update',
  'models:cancel-download',
  'models:delete',
  'models:discover',
  'models:dismiss-load-recovery',
  'models:dismiss-load-refusal',
  'models:download',
  'models:download-progress',
  'models:fetch-top-models',
  'models:get-load-recovery',
  'models:get-reliability',
  'models:get-state',
  'models:list',
  'models:load',
  'models:recommend-settings',
  'models:state-changed',
  'models:unload',
  'personality:image',
  'personality:list',
  'personality:set-active',
  'projects:archive',
  'projects:changed',
  'projects:create',
  'projects:delete-permanent',
  'projects:list',
  'projects:list-archived',
  'projects:restore',
  'projects:set-active',
  'projects:update',
  'provider:get-usage-snapshot',
  'provider:list-models',
  'provider:usage-changed',
  'provider:verify-key',
  'scheduler:create',
  'scheduler:delete',
  'scheduler:get-keep-awake',
  'scheduler:list',
  'scheduler:parse-when',
  'scheduler:run-now',
  'scheduler:set-keep-awake',
  'scheduler:tasks-changed',
  'scheduler:update',
  'settings:changed',
  'settings:forget-personality-image',
  'settings:get',
  'settings:get-profile',
  'settings:update',
  'skills:delete',
  'skills:list',
  'skills:read',
  'skills:save',
  'stats:get-usage-breakdown',
  'stats:get-usage-profile',
  'system:get-hardware-info',
  'system:get-info',
  'toast:focus-main',
  'toast:open-conversation',
  'toast:show',
  'tools:activity',
  'tools:confirm-cancelled',
  'tools:confirm-request',
  'tools:confirm-response',
  'tools:pending-confirmations',
  'tools:pick-folder',
  'tools:pick-workspace',
  'updates:check',
  'updates:download',
  'updates:get-status',
  'updates:install-and-restart',
  'updates:status-changed',
  'window:close',
  'window:is-maximized',
  'window:maximize',
  'window:maximized-changed',
  'window:minimize',
  'workspace:delete-path',
  'workspace:get-absolute-path',
  'workspace:list-files',
  'workspace:prepare-html-preview',
  'workspace:read-file-content',
  'workspace:write-file-content'
]

describe('what a paired phone can reach', () => {
  const protocol = JSON.parse(
    readFileSync(join(__dirname, '../../../../protocol/anodex-protocol.json'), 'utf8')
  ) as { channels: Array<{ channel: string }> }

  const reachable = protocol.channels
    .map((c) => c.channel)
    .filter((c) => decideRemoteChannel(c).allowed)
    .sort()

  it('is exactly the set that was decided on', () => {
    expect(reachable).toEqual([...REACHABLE_FROM_A_PHONE].sort())
  })

  it('does not include anything that opens a window on the computer', () => {
    // The rule these five broke. Each was reachable while a channel doing the
    // identical thing under another name was denied.
    for (const channel of [
      'projects:open-folder',
      'projects:open-in-browser',
      'email:open-webmail',
      'diagnostics:save-support-bundle',
      'context-menu:run-action'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('is comparing against a protocol that actually loaded', () => {
    // A guard on the guard: an empty or unreadable artifact would let the
    // comparison above pass by agreeing that nothing is reachable.
    expect(protocol.channels.length).toBeGreaterThan(200)
  })
})
