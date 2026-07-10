import { useEffect, useState } from 'react'
import type { MemoryEntry, MemoryKind, MemoryScope } from '@shared/memory.types'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useProjectStore, getActiveProject } from '../../../../stores/projectStore'
import { notifyError } from '../../../../stores/uiStore'
import { anodex } from '../../../../lib/anodex'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import styles from './MemorySettings.module.css'

const KIND_OPTIONS: { label: string; value: MemoryKind }[] = [
  { label: 'Identity', value: 'identity' },
  { label: 'Convention', value: 'convention' },
  { label: 'Gotcha', value: 'gotcha' },
  { label: 'Preference', value: 'preference' },
  { label: 'Open task', value: 'open_task' }
]

const KIND_LABEL: Record<MemoryKind, string> = {
  identity: 'Identity',
  convention: 'Convention',
  gotcha: 'Gotcha',
  preference: 'Preference',
  open_task: 'Open task'
}

export function MemorySettings(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)

  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [deletingEntry, setDeletingEntry] = useState<MemoryEntry | null>(null)

  const [draftKind, setDraftKind] = useState<MemoryKind>('convention')
  const [draftText, setDraftText] = useState('')
  const [draftScope, setDraftScope] = useState<'project' | 'global'>(
    activeProjectId ? 'project' : 'global'
  )

  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)

  const load = async (): Promise<void> => {
    const result = await anodex.memory.list(activeProjectId)
    if (result.ok) setEntries(result.value)
    setLoaded(true)
  }

  useEffect(() => {
    void load()
    setDraftScope(activeProjectId ? 'project' : 'global')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  if (!settings) return <></>

  const scopeOf = (entry: MemoryEntry): MemoryScope => entry.scope
  const scopeLabel = (entry: MemoryEntry): string =>
    entry.scope.type === 'global' ? 'Global' : 'Project'

  const visible = entries.filter((e) => showArchived || !e.archived)
  const projectEntries = visible.filter((e) => e.scope.type === 'project')
  const globalEntries = visible.filter((e) => e.scope.type === 'global')

  const startEdit = (entry: MemoryEntry): void => {
    setEditingId(entry.id)
    setEditText(entry.text)
  }

  const saveEdit = async (entry: MemoryEntry): Promise<void> => {
    const trimmed = editText.trim()
    if (trimmed) {
      const result = await anodex.memory.update(scopeOf(entry), entry.id, { text: trimmed })
      if (result.ok) await load()
      else notifyError('Could not update memory', result.error.message)
    }
    setEditingId(null)
  }

  const togglePin = async (entry: MemoryEntry): Promise<void> => {
    const result = await anodex.memory.update(scopeOf(entry), entry.id, { pinned: !entry.pinned })
    if (result.ok) await load()
    else notifyError('Could not update memory', result.error.message)
  }

  const toggleArchive = async (entry: MemoryEntry): Promise<void> => {
    const result = await anodex.memory.update(scopeOf(entry), entry.id, {
      archived: !entry.archived
    })
    if (result.ok) await load()
    else notifyError('Could not update memory', result.error.message)
  }

  const remove = (entry: MemoryEntry): void => {
    if (!confirmDestructive) {
      void deleteEntry(entry)
      return
    }
    setDeletingEntry(entry)
  }

  const deleteEntry = async (entry: MemoryEntry): Promise<void> => {
    const result = await anodex.memory.delete(scopeOf(entry), entry.id)
    if (result.ok) await load()
    else notifyError('Could not delete memory', result.error.message)
  }

  const addMemory = async (): Promise<void> => {
    const text = draftText.trim()
    if (!text) return
    const scope: MemoryScope =
      draftScope === 'project' && activeProjectId
        ? { type: 'project', projectId: activeProjectId }
        : { type: 'global' }
    const result = await anodex.memory.create({ kind: draftKind, text, scope })
    if (result.ok) {
      setDraftText('')
      await load()
    } else {
      notifyError('Could not create memory', result.error.message)
    }
  }

  const renderList = (list: MemoryEntry[], emptyText: string): JSX.Element => (
    <>
      {list.length === 0 ? (
        <p className={styles.emptyText}>{emptyText}</p>
      ) : (
        <ul className={styles.list}>
          {list.map((entry) => (
            <li
              key={entry.id}
              className={`${styles.item} ${entry.archived ? styles.itemArchived : ''}`}
            >
              <div className={styles.itemMain}>
                {editingId === entry.id ? (
                  <div className={styles.editRow}>
                    <TextControl value={editText} onChange={setEditText} />
                    <Button variant="secondary" size="sm" onClick={() => void saveEdit(entry)}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className={styles.itemMeta}>
                      <span className={styles.badge}>{KIND_LABEL[entry.kind]}</span>
                      <span className={styles.scopeLabel}>{scopeLabel(entry)}</span>
                      {entry.pinned && <Icon name="flame" size={14} />}
                    </div>
                    <div className={styles.itemText}>{entry.text}</div>
                  </>
                )}
              </div>
              <div className={styles.itemActions}>
                <Button variant="ghost" size="sm" onClick={() => void togglePin(entry)}>
                  {entry.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => startEdit(entry)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void toggleArchive(entry)}>
                  {entry.archived ? 'Unarchive' : 'Archive'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => remove(entry)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Memory</h2>
        <p className={styles.sectionDesc}>
          Durable facts the assistant remembers across conversations — conventions, gotchas,
          preferences, open tasks. Turning a scope off stops it being read or written, but never
          deletes what&apos;s already stored.
        </p>
        <SettingRow
          label="Cross-chat memory"
          description="Recall project-scoped memories across every conversation in this project."
          control={
            <ToggleControl
              checked={settings.memory.crossChatEnabled}
              onChange={(value) => void update({ memory: { crossChatEnabled: value } })}
            />
          }
        />
        <SettingRow
          label="Personal memory"
          description="Recall global memories — things about you — across every project."
          control={
            <ToggleControl
              checked={settings.memory.personalEnabled}
              onChange={(value) => void update({ memory: { personalEnabled: value } })}
            />
          }
        />
        <SettingRow
          label="Show archived"
          description="Include archived memories in the lists below."
          control={<ToggleControl checked={showArchived} onChange={setShowArchived} />}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Add a memory</h2>
        <p className={styles.sectionDesc}>
          The assistant usually adds these itself via the remember_fact tool. Add one by hand to
          seed memory without a conversation.
        </p>
        <div className={styles.addRow}>
          <SelectControl
            value={draftKind}
            options={KIND_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            onChange={(value) => setDraftKind(value as MemoryKind)}
          />
          <TextControl
            value={draftText}
            onChange={setDraftText}
            placeholder="e.g. Uses pnpm, not npm."
          />
          <SelectControl
            value={draftScope}
            options={[
              ...(activeProjectId
                ? [{ label: `Project (${activeProject?.name ?? 'active'})`, value: 'project' }]
                : []),
              { label: 'Global (personal)', value: 'global' }
            ]}
            onChange={(value) => setDraftScope(value as 'project' | 'global')}
          />
          <Button variant="primary" size="sm" onClick={() => void addMemory()}>
            Add
          </Button>
        </div>
      </section>

      {activeProjectId && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Project memory</h2>
          <p className={styles.sectionDesc}>
            Scoped to <strong>{activeProject?.name ?? 'this project'}</strong> — recalled across
            every chat in it, not just this one.
          </p>
          {renderList(projectEntries, 'No project memories yet.')}
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Personal memory</h2>
        <p className={styles.sectionDesc}>Recalled in every project.</p>
        {renderList(globalEntries, 'No personal memories yet.')}
      </section>

      {!loaded && <p className={styles.emptyText}>Loading…</p>}

      {deletingEntry && (
        <ConfirmDialog
          title="Delete memory?"
          message="This cannot be undone."
          detail={deletingEntry.text}
          confirmLabel="Delete"
          onCancel={() => setDeletingEntry(null)}
          onConfirm={() => {
            void deleteEntry(deletingEntry)
            setDeletingEntry(null)
          }}
        />
      )}
    </div>
  )
}
