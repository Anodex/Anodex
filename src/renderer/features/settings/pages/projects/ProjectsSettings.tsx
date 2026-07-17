import { useCallback, useEffect, useState } from 'react'
import type { SkillDocument, SkillSummary } from '@shared/skill.types'
import { duplicateSkillMarkdown, nextSkillCopyName } from '../../../../lib/skillLibraryActions'
import { createSkillTemplate } from '../../../../lib/skillTemplate'
import {
  consumePendingSkillEditorDraft,
  pendingSkillEditorDraftName
} from '../../../../lib/skillEditorDraftHandoff'
import { useProjectStore, getActiveProject } from '../../../../stores/projectStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { PersonalSkillsSection } from '../tools-skills/PersonalSkillsSection'
import pageStyles from '../../SettingsPage.module.css'
import styles from './ProjectsSettings.module.css'

export function ProjectsSettings(): JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)
  const update = useProjectStore((s) => s.update)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)

  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [deletingSkill, setDeletingSkill] = useState<SkillSummary | null>(null)
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([])
  const [personalSkillNames, setPersonalSkillNames] = useState<string[]>([])
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
      setPersonalSkillNames([])
      return
    }
    const skills = await anodex.skills.list(activeProjectIdForSkills)
    setSkillCatalog(skills.filter((skill) => skill.scope === 'project'))
    setPersonalSkillNames(
      skills.filter((skill) => skill.scope === 'personal').map((skill) => skill.name)
    )
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

  const startNewSkill = (): void => {
    const name = 'project-workflow'
    setSkillError(null)
    setEditingSkill({ name, scope: 'project', content: createSkillTemplate(name) })
    setSkillDraft(createSkillTemplate(name))
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

  const duplicateSkill = async (skill: SkillSummary): Promise<void> => {
    if (!activeProject) return
    try {
      setSkillError(null)
      const document = await anodex.skills.read({
        projectId: activeProject.id,
        scope: skill.scope,
        name: skill.name
      })
      const name = nextSkillCopyName(
        skillCatalog.map((item) => item.name),
        skill.name
      )
      const content = duplicateSkillMarkdown(document.content, name)
      const saved = await anodex.skills.save({
        projectId: activeProject.id,
        scope: skill.scope,
        originalName: null,
        content
      })
      setEditingSkill({ name: saved.name, scope: saved.scope, content })
      setSkillDraft(content)
      await loadSkills()
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : 'Could not duplicate skill')
    }
  }

  const requestDeleteSkill = (skill: SkillSummary): void => {
    if (!confirmDestructive) {
      void deleteSkill(skill)
      return
    }
    setDeletingSkill(skill)
  }

  const deleteSkill = async (skill: SkillSummary): Promise<void> => {
    if (!activeProject) return
    try {
      setSkillError(null)
      await anodex.skills.delete({
        projectId: activeProject.id,
        scope: skill.scope,
        name: skill.name
      })
      const sameNameInOtherScope = personalSkillNames.includes(skill.name)
      if (!sameNameInOtherScope && activeProject.pinnedSkillNames.includes(skill.name)) {
        await update(activeProject.id, {
          pinnedSkillNames: activeProject.pinnedSkillNames.filter((name) => name !== skill.name)
        })
      }
      if (editingSkill?.name === skill.name && editingSkill.scope === skill.scope) {
        setEditingSkill(null)
        setSkillDraft('')
      }
      await loadSkills()
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : 'Could not delete skill')
    } finally {
      setDeletingSkill(null)
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
  const pinnedProjectSkillCount = activeProject
    ? skillCatalog.filter((skill) => activeProject.pinnedSkillNames.includes(skill.name)).length
    : 0

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Assistant</p>
        <h1 className={pageStyles.pageTitle}>Skills</h1>
        <p className={pageStyles.pageDesc}>
          Manage project-specific workflows and personal skills from one place.
        </p>
      </header>

      {activeProject && (
        <section className={pageStyles.section}>
          <h2 className={pageStyles.sectionTitle}>{activeProject.name}</h2>
          <p className={pageStyles.sectionDesc}>
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
                Project skills
                {pinnedProjectSkillCount > 0 ? ` · ${pinnedProjectSkillCount} project pinned` : ''}
              </span>
              <span className={styles.skillsSummaryHint}>Browse, pin, and edit project skills</span>
            </summary>
            <div className={styles.skillLibraryToolbar}>
              <input
                className={styles.skillSearch}
                value={skillSearch}
                placeholder="Search skills"
                onChange={(event) => setSkillSearch(event.target.value)}
              />
              <Button variant="ghost" size="sm" onClick={startNewSkill}>
                New project skill
              </Button>
            </div>
            {skillError && <div className={styles.skillError}>{skillError}</div>}
            {skillCatalog.length === 0 ? (
              <p className={styles.instructionsHint}>
                No project skills found yet. Create one here or add markdown under `.anodex/skills`.
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
                      <div className={styles.skillRowActions}>
                        <button
                          type="button"
                          className={`${styles.pinButton} ${pinned ? styles.pinButtonPinned : ''}`}
                          onClick={() => void togglePinnedSkill(skill.name)}
                        >
                          {pinned ? 'Pinned' : 'Pin'}
                        </button>
                        <button
                          type="button"
                          className={styles.pinButton}
                          onClick={() => void duplicateSkill(skill)}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className={`${styles.pinButton} ${styles.deleteSkillButton}`}
                          onClick={() => requestDeleteSkill(skill)}
                        >
                          Delete
                        </button>
                      </div>
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

      {!activeProject && (
        <section className={pageStyles.section}>
          <h2 className={pageStyles.sectionTitle}>No project selected</h2>
          <p className={pageStyles.sectionDesc}>
            Select a project in the sidebar to edit project instructions and project skills here.
          </p>
        </section>
      )}

      <PersonalSkillsSection />

      {deletingSkill && (
        <ConfirmDialog
          title="Delete skill?"
          message="This removes the markdown skill file from its current library."
          detail={`${deletingSkill.scope}: ${deletingSkill.name}`}
          confirmLabel="Delete skill"
          icon="trash"
          onCancel={() => setDeletingSkill(null)}
          onConfirm={() => void deleteSkill(deletingSkill)}
        />
      )}
    </div>
  )
}
