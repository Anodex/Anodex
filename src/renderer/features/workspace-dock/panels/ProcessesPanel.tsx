import { useEffect, useState } from 'react'
import type { BackgroundProcessInfo } from '@shared/process.types'
import { Icon } from '../../../components/Icon'
import { StatusDot, type StatusTone } from '../../../components/ui/StatusDot'
import { anodex } from '../../../lib/anodex'
import { formatElapsedClock } from '../../../lib/format'
import { useBackgroundProcesses } from '../useBackgroundProcesses'
import { useWorkspaceDockProjectId } from '../useWorkspaceDockAvailability'
import { DockEmpty, WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './ProcessesPanel.module.css'

/** How often an open log refreshes while its process runs. */
const OUTPUT_REFRESH_MS = 1_500

/**
 * What Anodex left running for this project: a dev server it started, a
 * watcher. Each says where it is serving, can show what it has printed, and
 * can be stopped, so nothing it starts is out of reach or out of sight.
 */
export function ProcessesPanel(): JSX.Element {
  const projectId = useWorkspaceDockProjectId()
  const processes = useBackgroundProcesses(projectId)

  if (processes.length === 0) {
    return (
      <WorkspaceDockPanel title="Processes">
        <DockEmpty icon="zap" title="Nothing running">
          When Anodex starts a dev server or a watcher for this project, it shows here with its
          address, its output, and a Stop button. Everything here stops when Anodex quits.
        </DockEmpty>
      </WorkspaceDockPanel>
    )
  }

  return (
    <WorkspaceDockPanel title="Processes">
      <ul className={styles.list}>
        {processes.map((info) => (
          <ProcessRow key={info.id} info={info} />
        ))}
      </ul>
    </WorkspaceDockPanel>
  )
}

const TONE: Record<BackgroundProcessInfo['status'], StatusTone> = {
  running: 'running',
  exited: 'neutral',
  stopped: 'neutral',
  failed: 'danger'
}

function ProcessRow({ info }: { info: BackgroundProcessInfo }): JSX.Element {
  const [open, setOpen] = useState(info.status === 'failed' || (info.exitCode ?? 0) !== 0)
  const [stopping, setStopping] = useState(false)
  const running = info.status === 'running'

  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <StatusDot tone={TONE[info.status]} />
        <span className={styles.text}>
          <span className={styles.name}>{info.name}</span>
          <span className={styles.command} title={info.command}>
            {info.command}
          </span>
        </span>
        <span className={styles.state}>{stateLabel(info)}</span>
        {running && (
          <button
            type="button"
            className={styles.stop}
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void anodex.processes.stop(info.id).finally(() => setStopping(false))
            }}
            aria-label={`Stop ${info.name}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      <div className={styles.actions}>
        {info.url && running && (
          <a className={styles.link} href={info.url} target="_blank" rel="noreferrer">
            <Icon name="external-link" size={12} />
            {info.url}
          </a>
        )}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          Output
        </button>
      </div>
      {open && <ProcessOutput id={info.id} live={running} />}
    </li>
  )
}

function ProcessOutput({ id, live }: { id: string; live: boolean }): JSX.Element {
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true
    const read = (): void => {
      void anodex.processes.output(id).then((value) => {
        if (alive) setText(value)
      })
    }
    read()
    if (!live) return () => void (alive = false)
    const timer = setInterval(read, OUTPUT_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, live])

  return <pre className={styles.output}>{text.trim() || 'No output yet.'}</pre>
}

function stateLabel(info: BackgroundProcessInfo): string {
  if (info.status === 'running') return formatElapsedClock(Date.now() - info.startedAt)
  if (info.status === 'exited') return `exited ${info.exitCode}`
  return info.status
}
