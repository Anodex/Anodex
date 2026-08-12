import { useEffect, useRef } from 'react'
import type { SkillSummary } from '@shared/skill.types'
import { Icon } from '../../../components/Icon'
import type { SlashCommandSuggestion } from '../../../lib/slashCommands'
import styles from '../ChatComposer.module.css'

interface ComposerSlashPickerProps {
  commands: SlashCommandSuggestion[]
  skills: SkillSummary[]
  activeIndex: number
  onSelectCommand: (command: SlashCommandSuggestion) => void
  onSelectSkill: (skill: SkillSummary) => void
  onDismiss: () => void
}

/** Full-width command and skill picker shown while the draft starts with `/`. */
export function ComposerSlashPicker({
  commands,
  skills,
  activeIndex,
  onSelectCommand,
  onSelectSkill,
  onDismiss
}: ComposerSlashPickerProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function dismissOnOutsideClick(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', dismissOnOutsideClick)
    return () => document.removeEventListener('mousedown', dismissOnOutsideClick)
  }, [onDismiss])

  return (
    <div
      ref={menuRef}
      className={styles.commandMenu}
      role="listbox"
      aria-label="Commands and skills"
    >
      {commands.length > 0 && <div className={styles.commandMenuHeader}>Commands</div>}
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          className={`${styles.commandItem} ${index === activeIndex ? styles.commandItemActive : ''}`}
          onMouseDown={(event) => {
            event.preventDefault()
            onSelectCommand(command)
          }}
          role="option"
          aria-selected={index === activeIndex}
        >
          <Icon name={command.icon} className={styles.commandIcon} size={16} />
          <span className={styles.commandName}>/{command.name}</span>
          <span className={styles.commandDescription}>{command.description}</span>
        </button>
      ))}
      {skills.length > 0 && <div className={styles.commandMenuHeader}>Skills</div>}
      {skills.map((skill, index) => {
        const optionIndex = commands.length + index
        return (
          <button
            key={`${skill.scope}:${skill.name}`}
            type="button"
            className={`${styles.commandItem} ${optionIndex === activeIndex ? styles.commandItemActive : ''}`}
            onMouseDown={(event) => {
              event.preventDefault()
              onSelectSkill(skill)
            }}
            role="option"
            aria-selected={optionIndex === activeIndex}
          >
            <Icon name="skill" className={styles.commandIcon} size={16} />
            <span className={styles.commandName}>{skill.name}</span>
            <span className={styles.commandDescription}>
              {skill.description || `${skill.scope} skill`}
            </span>
          </button>
        )
      })}
    </div>
  )
}
