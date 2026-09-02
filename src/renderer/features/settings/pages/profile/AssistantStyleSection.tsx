import { useState } from 'react'
import type { AssistantStyleSettings } from '@shared/settings.types'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import {
  MAX_PERSONALITY_NAME_CHARS,
  MAX_SAVED_PERSONALITIES,
  allChatPersonalities,
  findChatPersonality,
  isBuiltInPersonalityId,
  normalizePersonalityName,
  resolveActiveStyle,
  type ChatPersonality
} from '@shared/chatPersonality'
import { renderAssistantStyleSection } from '@shared/prompts'
import { Button } from '../../../../components/ui/Button'
import { SettingRow } from '../../SettingRow'
import { SelectControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './AssistantStyleSection.module.css'

interface AssistantStyleSectionProps {
  value: AssistantStyleSettings
  update: (patch: Partial<AssistantStyleSettings>) => void
}

const NO_PERSONALITY = ''

/**
 * Manage named assistant personalities, or edit the unnamed free-text style.
 *
 * This replaced a "Quick start" dropdown that only typed a preset into the
 * textarea: picking a second preset destroyed whatever the first had been
 * edited into, and nothing the user wrote could be given a name or brought
 * back. The presets are now real personalities you can select, copy and keep.
 *
 * Built-ins are read-only on purpose — they live in code, so an edit here would
 * have nowhere to persist to. "Duplicate to edit" makes the copy explicit
 * rather than silently forking one behind the user's back.
 */
export function AssistantStyleSection({ value, update }: AssistantStyleSectionProps): JSX.Element {
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const [draftName, setDraftName] = useState('')

  const saved = value.personalities
  const activeId = value.activePersonalityId
  const active = findChatPersonality(saved, activeId)
  const style = resolveActiveStyle({ saved, activeId, globalStyle: value.globalStyle })
  const readOnly = active !== null && isBuiltInPersonalityId(active.id)
  const atLimit = saved.length >= MAX_SAVED_PERSONALITIES

  /** Route an edit to whichever store the current selection actually lives in. */
  function updateStyle(next: string): void {
    const clipped = next.slice(0, MAX_ASSISTANT_STYLE_CHARS)
    if (!active) {
      update({ globalStyle: clipped })
      return
    }
    // A built-in has no writable home; the textarea is read-only, so this is
    // unreachable from the UI and only guards a future caller.
    if (isBuiltInPersonalityId(active.id)) return
    update({
      personalities: saved.map((item) =>
        item.id === active.id ? { ...item, style: clipped } : item
      )
    })
  }

  /** Save the text on screen as a new named personality and select it. */
  function saveAsNew(): void {
    const name = normalizePersonalityName(draftName)
    if (!name || atLimit) return
    const personality: ChatPersonality = { id: crypto.randomUUID(), name, style }
    update({
      personalities: [...saved, personality],
      activePersonalityId: personality.id
    })
    setDraftName('')
  }

  function renameActive(): void {
    const name = normalizePersonalityName(draftName)
    if (!name || !active || isBuiltInPersonalityId(active.id)) return
    update({
      personalities: saved.map((item) => (item.id === active.id ? { ...item, name } : item))
    })
    setDraftName('')
  }

  /**
   * Deleting also clears the selection. `resolveActiveStyle` would survive the
   * dangling id, but leaving one behind means the picker shows nothing selected
   * while the free text quietly takes over — better to make that switch visible.
   */
  function deleteActive(): void {
    if (!active || isBuiltInPersonalityId(active.id)) return
    update({
      personalities: saved.filter((item) => item.id !== active.id),
      activePersonalityId: null
    })
  }

  return (
    <section className={pageStyles.section}>
      <h2 className={pageStyles.sectionTitle}>Assistant personalities</h2>
      <p className={pageStyles.sectionDesc}>
        How the assistant talks, in every conversation. Pick a personality or write your own — this
        sits ahead of project instructions and applies before anything else.
      </p>
      <SettingRow
        label="Personality"
        description={
          readOnly
            ? 'A built-in personality. Duplicate it to make changes.'
            : active
              ? 'Edits below are saved to this personality.'
              : 'No personality selected — the text below is used as-is.'
        }
        control={
          <SelectControl
            value={activeId ?? NO_PERSONALITY}
            options={[
              { label: 'None (free text)', value: NO_PERSONALITY },
              ...allChatPersonalities(saved).map((item) => ({
                label: isBuiltInPersonalityId(item.id) ? `${item.name} (built-in)` : item.name,
                value: item.id
              }))
            ]}
            onChange={(id) => {
              update({ activePersonalityId: id === NO_PERSONALITY ? null : id })
              setDraftName('')
            }}
          />
        }
      />
      <textarea
        className={styles.textarea}
        value={style}
        rows={10}
        readOnly={readOnly}
        maxLength={MAX_ASSISTANT_STYLE_CHARS}
        placeholder="e.g. Be direct and terse. Explain tradeoffs before making a choice."
        onChange={(event) => updateStyle(event.target.value)}
      />
      <div className={styles.meta}>
        <span className={styles.counter}>
          {style.length} / {MAX_ASSISTANT_STYLE_CHARS}
        </span>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((current) => !current)}
            disabled={!style.trim()}
          >
            {showPreview ? 'Hide preview' : 'Preview'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!style}
            onClick={() => {
              void navigator.clipboard.writeText(style).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {active && !readOnly && (
            <Button variant="ghost" size="sm" onClick={deleteActive}>
              Delete
            </Button>
          )}
          {!active && (
            <Button variant="ghost" size="sm" disabled={!style} onClick={() => updateStyle('')}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className={styles.saveRow}>
        <input
          className={styles.nameInput}
          value={draftName}
          maxLength={MAX_PERSONALITY_NAME_CHARS}
          placeholder={readOnly ? `Name for your copy of ${active.name}` : 'Name this personality'}
          aria-label="Personality name"
          onChange={(event) => setDraftName(event.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!normalizePersonalityName(draftName) || !style.trim() || atLimit}
          onClick={saveAsNew}
        >
          {readOnly ? 'Duplicate to edit' : 'Save as new'}
        </Button>
        {active && !readOnly && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!normalizePersonalityName(draftName)}
            onClick={renameActive}
          >
            Rename
          </Button>
        )}
      </div>
      {atLimit && (
        <p className={styles.limit}>
          You have {MAX_SAVED_PERSONALITIES} saved personalities, the maximum. Delete one to save
          another.
        </p>
      )}
      {showPreview && style.trim() && (
        <pre className={styles.preview}>{renderAssistantStyleSection(style.trim())}</pre>
      )}
    </section>
  )
}
