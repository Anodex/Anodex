import type { SkillSummary } from '@shared/skill.types'
import { Icon } from '../../../components/Icon'
import styles from '../ChatComposer.module.css'

interface ComposerSkillHintProps {
  skill: SkillSummary
  onUse: (skillName: string) => void
  onDismiss: (skillName: string) => void
}

/** A lightweight, optional shortcut for a skill relevant to the current draft. */
export function ComposerSkillHint({
  skill,
  onUse,
  onDismiss
}: ComposerSkillHintProps): JSX.Element {
  return (
    <div className={styles.skillHint}>
      <Icon name="sparkle" size={13} />
      <span className={styles.skillHintText}>
        Relevant {skill.scope} skill: <strong>{skill.name}</strong>
      </span>
      <button
        type="button"
        className={styles.skillHintAction}
        onMouseDown={(event) => {
          event.preventDefault()
          onUse(skill.name)
        }}
      >
        Use
      </button>
      <button
        type="button"
        className={styles.skillHintDismiss}
        aria-label="Dismiss skill suggestion"
        title="Dismiss"
        onMouseDown={(event) => {
          event.preventDefault()
          onDismiss(skill.name)
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}
