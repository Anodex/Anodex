import { describe, expect, it } from 'vitest'
import {
  consumePendingSkillEditorDraft,
  pendingSkillEditorDraftName,
  savePendingSkillEditorDraft
} from '../skillEditorDraftHandoff'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('skill editor draft handoff', () => {
  it('stores and consumes a pending markdown draft once', () => {
    const storage = new MemoryStorage()
    const markdown = '---\nname: code-review\ndescription: Review changes.\n---\n# code-review\n'

    savePendingSkillEditorDraft(storage, markdown)

    expect(consumePendingSkillEditorDraft(storage)).toBe(markdown)
    expect(consumePendingSkillEditorDraft(storage)).toBeNull()
  })

  it('extracts the frontmatter skill name for editor labels', () => {
    expect(pendingSkillEditorDraftName('---\nname: project-flow\n---\n# Body')).toBe('project-flow')
  })

  it('falls back to a safe starter name when the draft has no valid name', () => {
    expect(pendingSkillEditorDraftName('# Missing name')).toBe('drafted-workflow')
    expect(pendingSkillEditorDraftName('---\nname: ../secret\n---')).toBe('drafted-workflow')
  })
})
