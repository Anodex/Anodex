import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/project.types'
import type { SkillDocument, SkillScope, SkillSummary } from '@shared/skill.types'
import {
  consumePendingSkillEditorDraft,
  pendingSkillEditorDraftName
} from '../../../../lib/skillEditorDraftHandoff'
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
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const [editingSkill, setEditingSkill] = useState<SkillDocument | null>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillError, setSkillError] = useState<string | null>(null)
  const [savingSkill, setSavingSkill] = useState(false)
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false)
  const activeProjectIdForSkills = activeProject?.id ?? null

  useEffect(() => {
    setInstructionsDraft(activeProject?.instructions ?? '')
  }, [activeProject?.id, activeProject?.instructions])

  const loadSkills = useCallback(async (): Promise<void> => {
    if (!activeProjectIdForSkills) {
      setSkillCatalog([])
      return
    }
    const skills = await anodex.skills.list(activeProjectIdForSkills)
    setSkillCatalog(skills)
  }, [activeProjectIdForSkills])

  useEffect(() => {
    let cancelled = false
    void loadSkills().catch((error) => {
      if (!cancelled)
        setSkillError(error instanceof Error ? error.message : 'Could not load skills')
    })
    return () => {
      cancelled = true
    }
  }, [loadSkills])

  useEffect(() => {
    if (!activeProjectIdForSkills) return
    try {
      const draft = consumePendingSkillEditorDraft(sessionStorage)
      if (!draft) return
      const name = pendingSkillEditorDraftName(draft)
      setSkillError(null)
      setSkillLibraryOpen(true)
      setEditingSkill({ name, scope: 'project', content: draft })
      setSkillDraft(draft)
    } catch {
      setSkillError('Could not open skill draft')
    }
  }, [activeProjectIdForSkills])

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

  const togglePinnedSkill = async (skillName: string): Promise<void> => {
    if (!activeProject) return
    const pinned = activeProject.pinnedSkillNames
    const pinnedSkillNames = pinned.includes(skillName)
      ? pinned.filter((name) => name !== skillName)
      : [...pinned, skillName]
    await update(activeProject.id, { pinnedSkillNames })
  }

  const openSkill = async (skill: SkillSummary): Promise<void> => {
    if (!activeProject) return
    try {
      setSkillError(null)
      const document = await anodex.skills.read({
        projectId: activeProject.id,
        scope: skill.scope,
        name: skill.name
      })
      setEditingSkill(document)
      setSkillDraft(document.content)
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : 'Could not read skill')
    }
  }

  const startNewSkill = (scope: SkillScope): void => {
    const name = scope === 'project' ? 'project-workflow' : 'personal-workflow'
    setSkillError(null)
    setEditingSkill({ name, scope, content: newSkillTemplate(name) })
    setSkillDraft(newSkillTemplate(name))
  }

  const saveSkill = async (): Promise<void> => {
    if (!activeProject || !editingSkill) return
    try {
      setSavingSkill(true)
      setSkillError(null)
      const saved = await anodex.skills.save({
        projectId: activeProject.id,
        scope: editingSkill.scope,
        originalName: editingSkill.name,
        content: skillDraft
      })
      setEditingSkill({ name: saved.name, scope: saved.scope, content: skillDraft })
      await loadSkills()
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : 'Could not save skill')
    } finally {
      setSavingSkill(false)
    }
  }

  const filteredSkillCatalog = skillCatalog.filter((skill) => {
    const query = skillSearch.trim().toLowerCase()
    if (!query) return true
    return [skill.name, skill.description, skill.scope, ...skill.keywords]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })

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
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(project)}>
                    Archive
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

          <details
            className={styles.skillsDisclosure}
            open={skillLibraryOpen}
            onToggle={(event) => setSkillLibraryOpen(event.currentTarget.open)}
          >
            <summary className={styles.skillsSummary}>
              <span>
                Skill library
                {activeProject.pinnedSkillNames.length > 0
                  ? ` · ${activeProject.pinnedSkillNames.length} pinned`
                  : ''}
              </span>
              <span className={styles.skillsSummaryHint}>Browse, pin, and edit skills</span>
            </summary>
            <div className={styles.skillLibraryToolbar}>
              <input
                className={styles.skillSearch}
                value={skillSearch}
                placeholder="Search skills"
                onChange={(event) => setSkillSearch(event.target.value)}
              />
              <Button variant="ghost" size="sm" onClick={() => startNewSkill('project')}>
                New project skill
              </Button>
              <Button variant="ghost" size="sm" onClick={() => startNewSkill('personal')}>
                New personal skill
              </Button>
            </div>
            {skillError && <div className={styles.skillError}>{skillError}</div>}
            {skillCatalog.length === 0 ? (
              <p className={styles.instructionsHint}>
                No project or personal skills found yet. Create a project skill here or add markdown
                skills under `.anodex/skills`.
              </p>
            ) : (
              <div className={styles.skillList}>
                {filteredSkillCatalog.length === 0 && (
                  <p className={styles.skillEmpty}>No skills match “{skillSearch.trim()}”.</p>
                )}
                {filteredSkillCatalog.map((skill) => {
                  const pinned = activeProject.pinnedSkillNames.includes(skill.name)
                  const selected =
                    editingSkill?.name === skill.name && editingSkill.scope === skill.scope
                  return (
                    <div
                      key={`${skill.scope}:${skill.name}`}
                      className={`${styles.skillRow} ${selected ? styles.skillRowSelected : ''}`}
                    >
                      <button
                        type="button"
                        className={styles.skillOpen}
                        onClick={() => void openSkill(skill)}
                      >
                        <span className={styles.skillToggleName}>{skill.name}</span>
                        <span className={styles.skillDescription}>{skill.description}</span>
                      </button>
                      <span className={styles.skillToggleMeta}>{skill.scope}</span>
                      <button
                        type="button"
                        className={`${styles.pinButton} ${pinned ? styles.pinButtonPinned : ''}`}
                        onClick={() => void togglePinnedSkill(skill.name)}
                      >
                        {pinned ? 'Pinned' : 'Pin'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {editingSkill && (
              <div className={styles.skillEditor}>
                <div className={styles.skillEditorHead}>
                  <div>
                    <div className={styles.skillEditorTitle}>{editingSkill.name}</div>
                    <div className={styles.skillEditorMeta}>{editingSkill.scope} markdown</div>
                  </div>
                  <div className={styles.skillEditorActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={savingSkill}
                      onClick={() => void saveSkill()}
                    >
                      {savingSkill ? 'Saving…' : 'Save skill'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingSkill(null)}>
                      Close
                    </Button>
                  </div>
                </div>
                <textarea
                  className={styles.skillTextarea}
                  value={skillDraft}
                  rows={14}
                  spellCheck={false}
                  onChange={(event) => setSkillDraft(event.target.value)}
                />
              </div>
            )}
          </details>
        </section>
      )}

      {deletingProject && (
        <ConfirmDialog
          title="Archive project?"
          message="The project and its chats will move to Settings → Archive."
          detail={deletingProject.name}
          confirmLabel="Archive"
          icon="archive"
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

function newSkillTemplate(name: string): string {
  return `---
name: ${name}
description: Describe when to use this workflow.
keywords: []
tools: []
---

# ${name}

## When to use

Use this skill when...

## Steps

1. Inspect the relevant context.
2. Make the smallest safe change.
3. Verify the result.

## Pitfalls

- Keep this focused on one reusable workflow class.
`
}
