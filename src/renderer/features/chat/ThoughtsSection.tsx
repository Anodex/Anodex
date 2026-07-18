import { useState } from 'react'
import { Icon } from '../../components/Icon'
import styles from './ThoughtsSection.module.css'

/**
 * Collapsed by default — a reasoning-tuned local model's chain-of-thought
 * text (`ChatMessage.thinking`), shown separately from its visible reply.
 * Mirrors `ToolCallGroup`'s collapsed/expand visual pattern for consistency,
 * but renders as plain text (not markdown) — this is a raw reasoning
 * scratchpad, not a polished answer, and treating it as markdown risks
 * misrendering stray `#`/`*` characters the model never meant as formatting.
 */
export function ThoughtsSection({ thinking }: { thinking: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <section className={`${styles.group} ${expanded ? styles.expanded : styles.collapsed}`}>
      <button
        type="button"
        className={styles.labelButton}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Show'} the model's reasoning`}
      >
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
          className={styles.labelChevron}
        />
        <span className={styles.label}>Thoughts</span>
      </button>
      {expanded && <div className={styles.body}>{thinking}</div>}
    </section>
  )
}
