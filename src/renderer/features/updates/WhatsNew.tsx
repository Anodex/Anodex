import { useCallback, useEffect, useState } from 'react'
import type { ReleaseNotes } from '@shared/update.types'
import { anodex } from '../../lib/anodex'
import { Icon } from '../../components/Icon'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { ReleaseNotesContent } from './ReleaseNotesContent'
import styles from './WhatsNew.module.css'

const SEEN_VERSION_KEY = 'anodex:whatsNewSeenVersion'

function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY)
  } catch {
    return null
  }
}

/** A new installed version offers its GitHub release notes until they are opened. */
export function WhatsNew(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [seen, setSeen] = useState(seenVersion)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    void anodex.system
      .getInfo()
      .then((info) => {
        if (active) setVersion(info.appVersion)
      })
      .catch(() => {
        // No version means there is no release to offer in this session.
      })
    return () => {
      active = false
    }
  }, [])

  const markSeen = useCallback((): void => {
    if (!version) return
    try {
      localStorage.setItem(SEEN_VERSION_KEY, version)
    } catch {
      /* The button can still dismiss for this session. */
    }
    setSeen(version)
  }, [version])

  if (!version || (seen === version && !open)) return null

  return (
    <>
      {seen !== version && (
        <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
          <span className={styles.dot} />
          What&apos;s new
        </button>
      )}
      {open && (
        <WhatsNewDialog version={version} onClose={() => setOpen(false)} onShown={markSeen} />
      )}
    </>
  )
}

function WhatsNewDialog({
  version,
  onClose,
  onShown
}: {
  version: string
  onClose: () => void
  onShown: () => void
}): JSX.Element {
  const [notes, setNotes] = useState<ReleaseNotes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    void anodex.updates
      .getReleaseNotes()
      .then((result) => {
        if (!active) return
        setLoading(false)
        if (result.ok) {
          setNotes(result.value)
          onShown()
        } else {
          setError(result.error.message)
        }
      })
      .catch(() => {
        if (!active) return
        setLoading(false)
        setError('Could not load release notes from GitHub.')
      })
    return () => {
      active = false
    }
  }, [retry, onShown])

  return (
    <Overlay onClose={onClose} ariaLabel="What's new" cardClassName={styles.dialog}>
      <div className={styles.header}>
        <div>
          <h2>What&apos;s new</h2>
          <span className={styles.version}>Anodex {version}</span>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close What's new"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className={styles.body}>
        {loading && <p className={styles.message}>Loading release notes from GitHub…</p>}
        {error && (
          <div className={styles.failure}>
            <p>{error}</p>
            <Button
              size="sm"
              onClick={() => {
                setError(null)
                setLoading(true)
                setRetry((value) => value + 1)
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {notes && (
          <>
            <div className={styles.releaseHeader}>
              <strong>{notes.title}</strong>
              {notes.publishedAt && (
                <time dateTime={notes.publishedAt}>
                  {new Date(notes.publishedAt).toLocaleDateString()}
                </time>
              )}
            </div>
            <ReleaseNotesContent body={notes.body} />
            <a
              className={styles.githubLink}
              href={notes.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View release on GitHub <Icon name="external-link" size={14} />
            </a>
          </>
        )}
      </div>
    </Overlay>
  )
}
