import { useEffect, useState } from 'react'
import type { Project } from '@shared/project.types'
import { useProjectStore, getActiveProject } from '../../../../stores/projectStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { anodex } from '../../../../lib/anodex'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { TextControl } from '../../controls'
import styles from './ProjectsSettings.module.css'

export function ProjectsSettings(): JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)
  const create = useProjectStore((s) => s.create)
  const update = useProjectStore((s) => s.update)
  const remove = useProjectStore((s) => s.delete)
  const setActive = useProjectStore((s) => s.setActive)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)

  useEffect(() => {
    setInstructionsDraft(activeProject?.instructions ?? '')
  }, [activeProject?.id, activeProject?.instructions])

  const startCreate = async (): Promise<void> => {
    const result = await anodex.tools.pickWorkspace()
    if (!result.ok) return
    const folderPath = result.value
    if (!folderPath) return
    const name = folderPath.split(/[/\\]/).pop() ?? 'New project'
    await create({ name, folderPath })
  }

  const startEdit = (project: Project): void => {
    setEditingId(project.id)
    setEditName(project.name)
  }

  const saveEdit = async (id: string): Promise<void> => {
    const trimmed = editName.trim()
    if (trimmed) await update(id, { name: trimmed })
    setEditingId(null)
  }

  const handleDelete = (project: Project): void => {
    if (!confirmDestructive) {
      void remove(project.id)
      return
    }
    setDeletingProject(project)
  }

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>Projects</h2>
            <p className={styles.sectionDesc}>
              Each project links a folder that scopes the assistant&apos;s tools. Switching projects
              changes the active workspace.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="folder-plus" size={15} />}
            onClick={() => void startCreate()}
          >
            Link folder
          </Button>
        </div>

        {projects.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="folder" size={28} />
            <p className={styles.emptyTitle}>No projects yet</p>
            <p className={styles.emptyText}>
              Link a folder to create your first project. You can then start chats scoped to that
              folder.
            </p>
          </div>
        ) : (
          <ul className={styles.list}>
            {projects.map((project) => (
              <li
                key={project.id}
                className={`${styles.item} ${project.id === activeProjectId ? styles.itemActive : ''}`}
              >
                <div className={styles.itemMain}>
                  {editingId === project.id ? (
                    <div className={styles.editRow}>
                      <TextControl value={editName} onChange={setEditName} />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void saveEdit(project.id)}
                      >
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.itemName}>{project.name}</div>
                      <div className={styles.itemPath}>{project.folderPath}</div>
                    </>
                  )}
                </div>
                <div className={styles.itemActions}>
                  {project.id !== activeProjectId && (
                    <Button variant="ghost" size="sm" onClick={() => void setActive(project.id)}>
                      Activate
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => startEdit(project)}>
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(project)}
                    disabled={projects.length === 1}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeProject && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Active project</h2>
          <p className={styles.sectionDesc}>
            The assistant&apos;s tools are currently scoped to <strong>{activeProject.name}</strong>
            .
          </p>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>Folder</span>
            <span className={styles.metaValue}>{activeProject.folderPath}</span>
          </div>

          <div className={styles.instructions}>
            <label className={styles.metaLabel}>Project instructions</label>
            <p className={styles.instructionsHint}>
              Rules the assistant follows in this project — conventions, commands to run, and things
              to avoid. Added to its system prompt whenever this project is active.
            </p>
            <textarea
              className={styles.textarea}
              value={instructionsDraft}
              rows={5}
              placeholder={
                'e.g. Use pnpm. Run `pnpm test` after changes. Never edit files under /generated.'
              }
              onChange={(event) => setInstructionsDraft(event.target.value)}
            />
            <div className={styles.instructionsActions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={instructionsDraft === (activeProject.instructions ?? '')}
                onClick={() => void update(activeProject.id, { instructions: instructionsDraft })}
              >
                Save instructions
              </Button>
            </div>
          </div>
        </section>
      )}

      {deletingProject && (
        <ConfirmDialog
          title="Delete project?"
          message="Chats for this project will be removed from the current session."
          detail={deletingProject.name}
          confirmLabel="Delete"
          onCancel={() => setDeletingProject(null)}
          onConfirm={() => {
            void remove(deletingProject.id)
            setDeletingProject(null)
          }}
        />
      )}
    </div>
  )
}
