import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction
} from 'react'
import type { SkillSummary } from '@shared/skill.types'
import { anodex } from '../../../lib/anodex'
import {
  applySkillSuggestion,
  getAppliedSkillName,
  getSkillSuggestions,
  getSlashSkillSuggestions
} from '../../../lib/skillSuggestions'
import {
  completeSlashCommand,
  getSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../../../lib/slashCommands'

type SlashPickerOption =
  { kind: 'command'; command: SlashCommandSuggestion } | { kind: 'skill'; skill: SkillSummary }

interface UseComposerSlashPickerOptions {
  projectId: string | null | undefined
  text: string
  setText: Dispatch<SetStateAction<string>>
  ready: boolean
  pinnedSkillNames: string[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  autoGrow: () => void
}

interface ComposerSlashPickerController {
  slashCommands: SlashCommandSuggestion[]
  slashSkills: SkillSummary[]
  showSlashPicker: boolean
  activeIndex: number
  visibleSkillSuggestion: SkillSummary | null
  selectCommand: (command: SlashCommandSuggestion) => void
  selectSkill: (skill: SkillSummary) => void
  dismissSlashPicker: () => void
  useSuggestedSkill: (skillName: string) => void
  dismissSkillSuggestion: (skillName: string) => void
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

/**
 * Coordinates the shared command/skill picker and the compact skill hint.
 * It keeps slash discovery local to the composer without leaking its selection
 * details into message submission or attachment handling.
 */
export function useComposerSlashPicker({
  projectId,
  text,
  setText,
  ready,
  pinnedSkillNames,
  textareaRef,
  autoGrow
}: UseComposerSlashPickerOptions): ComposerSlashPickerController {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [dismissedSkillName, setDismissedSkillName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void anodex.skills.list(projectId ?? null).then((result) => {
      if (!cancelled) setSkills(result)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    setDismissed(false)
    setDismissedSkillName(null)
  }, [text])

  const slashCommands = useMemo(() => getSlashCommandSuggestions(text), [text])
  const slashSkills = useMemo(
    () => getSlashSkillSuggestions(skills, text, { limit: 8, pinnedSkillNames }),
    [skills, text, pinnedSkillNames]
  )
  const options = useMemo<SlashPickerOption[]>(
    () => [
      ...slashCommands.map((command) => ({ kind: 'command' as const, command })),
      ...slashSkills.map((skill) => ({ kind: 'skill' as const, skill }))
    ],
    [slashCommands, slashSkills]
  )
  const showSlashPicker = ready && !dismissed && options.length > 0
  const selectedOption = options[Math.min(activeIndex, options.length - 1)]
  const skillSuggestions = useMemo(
    () =>
      ready && !showSlashPicker
        ? getSkillSuggestions(skills, text, { limit: 2, pinnedSkillNames })
        : [],
    [ready, showSlashPicker, skills, text, pinnedSkillNames]
  )
  const appliedSkillName = getAppliedSkillName(text)
  const visibleSkillSuggestion =
    skillSuggestions.find(
      (skill) => skill.name !== dismissedSkillName && skill.name !== appliedSkillName
    ) ?? null

  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoGrow()
    })
  }

  const selectCommand = (command: SlashCommandSuggestion): void => {
    setText(completeSlashCommand(text, command.name))
    setActiveIndex(0)
    focusComposer()
  }

  const selectSkill = (skill: SkillSummary): void => {
    setText(applySkillSuggestion(skill.name, ''))
    setActiveIndex(0)
    focusComposer()
  }

  const useSuggestedSkill = (skillName: string): void => {
    setText((current) => applySkillSuggestion(skillName, current))
    setDismissedSkillName(skillName)
    focusComposer()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!showSlashPicker) return false

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % options.length)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + options.length) % options.length)
      return true
    }
    if ((event.key === 'Tab' || event.key === 'Enter') && selectedOption) {
      event.preventDefault()
      if (selectedOption.kind === 'command') selectCommand(selectedOption.command)
      else selectSkill(selectedOption.skill)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setText('')
      setActiveIndex(0)
      return true
    }
    return false
  }

  return {
    slashCommands,
    slashSkills,
    showSlashPicker,
    activeIndex,
    visibleSkillSuggestion,
    selectCommand,
    selectSkill,
    dismissSlashPicker: () => setDismissed(true),
    useSuggestedSkill,
    dismissSkillSuggestion: setDismissedSkillName,
    handleKeyDown
  }
}
