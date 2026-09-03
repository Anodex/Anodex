import { useEffect, useRef, useState } from 'react'
import type { AssistantStyleSettings } from '@shared/settings.types'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import {
  BUILT_IN_CHAT_PERSONALITIES,
  MAX_PERSONALITY_NAME_CHARS,
  MAX_PERSONALITY_ROLE_CHARS,
  MAX_PERSONALITY_STORY_CHARS,
  MAX_SAVED_PERSONALITIES,
  PERSONALITY_TINTS,
  findChatPersonality,
  isBuiltInPersonalityId,
  normalizePersonalityName,
  type ChatPersonality
} from '@shared/chatPersonality'
import { renderAssistantStyleSection, renderPersonaSection } from '@shared/prompts'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { PersonalityAvatar } from '../../../../components/ui/PersonalityAvatar'
import { personalityDisplayName } from '../../../../components/ui/personalityIdentity'
import { PersonalityPicker } from './PersonalityPicker'
import pageStyles from '../../SettingsPage.module.css'
import styles from './PersonalitySection.module.css'

/**
 * Who the assistant is, in every conversation.
 *
 * This replaced a dropdown, a bare textarea and four identical ghost buttons.
 * None of the *actions* were wrong — built-ins, duplicate-to-edit, rename,
 * preview all worked — but the screen where you give the assistant a voice
 * read like a bug-report form, and a personality was invisible everywhere
 * except here.
 *
 * The card is the record: the name and the picture are edited on it directly,
 * which is what retires the old stranded "name this" field and Rename button.
 * See `docs/ANODEX_PERSONALITY_SPEC.md`.
 */

/** Roughly what a character costs the model. Anodex has no cloud tokenizer. */
const CHARS_PER_TOKEN = 4

/** Past this, the prompt cost is worth pointing at on a small local window. */
const TOKEN_WARN_THRESHOLD = 400

const SEEDS = [
  {
    label: 'Answers first',
    text: 'Be direct. Lead with the answer, then the reasoning. Skip preamble.'
  },
  {
    label: 'Weighs tradeoffs',
    text: 'Explain the tradeoffs before choosing, and say which you would pick.'
  },
  {
    label: 'Pushes back',
    text: 'Challenge the premise when it is shaky. Say plainly when something will not work.'
  }
]

export function PersonalitySection({
  value,
  update
}: {
  value: AssistantStyleSettings
  update: (patch: Partial<AssistantStyleSettings>) => void
}): JSX.Element {
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  /**
   * The personality being edited, held here and nowhere else until Save.
   *
   * Edits used to write straight to settings on every keystroke, which made
   * "Unsaved" a lie: a half-finished personality was already stored, already
   * selected, and already changing how the assistant talked. Save is now the
   * only thing that commits, and `isNew` says whether committing means
   * appending or replacing.
   */
  const [draft, setDraft] = useState<{ personality: ChatPersonality; isNew: boolean } | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [imageError, setImageError] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const saved = value.personalities ?? []
  const activeId = value.activePersonalityId ?? BUILT_IN_CHAT_PERSONALITIES[0].id
  const stored = findChatPersonality(saved, activeId) ?? BUILT_IN_CHAT_PERSONALITIES[0]
  // The card shows the draft while one is open, so typing is visible without
  // any of it being live yet.
  const active = draft?.personality ?? stored
  const dirty = draft !== null
  // A draft is always the user's own, whatever it was copied from.
  const readOnly = !draft && isBuiltInPersonalityId(active.id)
  const atLimit = saved.length >= MAX_SAVED_PERSONALITIES
  const named = Boolean(active.name.trim())

  const builtIns = BUILT_IN_CHAT_PERSONALITIES.filter(
    (item) => !saved.some((own) => own.id === item.id)
  )

  useEffect(() => {
    if (!justSaved) return undefined
    const timer = setTimeout(() => setJustSaved(false), 2200)
    return () => clearTimeout(timer)
  }, [justSaved])

  /** Edit the open draft, opening one from the stored personality if needed. */
  function patchActive(patch: Partial<ChatPersonality>): void {
    if (readOnly) return
    setDraft((current) =>
      current
        ? { ...current, personality: { ...current.personality, ...patch } }
        : { personality: { ...stored, ...patch }, isNew: false }
    )
  }

  /**
   * Switching which personality is active is a selection, not an edit, so it
   * commits immediately. Any open draft is dropped — nothing was promised.
   */
  function select(id: string): void {
    dropDraft()
    setShowPreview(false)
    setImageError('')
    update({ activePersonalityId: id })
  }

  /** Forget the draft, cleaning up a picture it imported but never saved. */
  function dropDraft(): void {
    const image = draft?.personality.image
    if (image && image !== stored.image) void anodex.settings.forgetPersonalityImage(image)
    setDraft(null)
  }

  /**
   * Start one from nothing. It exists only as a draft: nothing is stored and
   * nothing is selected until Save, so closing Settings mid-edit leaves no
   * half-made personality behind and does not change how the assistant talks.
   */
  function create(): void {
    if (atLimit) return
    setDraft({
      personality: {
        id: crypto.randomUUID(),
        name: '',
        role: '',
        story: '',
        style: '',
        tint: PERSONALITY_TINTS[saved.length % PERSONALITY_TINTS.length]
      },
      isNew: true
    })
    setImageError('')
    requestAnimationFrame(() => nameRef.current?.focus())
  }

  function duplicate(): void {
    if (atLimit) return
    setDraft({
      personality: { ...active, id: crypto.randomUUID(), name: `${active.name} (mine)` },
      isNew: true
    })
    requestAnimationFrame(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    })
  }

  /**
   * Delete removes a stored personality. On an unsaved draft there is nothing
   * to delete, so it simply throws the draft away.
   */
  function remove(): void {
    if (readOnly) return
    if (draft?.isNew) {
      dropDraft()
      return
    }
    if (stored.image) void anodex.settings.forgetPersonalityImage(stored.image)
    setDraft(null)
    update({
      personalities: saved.filter((item) => item.id !== stored.id),
      activePersonalityId: BUILT_IN_CHAT_PERSONALITIES[0].id
    })
  }

  function discard(): void {
    dropDraft()
    setImageError('')
  }

  async function pickImage(): Promise<void> {
    if (readOnly) return
    setImageError('')
    try {
      const path = await anodex.settings.pickPersonalityImage()
      if (path) patchActive({ image: path })
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Could not import that picture.')
    }
  }

  /**
   * Commit the draft. A new personality is appended and becomes the active one
   * here and only here — that is what "not selected until saved" means.
   *
   * The save moment: one shot, ~820ms, borrowed from the app's own first light
   * rather than inventing a second motion vocabulary. It fires only here —
   * bringing a character to life is a rare, deliberate act — and never loops.
   * The confirmation does not live in the motion; the Saved badge carries it,
   * so reduced motion loses nothing.
   */
  function save(): void {
    if (!draft || !named) return
    const { personality, isNew } = draft
    update(
      isNew
        ? { personalities: [...saved, personality], activePersonalityId: personality.id }
        : {
            personalities: saved.map((item) => (item.id === personality.id ? personality : item))
          }
    )
    setDraft(null)
    setJustSaved(true)
    setCelebrating(true)
    setTimeout(() => setCelebrating(false), 900)
  }

  const promptTokens = Math.round(
    ((active.story?.length ?? 0) + active.style.length) / CHARS_PER_TOKEN
  )
  const showEmptyVoice = !readOnly && !active.style.trim()
  const hasContent = Boolean(active.style.trim() || active.story?.trim())

  return (
    <section className={pageStyles.section}>
      <h2 className={pageStyles.sectionTitle}>Assistant personalities</h2>
      <p className={pageStyles.sectionDesc}>
        Who the assistant is, in every conversation. This sits ahead of project instructions and
        applies before anything else.
      </p>

      <div className={`${styles.contact} ${celebrating ? styles.celebrate : ''}`} ref={cardRef}>
        {celebrating && (
          <>
            <span className={styles.wake} aria-hidden="true" />
            <span className={styles.flare} aria-hidden="true">
              ✦
            </span>
          </>
        )}

        <div className={styles.portrait}>
          <button
            type="button"
            className={styles.portraitButton}
            disabled={readOnly}
            onClick={() => void pickImage()}
            aria-label={readOnly ? 'Built in' : 'Change picture'}
          >
            <PersonalityAvatar personality={active} size={84} />
          </button>
          <span className={styles.portraitHint}>{readOnly ? 'Built in' : 'Click to change'}</span>
        </div>

        <div className={styles.identity}>
          <div className={styles.identityTop}>
            <div className={styles.identityNames}>
              <input
                ref={nameRef}
                className={styles.identityName}
                value={active.name}
                readOnly={readOnly}
                maxLength={MAX_PERSONALITY_NAME_CHARS}
                placeholder="Name this personality"
                aria-label="Personality name"
                onChange={(event) =>
                  patchActive({ name: normalizePersonalityName(event.target.value) })
                }
              />
              <input
                className={styles.identityRole}
                value={active.role ?? ''}
                readOnly={readOnly}
                maxLength={MAX_PERSONALITY_ROLE_CHARS}
                placeholder="What they are for, in one line"
                aria-label="Role"
                onChange={(event) => patchActive({ role: event.target.value })}
              />
            </div>

            <PersonalityPicker
              builtIns={builtIns}
              saved={saved}
              activeId={active.id}
              atLimit={atLimit}
              onSelect={select}
              onCreate={create}
            />
          </div>

          <div className={styles.badges}>
            {readOnly && <span className={`${styles.pill} ${styles.pillReadOnly}`}>Read only</span>}
            {dirty && <span className={`${styles.pill} ${styles.pillUnsaved}`}>Unsaved</span>}
            {justSaved && <span className={`${styles.pill} ${styles.pillSaved}`}>Saved</span>}
            <span className={styles.pill}>{active.image ? 'Custom picture' : 'Monogram'}</span>
          </div>

          {imageError && <p className={styles.imageError}>{imageError}</p>}

          {/* What the choice actually buys, shown where the choice is made. */}
          <div className={styles.proof}>
            <PersonalityAvatar personality={active} size={30} />
            <div className={styles.proofBody}>
              <div className={styles.proofHead}>
                <span className={styles.proofName}>{personalityDisplayName(active)}</span>
                <span className={styles.proofSub}>{dirty ? 'in chat, once saved' : 'in chat'}</span>
              </div>
              <p className={styles.proofLine}>
                {dirty
                  ? 'Replies will arrive under this name and face after you save.'
                  : 'Replies now arrive under this name and face.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.editor}>
        <div className={styles.editorHead}>
          <span className={styles.editorLabel}>Character</span>
          <span className={styles.editorHint}>
            {readOnly
              ? 'Built in — duplicate it to make changes'
              : `Edits apply to ${personalityDisplayName(active)}`}
          </span>
          {readOnly && (
            <Button variant="secondary" size="sm" disabled={atLimit} onClick={duplicate}>
              Duplicate to edit
            </Button>
          )}
        </div>

        <div className={styles.panes}>
          <section className={styles.pane}>
            <div className={styles.paneHead}>
              <span className={styles.paneTitle}>Backstory</span>
              <span className={styles.paneSub}>Who they are</span>
              <span className={styles.paneCount}>
                {(active.story?.length ?? 0).toLocaleString()} /{' '}
                {MAX_PERSONALITY_STORY_CHARS.toLocaleString()}
              </span>
            </div>
            <textarea
              className={styles.textarea}
              value={active.story ?? ''}
              readOnly={readOnly}
              maxLength={MAX_PERSONALITY_STORY_CHARS}
              placeholder={
                readOnly
                  ? 'No backstory — this one speaks as itself.'
                  : 'A former incident reviewer who has watched confident plans fail.'
              }
              onChange={(event) => patchActive({ story: event.target.value })}
            />
          </section>

          <section className={styles.pane}>
            <div className={styles.paneHead}>
              <span className={styles.paneTitle}>Voice</span>
              <span className={styles.paneSub}>How they talk</span>
              <span className={styles.paneCount}>
                {active.style.length.toLocaleString()} /{' '}
                {MAX_ASSISTANT_STYLE_CHARS.toLocaleString()}
              </span>
            </div>
            {showEmptyVoice ? (
              <div className={styles.empty}>
                <span className={styles.emptyTitle}>Write how they should talk.</span>
                <span className={styles.emptySub}>
                  A sentence or two is enough. Start from scratch, or take one of these.
                </span>
                <div className={styles.chips}>
                  {SEEDS.map((seed) => (
                    <button
                      key={seed.label}
                      type="button"
                      className={styles.chip}
                      onClick={() => patchActive({ style: seed.text })}
                    >
                      {seed.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <textarea
                className={styles.textarea}
                value={active.style}
                readOnly={readOnly}
                maxLength={MAX_ASSISTANT_STYLE_CHARS}
                onChange={(event) => patchActive({ style: event.target.value })}
              />
            )}
          </section>
        </div>

        <div className={styles.editorFoot}>
          {/* Stated in tokens, not characters: both fields ride in the system
              prompt on every turn, and on an 8K local model there is only
              about 4,750 tokens of working room to begin with. */}
          <span
            className={`${styles.cost} ${promptTokens > TOKEN_WARN_THRESHOLD ? styles.costHigh : ''}`}
          >
            {promptTokens === 0
              ? 'Nothing added to the prompt yet'
              : `~${promptTokens.toLocaleString()} tokens in every conversation`}
          </span>
          <div className={styles.tools}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasContent}
              onClick={() => setShowPreview((current) => !current)}
            >
              {showPreview ? 'Hide preview' : 'Preview'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasContent}
              onClick={() => {
                void navigator.clipboard.writeText(composePreview(active)).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <span className={styles.toolSep} />
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnly || draft?.isNew === true}
              onClick={remove}
            >
              Delete
            </Button>
          </div>
        </div>

        {dirty && !readOnly && (
          <div className={styles.saveBar}>
            <span className={styles.saveNote}>
              {!named
                ? 'Give it a name on the card to save it'
                : draft?.isNew
                  ? `${active.name.trim()} is not saved yet`
                  : `Unsaved changes to ${active.name.trim()}`}
            </span>
            <Button variant="primary" size="sm" disabled={!named} onClick={save}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
          </div>
        )}

        {showPreview && hasContent && (
          <pre className={styles.preview}>{composePreview(active)}</pre>
        )}
      </div>

      {atLimit && (
        <p className={styles.limitNote}>
          You have {MAX_SAVED_PERSONALITIES} of your own, the maximum. Delete one to add another.
        </p>
      )}
    </section>
  )
}

/**
 * Exactly what the composer will inject, rendered through the same functions —
 * a preview that approximates the prompt is a preview that can drift from it.
 */
function composePreview(personality: ChatPersonality): string {
  return [
    renderPersonaSection(personality.name, personality.story ?? ''),
    personality.style.trim() ? renderAssistantStyleSection(personality.style.trim()) : null
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
}
