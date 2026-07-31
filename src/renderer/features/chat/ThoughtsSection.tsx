import { useState } from 'react'
import styles from './ThoughtsSection.module.css'

/**
 * A reasoning-tuned local model's chain-of-thought text (`ChatMessage.
 * thinking`), shown separately from its visible reply. Deliberately minimal
 * — no card, no chrome, just a rule and a single truncated preview line,
 * like a note in the margin (picked over four other treatments compared side
 * by side). It's meant to never compete with the real answer for attention;
 * the full text only shows once the user deliberately expands it.
 *
 * Renders as plain text (not markdown) — this is a raw reasoning scratchpad,
 * not a polished answer, and treating it as markdown risks misrendering
 * stray `#`/`*` characters the model never meant as formatting.
 */
export function ThoughtsSection({
  thinking,
  streaming
}: {
  thinking: string
  /** True while more thinking tokens may still be arriving for this turn. */
  streaming?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={styles.row}>
      <span className={`${styles.rule} ${streaming ? styles.streaming : ''}`} aria-hidden="true" />
      <div className={styles.content}>
        {expanded ? (
          <>
            <p className={styles.full}>{thinking}</p>
            {/* A separate control from the text itself, not the paragraph's
                own click handler — the expanded text is real prose someone
                may want to read closely or select/copy, and an accidental
                click while doing that shouldn't collapse it out from under
                them. */}
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setExpanded(false)}
              aria-expanded={true}
              aria-label="Collapse the model's reasoning"
            >
              Collapse
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.preview}
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-label="Show the model's reasoning"
          >
            {thinking}
          </button>
        )}
      </div>
    </div>
  )
}
