import { useEffect, useState } from 'react'
import type { HardwareInfo, SystemInfo } from '@shared/system.types'
import type { UpdateStatus } from '@shared/update.types'
import { anodex } from '../../../../lib/anodex'
import { AnodexLogo } from '../../../../components/AnodexLogo'
import { Icon, type IconName } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { updateStatusText } from './updateStatusText'
import pageStyles from '../../SettingsPage.module.css'
import styles from './AboutSettings.module.css'

export function AboutSettings(): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [pathCopied, setPathCopied] = useState(false)

  useEffect(() => {
    void anodex.system.getInfo().then(setInfo)
    void anodex.system.getHardwareInfo().then(setHardware)
  }, [])

  useEffect(() => {
    void anodex.updates.getStatus().then(setUpdateStatus)
    return anodex.updates.onStatusChanged(setUpdateStatus)
  }, [])

  const copyDataPath = (): void => {
    if (!info) return
    void navigator.clipboard.writeText(info.userDataPath).then(() => {
      setPathCopied(true)
      window.setTimeout(() => setPathCopied(false), 1400)
    })
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>System</p>
        <h1 className={pageStyles.pageTitle}>About</h1>
        <p className={pageStyles.pageDesc}>Anodex version, updates, and system information.</p>
      </header>

      <section className={styles.hero} aria-label="Anodex product information">
        <div className={styles.logoStage}>
          <span className={styles.logoGlow} />
          <AnodexLogo className={styles.logo} size={68} variant="icon" />
        </div>

        <h2 className={styles.productName}>Anodex</h2>
        <p className={styles.tagline}>Your private, local-first AI workspace.</p>

        <div className={styles.versionLine}>
          <span className={styles.versionPill}>Version {info?.appVersion ?? '—'}</span>
          <span className={styles.buildPill}>Desktop build</span>
        </div>

        <p className={styles.blurb}>
          Run open models, work with project files, and keep conversations on your own computer.
        </p>

        <div className={styles.localPromise}>
          <span className={styles.promiseIcon}>
            <Icon name="check" size={12} />
          </span>
          <span>
            <strong>Private by default</strong> Models, chats, projects, and settings stay local
            unless you choose a connected service.
          </span>
        </div>
      </section>

      <div className={styles.cardGrid}>
        <section className={`${styles.card} ${styles.updateCard}`}>
          <CardHeading
            icon="refresh"
            tone="success"
            title="Software updates"
            description="You control every download and restart."
          />

          <UpdateStatusCard status={updateStatus} appVersion={info?.appVersion} />
          <UpdateAction status={updateStatus} />
        </section>

        <section className={styles.card}>
          <CardHeading
            icon="cpu"
            tone="accent"
            title="This computer"
            description="Detected for local model recommendations."
          />

          <dl className={styles.computerFacts}>
            <Spec label="Operating system" value={operatingSystemLabel(hardware, info)} />
            <Spec label="Memory" value={hardware?.ram ?? 'Detecting…'} />
            <Spec label="Processor" value={hardware?.cpu ?? 'Detecting…'} />
            <Spec label="Graphics" value={graphicsLabel(hardware)} />
          </dl>
        </section>
      </div>

      <details className={styles.technicalDetails}>
        <summary>
          <span>
            <strong>Technical details</strong>
            <small>Runtime versions and local data location</small>
          </span>
          <Icon className={styles.detailChevron} name="chevron-down" size={14} />
        </summary>

        <div className={styles.technicalBody}>
          <dl className={styles.runtimeGrid}>
            <Spec label="Electron" value={info?.electronVersion ?? '—'} mono />
            <Spec label="Chromium" value={info?.chromeVersion ?? '—'} mono />
            <Spec label="Node.js" value={info?.nodeVersion ?? '—'} mono />
            <Spec label="Platform" value={info ? `${info.platform} · ${info.arch}` : '—'} mono />
          </dl>

          <div className={styles.dataLocation}>
            <span className={styles.dataIcon}>
              <Icon name="folder" size={14} />
            </span>
            <div>
              <span>Local data folder</span>
              <code title={info?.userDataPath}>{info?.userDataPath ?? 'Loading…'}</code>
            </div>
            <button
              className={`${styles.copyPath} ${pathCopied ? styles.copyPathCopied : ''}`}
              type="button"
              disabled={!info}
              aria-label={pathCopied ? 'Path copied' : 'Copy local data folder path'}
              title={pathCopied ? 'Copied' : 'Copy path'}
              onClick={copyDataPath}
            >
              <Icon name={pathCopied ? 'check' : 'copy'} size={14} />
            </button>
          </div>
        </div>
      </details>

      <footer className={styles.footer}>
        <div className={styles.creditsCopy}>
          <Icon name="sparkle" size={13} />
          <span>Built with Electron, React, node-llama-cpp, and llama.cpp.</span>
        </div>
        <div className={styles.creditLinks}>
          <CreditLink href="https://github.com/withcatai/node-llama-cpp">node-llama-cpp</CreditLink>
          <CreditLink href="https://github.com/ggml-org/llama.cpp">llama.cpp</CreditLink>
        </div>
      </footer>
    </div>
  )
}

function CardHeading({
  icon,
  tone,
  title,
  description
}: {
  icon: IconName
  tone: 'success' | 'accent'
  title: string
  description: string
}): JSX.Element {
  return (
    <div className={styles.cardHeading}>
      <span className={`${styles.cardIcon} ${styles[tone]}`}>
        <Icon name={icon} size={16} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  )
}

function Spec({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined} title={value}>
        {value}
      </dd>
    </div>
  )
}

function UpdateStatusCard({
  status,
  appVersion
}: {
  status: UpdateStatus
  appVersion?: string
}): JSX.Element {
  const presentation = updatePresentation(status)
  const detail =
    status.state === 'not-available' && appVersion
      ? `Anodex ${appVersion} · ${updateStatusText(status)}`
      : updateStatusText(status)

  return (
    <div className={`${styles.updateStatus} ${styles[presentation.tone]}`} role="status">
      <span className={styles.statusIcon}>
        <Icon name={presentation.icon} size={12} />
      </span>
      <div>
        <strong>{presentation.title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  )
}

function UpdateAction({ status }: { status: UpdateStatus }): JSX.Element {
  if (status.state === 'downloaded') {
    return (
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="refresh" size={13} />}
        onClick={() => void anodex.updates.installAndRestart()}
      >
        Restart & install
      </Button>
    )
  }

  if (status.state === 'available') {
    return (
      <Button
        variant="primary"
        size="sm"
        iconLeft={<Icon name="download" size={13} />}
        onClick={() => void anodex.updates.download()}
      >
        Download update
      </Button>
    )
  }

  if (status.state === 'checking' || status.state === 'downloading') {
    return (
      <Button variant="secondary" size="sm" loading>
        {status.state === 'checking' ? 'Checking…' : `Downloading ${status.percent}%`}
      </Button>
    )
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      iconLeft={<Icon name="refresh" size={13} />}
      onClick={() => void anodex.updates.check()}
    >
      Check for updates
    </Button>
  )
}

function updatePresentation(status: UpdateStatus): {
  title: string
  icon: IconName
  tone: 'neutral' | 'success' | 'warning' | 'danger'
} {
  switch (status.state) {
    case 'idle':
      return { title: 'Ready to check', icon: 'refresh', tone: 'neutral' }
    case 'checking':
      return { title: 'Checking for updates', icon: 'refresh', tone: 'neutral' }
    case 'available':
      return { title: 'Update available', icon: 'download', tone: 'warning' }
    case 'not-available':
      return { title: "You're up to date", icon: 'check', tone: 'success' }
    case 'downloading':
      return { title: 'Downloading update', icon: 'download', tone: 'neutral' }
    case 'downloaded':
      return { title: 'Ready to install', icon: 'check', tone: 'success' }
    case 'error':
      return { title: 'Update check failed', icon: 'alert', tone: 'danger' }
  }
}

function graphicsLabel(hardware: HardwareInfo | null): string {
  if (!hardware) return 'Detecting…'
  if (!hardware.gpu) return 'Not detected'
  if (hardware.vram) return `${hardware.gpu} · ${hardware.vram}`
  return hardware.gpu
}

function operatingSystemLabel(hardware: HardwareInfo | null, info: SystemInfo | null): string {
  if (!hardware) return 'Detecting…'
  return info?.arch ? `${hardware.os} · ${info.arch}` : hardware.os
}

function CreditLink({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      <Icon name="web" size={12} />
      {children}
    </a>
  )
}
