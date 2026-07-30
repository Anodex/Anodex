import type { WebSource } from '@shared/webSources.types'
import { Icon } from '../../components/Icon'
import styles from './MessageSources.module.css'

/**
 * What an answer stood on, shown under the reply.
 *
 * Two states, and the second is the reason this exists. When web tools
 * retrieved something, the pages are listed so any claim can be checked. When
 * web tools ran and retrieved *nothing*, the answer necessarily came from the
 * model's training data — and a confident, well-formatted reply gives the
 * reader no way to tell. That case gets said out loud rather than left as an
 * absence the reader has to notice.
 */
export function MessageSources({
  sources,
  attempted,
  streaming
}: {
  sources: WebSource[] | undefined
  attempted: boolean
  /** While tokens are still arriving nothing is final, so nothing is claimed yet. */
  streaming: boolean
}): JSX.Element | null {
  if (streaming) return null

  const list = sources ?? []
  if (list.length === 0) {
    if (!attempted) return null
    return (
      <div className={styles.unsourced} role="note">
        <Icon name="alert" size={15} className={styles.unsourcedIcon} />
        <p className={styles.unsourcedText}>
          <strong>No sources were retrieved.</strong> The web tools ran but came back with nothing,
          so anything above comes from the model&apos;s training data rather than a page fetched
          just now. Treat specific events, dates, and figures as unverified.
        </p>
      </div>
    )
  }

  const verifiedCount = list.filter((source) => source.verified).length

  return (
    <div className={styles.sources}>
      <span className={styles.label}>
        {verifiedCount === list.length
          ? `${list.length} ${list.length === 1 ? 'source' : 'sources'}`
          : `${verifiedCount} of ${list.length} fetched`}
      </span>
      <ul className={styles.list}>
        {list.map((source, index) => (
          <li key={source.id}>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className={`${styles.source} ${source.verified ? '' : styles.lead}`}
              title={
                source.verified
                  ? source.title
                  : `${source.title} (search result — page not fetched)`
              }
            >
              <span className={styles.number}>{index + 1}</span>
              <span className={styles.host}>{hostOf(source.url)}</span>
              {!source.verified && <span className={styles.leadMark}>lead</span>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
