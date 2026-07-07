import { useState } from 'react'
import type { AppSettings } from '@shared/settings.types'
import { useChatStore } from '../../../../stores/chatStore'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import styles from './GeneralSettings.module.css'

interface GeneralSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['general']>) => void
}

const PERMISSION_OPTIONS = [
  { label: 'Ask every time', value: 'ask' },
  { label: 'Allow writes, ask commands', value: 'full' },
  { label: 'Untethered', value: 'untethered' }
]

const STARTUP_OPTIONS = [
  { label: 'Reopen previous chats', value: 'reopen' },
  { label: 'Start empty', value: 'empty' }
]

export function GeneralSettings({ settings, update }: GeneralSettingsProps): JSX.Element {
  const { general } = settings
  const conversationCount = useChatStore((s) => s.conversations.length)
  const deleteAllConversations = useChatStore((s) => s.deleteAllConversations)
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Workspace defaults</h2>
        <p className={styles.sectionDesc}>Default folders and startup behaviour.</p>
        <SettingRow
          label="Startup"
          description="What happens when Anodex launches."
          control={
            <SelectControl
              value={general.startupBehavior}
              options={STARTUP_OPTIONS}
              onChange={(value) =>
                update({ startupBehavior: value as typeof general.startupBehavior })
              }
            />
          }
        />
        <SettingRow
          label="Project folder"
          description={general.projectFolder ?? 'No default project folder'}
          control={
            <TextControl
              value={general.projectFolder ?? ''}
              placeholder="/path/to/projects"
              onChange={(value) => update({ projectFolder: value || null })}
            />
          }
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Permissions</h2>
        <p className={styles.sectionDesc}>How much autonomy the assistant has over your machine.</p>
        <SettingRow
          label="Permission mode"
          description={permissionHint(general.permissionMode)}
          control={
            <SelectControl
              value={general.permissionMode}
              options={PERMISSION_OPTIONS}
              onChange={(value) =>
                update({ permissionMode: value as typeof general.permissionMode })
              }
            />
          }
        />
        <SettingRow
          label="Confirm destructive actions"
          description="Show a confirmation before delete, overwrite, or reset operations."
          control={
            <ToggleControl
              checked={general.confirmDestructive}
              onChange={(value) => update({ confirmDestructive: value })}
            />
          }
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Notifications & feedback</h2>
        <SettingRow
          label="Desktop notifications"
          description="Notify when long generations or model loads finish."
          control={
            <ToggleControl
              checked={general.desktopNotifications}
              onChange={(value) => update({ desktopNotifications: value })}
            />
          }
        />
        <SettingRow
          label="Auto-save"
          description="Automatically save chats and workspace state."
          control={
            <ToggleControl
              checked={general.autoSave}
              onChange={(value) => update({ autoSave: value })}
            />
          }
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Terminal</h2>
        <SettingRow
          label="Default shell"
          description="Shell used by the run_command tool."
          control={
            <TextControl
              value={general.defaultShell}
              placeholder="powershell"
              onChange={(value) => update({ defaultShell: value })}
            />
          }
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Data</h2>
        <p className={styles.sectionDesc}>Bulk actions on your local chat history.</p>
        <SettingRow
          label="Delete all chats"
          description={
            conversationCount > 0
              ? `Permanently remove all ${conversationCount} conversation${conversationCount === 1 ? '' : 's'} — general and project chats.`
              : 'No conversations to delete.'
          }
          control={
            <Button
              variant="danger"
              size="sm"
              disabled={conversationCount === 0}
              onClick={() => setConfirmingDeleteAll(true)}
            >
              Delete all
            </Button>
          }
        />
      </section>

      {confirmingDeleteAll && (
        <ConfirmDialog
          title="Delete all chats?"
          message="This permanently removes every conversation — general and project chats. This can't be undone."
          detail={`${conversationCount} conversation${conversationCount === 1 ? '' : 's'}`}
          confirmLabel="Delete all"
          onCancel={() => setConfirmingDeleteAll(false)}
          onConfirm={() => {
            setConfirmingDeleteAll(false)
            void deleteAllConversations()
          }}
        />
      )}
    </div>
  )
}

function permissionHint(mode: AppSettings['general']['permissionMode']): string {
  switch (mode) {
    case 'ask':
      return 'Prompt before writes and shell commands.'
    case 'full':
      return 'Allow file edits; still ask before destructive commands.'
    case 'untethered':
      return 'Allow all tool operations without prompts. Use with caution.'
  }
}
