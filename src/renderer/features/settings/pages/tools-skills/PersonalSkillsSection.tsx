import { useCallback, useEffect, useState } from 'react'
import type { SkillDocument, SkillSummary } from '@shared/skill.types'
import { duplicateSkillMarkdown, nextSkillCopyName } from '../../../../lib/skillLibraryActions'
import { createSkillTemplate } from '../../../../lib/skillTemplate'
import { useProjectStore, getActiveProject } from '../../../../stores/projectStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import pageStyles from '../../SettingsPage.module.css'
import styles from './PersonalSkillsSection.module.css'

export function PersonalSkillsSection(): JSX.Element {
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const updateProject = useProjectStore((state) => state.update)
  const activeProject = getActiveProject(projects, activeProjectId)
  const confirmDestructive = useSettingsStore(
    (state) => state.settings?.general.confirmDestructive ?? true
  )

  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SkillDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<SkillSummary | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const catalog = await anodex.skills.list(null)
    setSkills(catalog.filter((skill) => skill.scope === 'personal'))
  }, [])

  useEffect(() => {
    void load().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Could not load personal skills')
    })
  }, [load])

  const openSkill = async (skill: SkillSummary): Promise<void> => {
    try {
      setError(null)
      const document = await anodex.skills.read({
        projectId: null,
        scope: 'personal',
        name: skill.name
      })
      setEditing(document)
      setDraft(document.content)
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Could not read personal skill')
    }
  }

  const startNew = (): void => {
    const name = 'personal-workflow'
    const content = createSkillTemplate(name)
    setError(null)
    setEditing({ name, scope: 'personal', content })
    setDraft(content)
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    try {
      setSaving(true)
      setError(null)
      const saved = await anodex.skills.save({
        projectId: null,
        scope: 'personal',
        originalName: editing.name,
        content: draft
      })
      setEditing({ name: saved.name, scope: 'personal', content: draft })
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save personal skill')
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async (skill: SkillSummary): Promise<void> => {
    try {
      setError(null)
      const document = await anodex.skills.read({
        projectId: null,
        scope: 'personal',
        name: skill.name
      })
      const name = nextSkillCopyName(
        skills.map((item) => item.name),
        skill.name
      )
      const content = duplicateSkillMarkdown(document.content, name)
      const saved = await anodex.skills.save({
        projectId: null,
        scope: 'personal',
        originalName: null,
        content
      })
      setEditing({ name: saved.name, scope: 'personal', content })
      setDraft(content)
      await load()
    } catch (duplicateError) {
      setError(
        duplicateError instanceof Error
          ? duplicateError.message
          : 'Could not duplicate personal skill'
      )
    }
  }

  const deleteSkill = async (skill: SkillSummary): Promise<void> => {
    try {
      setError(null)
      await anodex.skills.delete({ projectId: null, scope: 'personal', name: skill.name })
      if (editing?.name === skill.name) {
        setEditing(null)
        setDraft('')
      }
      if (activeProject?.pinnedSkillNames.includes(skill.name)) {
        const activeCatalog = await anodex.skills.list(activeProject.id)
        const projectSkillStillUsesName = activeCatalog.some(
          (item) => item.scope === 'project' && item.name === skill.name
        )
        if (!projectSkillStillUsesName) {
          await updateProject(activeProject.id, {
            pinnedSkillNames: activeProject.pinnedSkillNames.filter((name) => name !== skill.name)
          })
        }
      }
      await load()
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'Could not delete personal skill'
      )
    } finally {
      setDeleting(null)
    }
  }

  const requestDelete = (skill: SkillSummary): void => {
    if (!confirmDestructive) {
      void deleteSkill(skill)
      return
    }
    setDeleting(skill)
  }

  const togglePinned = async (name: string): Promise<void> => {
    if (!activeProject) return
    const pinnedSkillNames = activeProject.pinnedSkillNames.includes(name)
      ? activeProject.pinnedSkillNames.filter((item) => item !== name)
      : [...activeProject.pinnedSkillNames, name]
    await updateProject(activeProject.id, { pinnedSkillNames })
  }

  const filtered = skills.filter((skill) => {
    const text = query.trim().toLowerCase()
    if (!text) return true
    return [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase().includes(text)
  })

  return (
    <section className={pageStyles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={pageStyles.sectionTitle}>Personal skills</h2>
          <p className={pageStyles.sectionDesc}>
            Reusable markdown workflows available in every project and general chat.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={startNew}>
          New personal skill
        </Button>
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          placeholder="Search personal skills"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className={styles.projectHint}>
          {activeProject ? `Pinning to ${activeProject.name}` : 'Open a project to pin skills'}
        </span>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {skills.length === 0 ? (
        <div className={styles.empty}>
          Personal skills live in your Anodex data folder and do not require an active project.
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.length === 0 && (
            <p className={styles.empty}>No personal skills match “{query}”.</p>
          )}
          {filtered.map((skill) => {
            const pinned = activeProject?.pinnedSkillNames.includes(skill.name) ?? false
            const selected = editing?.name === skill.name
            return (
              <div
                key={skill.name}
                className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
              >
                <button type="button" className={styles.open} onClick={() => void openSkill(skill)}>
                  <span className={styles.name}>{skill.name}</span>
                  <span className={styles.description}>{skill.description}</span>
                </button>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.action} ${pinned ? styles.actionActive : ''}`}
                    disabled={!activeProject}
                    onClick={() => void togglePinned(skill.name)}
                  >
                    {pinned ? 'Pinned' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void duplicate(skill)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className={`${styles.action} ${styles.deleteAction}`}
                    onClick={() => requestDelete(skill)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <div className={styles.editor}>
          <div className={styles.editorHead}>
            <div>
              <div className={styles.editorTitle}>{editing.name}</div>
              <div className={styles.editorMeta}>personal markdown</div>
            </div>
            <div className={styles.editorActions}>
              <Button variant="secondary" size="sm" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save skill'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Close
              </Button>
            </div>
          </div>
          <textarea
            className={styles.textarea}
            value={draft}
            rows={14}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete personal skill?"
          message="This removes the markdown skill from your personal library."
          detail={deleting.name}
          confirmLabel="Delete skill"
          icon="trash"
          onCancel={() => setDeleting(null)}
          onConfirm={() => void deleteSkill(deleting)}
        />
      )}
    </section>
  )
}
