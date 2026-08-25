import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { shortenId } from './shortenId'
import styles from './CopyableId.module.css'

/**
 * The identifier of one run, chat, task or project, shown where a reader can
 * see it and copy it.
 *
 * Anodex already gives every surface a distinctly prefixed id -- `c_` a chat,
 * `p_` a project, `run_` an agent run, `critical_` a critical-thinking run,
 * `task_` a scheduled task -- so one glance says what kind of thing you are
 * looking at. None of it was ever shown, which meant the person best placed to
 * use it, someone diagnosing a run that went wrong, had to go and read a JSON
 * file to find it.
 *
 * Always visible rather than revealed on hover. The whole point is telling at a
 * glance which surface a record came from, and a hover affordance has to be
 * discovered before it can do that -- it is also unreachable by touch.
 *
 * The chip shows a short form and copies the whole id, because the prefix and
 * the timestamp segment are what identify it in conversation while the random
 * suffix only matters to whatever is looking it up.
 */
export function CopyableId({ id, label }: { id: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
    } catch {
      // A denied clipboard is not worth an error state; the id is still on screen.
    }
  }

  return (
    <button
      type="button"
      className={styles.chip}
      onClick={() => void copy()}
      title={`${label ? `${label}: ` : ''}${id} — click to copy`}
      aria-label={`Copy ${label ?? 'id'} ${id}`}
    >
      <span className={styles.text}>{shortenId(id)}</span>
      <Icon name={copied ? 'check' : 'copy'} size={11} />
    </button>
  )
}
