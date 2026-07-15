import { useEffect, useMemo, useState } from 'react'
import type { Conversation } from '@shared/conversation.types'
import type { Project } from '@shared/project.types'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { useChatStore } from '../../../../stores/chatStore'
import { useProjectStore } from '../../../../stores/projectStore'
import { anodex } from '../../../../lib/anodex'
import { SelectControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './ArchiveSettings.module.css'

type KindFilter = 'all' | 'chats' | 'projects'

export function ArchiveSettings(): JSX.Element {
  const refreshConversations = useChatStore((s) => s.refreshConversations)
  const conversationCount = useChatStore((s) => s.conversations.length)
  const archiveAllConversations = useChatStore((s) => s.deleteAllConversations)
  const refreshProjects = useProjectStore((s) => s.load)

  const [archivedChats, setArchivedChats] = useState<Conversation[]>([])
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([])
  const [activeProjects, setActiveProjects] = useState<Project[]>([])
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [selectedChats, setSelectedChats] = useState<Set<string>>(() => new Set())
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingArchiveAll, setConfirmingArchiveAll] = useState(false)

  const reload = async (): Promise<void> => {
    const [chats, projects, activeState] = await Promise.all([
      anodex.conversations.listArchived(),
      anodex.projects.listArchived(),
      anodex.projects.list()
    ])
    setArchivedChats(chats)
    setArchivedProjects(projects)
    setActiveProjects(activeState.projects)
    setSelectedChats(new Set())
    setSelectedProjects(new Set())
  }

  useEffect(() => {
    void reload()
  }, [])

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of [...activeProjects, ...archivedProjects]) map.set(project.id, project)
    return map
  }, [activeProjects, archivedProjects])

  const visibleProjects = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (kindFilter === 'chats') return []
    return archivedProjects.filter((project) => {
      const matchesText =
        !text ||
        project.name.toLowerCase().includes(text) ||
        project.folderPath.toLowerCase().includes(text)
      return matchesText && (projectFilter === 'all' || projectFilter === project.id)
    })
  }, [archivedProjects, kindFilter, projectFilter, query])

  const visibleChats = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (kindFilter === 'projects') return []
    return archivedChats.filter((chat) => {
      const projectName = chat.projectId ? (projectsById.get(chat.projectId)?.name ?? '') : ''
      const matchesText =
        !text || chat.title.toLowerCase().includes(text) || projectName.toLowerCase().includes(text)
      const matchesProject =
        projectFilter === 'all' ||
        (projectFilter === 'general' && chat.projectId === null) ||
        chat.projectId === projectFilter
      return matchesText && matchesProject
    })
  }, [archivedChats, kindFilter, projectFilter, projectsById, query])

  const selectedCount = selectedChats.size + selectedProjects.size
  const archivedItemCount = archivedChats.length + archivedProjects.length
  const hasArchivedItems = archivedItemCount > 0
  const latestArchivedAt = Math.max(
    0,
    ...archivedChats.map((chat) => chat.archivedAt ?? chat.updatedAt),
    ...archivedProjects.map((project) => project.archivedAt ?? project.updatedAt)
  )
  const allVisibleSelected =
    visibleChats.length + visibleProjects.length > 0 &&
    visibleChats.every((chat) => selectedChats.has(chat.id)) &&
    visibleProjects.every((project) => selectedProjects.has(project.id))

  const toggleAllVisible = (): void => {
    if (allVisibleSelected) {
      setSelectedChats((prev) => {
        const next = new Set(prev)
        for (const chat of visibleChats) next.delete(chat.id)
        return next
      })
      setSelectedProjects((prev) => {
        const next = new Set(prev)
        for (const project of visibleProjects) next.delete(project.id)
        return next
      })
      return
    }
    setSelectedChats((prev) => new Set([...prev, ...visibleChats.map((chat) => chat.id)]))
    setSelectedProjects(
      (prev) => new Set([...prev, ...visibleProjects.map((project) => project.id)])
    )
  }

  const restoreChat = async (id: string): Promise<void> => {
    await anodex.conversations.restore(id)
    await refreshConversations()
    await reload()
  }

  const restoreProject = async (id: string): Promise<void> => {
    await anodex.projects.restore(id)
    await refreshProjects()
    await refreshConversations()
    await reload()
  }

  const deleteSelected = async (): Promise<void> => {
    for (const id of selectedProjects) await anodex.projects.deletePermanent(id)
    await anodex.conversations.deleteArchived([...selectedChats])
    await refreshProjects()
    await refreshConversations()
    await reload()
  }

  const archiveAll = async (): Promise<void> => {
    await archiveAllConversations()
    await reload()
  }

  const projectOptions = [
    { label: 'All projects', value: 'all' },
    { label: 'General chats', value: 'general' },
    ...[...activeProjects, ...archivedProjects].map((project) => ({
      label: project.name,
      value: project.id
    }))
  ]

  return (
    <div className={pageStyles.page}>
      <header className={`${pageStyles.pageHeader} ${styles.pageHeader}`}>
        <div>
          <p className={pageStyles.pageKicker}>System</p>
          <h1 className={pageStyles.pageTitle}>Archive</h1>
          <p className={pageStyles.pageDesc}>
            Restore archived chats and projects or permanently remove them.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={conversationCount === 0}
          iconLeft={<Icon name="archive" size={15} />}
          onClick={() => setConfirmingArchiveAll(true)}
        >
          Archive all chats
        </Button>
      </header>

      <div className={styles.summaryGrid} aria-label="Archive summary">
        <SummaryStat label="Archived items" value={String(archivedItemCount)} />
        <SummaryStat label="Projects" value={String(archivedProjects.length)} />
        <SummaryStat label="Chats" value={String(archivedChats.length)} />
        <SummaryStat
          label="Last archived"
          value={latestArchivedAt ? formatShortDate(latestArchivedAt) : '—'}
        />
      </div>

      <section className={`${pageStyles.section} ${styles.section}`}>
        <div className={styles.sectionHead}>
          <div>
            <h2 className={pageStyles.sectionTitle}>Archived items</h2>
            <p className={pageStyles.sectionDesc}>
              Restoring returns an item to the sidebar. Permanent deletion cannot be undone.
            </p>
          </div>
        </div>

        <div className={styles.toolbar}>
          <label className={styles.searchField}>
            <Icon name="search" size={14} />
            <input
              value={query}
              placeholder="Search archive"
              aria-label="Search archive"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <SelectControl
            value={kindFilter}
            options={[
              { label: 'All items', value: 'all' },
              { label: 'Chats', value: 'chats' },
              { label: 'Projects', value: 'projects' }
            ]}
            onChange={(value) => setKindFilter(toKindFilter(value))}
          />
          <SelectControl
            value={projectFilter}
            options={projectOptions}
            onChange={setProjectFilter}
          />
        </div>

        {!hasArchivedItems ? (
          <div className={styles.empty}>
            <Icon name="archive" size={28} />
            <p className={styles.emptyTitle}>Nothing archived</p>
            <p className={styles.emptyText}>Archived chats and projects will show up here.</p>
          </div>
        ) : (
          <div className={styles.archiveBox}>
            <div className={styles.bulkRow}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                Select visible
              </label>
              <div className={styles.bulkActions}>
                <span>{selectedCount} selected</span>
                <Button
                  className={styles.deleteButton}
                  variant="ghost"
                  size="sm"
                  disabled={selectedCount === 0}
                  iconLeft={<Icon name="trash" size={14} />}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete selected
                </Button>
              </div>
            </div>

            {visibleProjects.length > 0 && (
              <div className={styles.itemGroup}>
                <div className={styles.groupLabel}>Projects</div>
                {visibleProjects.map((project) => (
                  <article key={project.id} className={styles.item}>
                    <input
                      className={styles.itemCheckbox}
                      type="checkbox"
                      checked={selectedProjects.has(project.id)}
                      onChange={() =>
                        setSelectedProjects((prev) => toggleSetValue(prev, project.id))
                      }
                      aria-label={`Select ${project.name}`}
                    />
                    <span className={`${styles.itemIcon} ${styles.projectIcon}`}>
                      <Icon name="folder" size={16} />
                    </span>
                    <div className={styles.itemMain}>
                      <div className={styles.itemTitle}>{project.name}</div>
                      <div className={styles.itemMeta}>
                        <span className={`${styles.kindPill} ${styles.projectPill}`}>Project</span>
                        <span>Archived {formatDate(project.archivedAt ?? project.updatedAt)}</span>
                      </div>
                      <div className={styles.itemPath}>{project.folderPath}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<Icon name="restore" size={14} />}
                      onClick={() => void restoreProject(project.id)}
                    >
                      Restore
                    </Button>
                  </article>
                ))}
              </div>
            )}

            {visibleChats.length > 0 && (
              <div className={styles.itemGroup}>
                <div className={styles.groupLabel}>Chats</div>
                {visibleChats.map((chat) => {
                  const project = chat.projectId ? projectsById.get(chat.projectId) : null
                  return (
                    <article key={chat.id} className={styles.item}>
                      <input
                        className={styles.itemCheckbox}
                        type="checkbox"
                        checked={selectedChats.has(chat.id)}
                        onChange={() => setSelectedChats((prev) => toggleSetValue(prev, chat.id))}
                        aria-label={`Select ${chat.title}`}
                      />
                      <span className={`${styles.itemIcon} ${styles.chatIcon}`}>
                        <Icon name="chat" size={16} />
                      </span>
                      <div className={styles.itemMain}>
                        <div className={styles.itemTitle}>{chat.title}</div>
                        <div className={styles.itemMeta}>
                          <span className={`${styles.kindPill} ${styles.chatPill}`}>Chat</span>
                          <span>{project?.name ?? 'General chat'}</span>
                          <span>Archived {formatDate(chat.archivedAt ?? chat.updatedAt)}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconLeft={<Icon name="restore" size={14} />}
                        onClick={() => void restoreChat(chat.id)}
                      >
                        Restore
                      </Button>
                    </article>
                  )
                })}
              </div>
            )}

            {visibleChats.length + visibleProjects.length === 0 && (
              <div className={styles.noResults}>
                <Icon name="search" size={24} />
                <strong>No archived items found</strong>
                <span>Try changing the search or filters.</span>
              </div>
            )}
          </div>
        )}
      </section>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete selected archive items?"
          message="This permanently deletes the selected archived chats and projects. This can't be undone."
          detail={`${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
          confirmLabel="Delete selected"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void deleteSelected()
          }}
        />
      )}

      {confirmingArchiveAll && (
        <ConfirmDialog
          title="Archive all chats?"
          message="This moves every active conversation here, where it can be restored or permanently deleted."
          detail={`${conversationCount} conversation${conversationCount === 1 ? '' : 's'}`}
          confirmLabel="Archive all"
          icon="archive"
          onCancel={() => setConfirmingArchiveAll(false)}
          onConfirm={() => {
            setConfirmingArchiveAll(false)
            void archiveAll()
          }}
        />
      )}
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.summaryStat}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function toggleSetValue(values: Set<string>, value: string): Set<string> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function toKindFilter(value: string): KindFilter {
  return value === 'chats' || value === 'projects' ? value : 'all'
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(timestamp)
}

function formatShortDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(timestamp)
}
