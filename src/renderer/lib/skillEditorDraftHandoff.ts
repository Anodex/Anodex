const PENDING_SKILL_DRAFT_KEY = 'anodex:pendingSkillEditorDraft'
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface SkillDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function savePendingSkillEditorDraft(storage: SkillDraftStorage, markdown: string): void {
  storage.setItem(PENDING_SKILL_DRAFT_KEY, markdown)
}

export function consumePendingSkillEditorDraft(storage: SkillDraftStorage): string | null {
  const markdown = storage.getItem(PENDING_SKILL_DRAFT_KEY)
  if (markdown) storage.removeItem(PENDING_SKILL_DRAFT_KEY)
  return markdown
}

export function pendingSkillEditorDraftName(markdown: string): string {
  const match = markdown.match(/^name:\s*([^\r\n]+)\s*$/m)
  const name = match?.[1]?.trim() ?? ''
  return SKILL_NAME_RE.test(name) ? name : 'drafted-workflow'
}
