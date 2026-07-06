import { useEffect, useState } from 'react'
import type { SystemInfo } from '@shared/system.types'
import { anodex } from '../../../../lib/anodex'
import { AnodexLogo } from '../../../../components/AnodexLogo'
import { Icon } from '../../../../components/Icon'
import styles from './AboutSettings.module.css'

export function AboutSettings(): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    void anodex.system.getInfo().then(setInfo)
  }, [])

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <div className={styles.brand}>
          <AnodexLogo size={48} />
          <div>
            <div className={styles.name}>Anodex</div>
            <div className={styles.tagline}>Local-first AI assistant</div>
          </div>
        </div>

        <p className={styles.blurb}>
          Anodex runs large language models locally on your machine. Your conversations, files, and
          model data stay private and never leave your device unless you explicitly enable a cloud
          tool.
        </p>

        {info && (
          <dl className={styles.specs}>
            <Spec label="Version" value={`v${info.appVersion}`} />
            <Spec label="Electron" value={info.electronVersion} />
            <Spec label="Node.js" value={info.nodeVersion} />
            <Spec label="Chromium" value={info.chromeVersion} />
            <Spec label="Platform" value={`${info.platform} · ${info.arch}`} />
            <Spec label="Data folder" value={info.userDataPath} mono />
          </dl>
        )}

        <div className={styles.links}>
          <a
            className={styles.link}
            href="https://github.com/withcatai/node-llama-cpp"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="web" size={14} />
            node-llama-cpp
          </a>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Credits</h2>
        <p className={styles.sectionDesc}>
          Built with Electron, React, node-llama-cpp, and llama.cpp. Thank you to the open-source
          communities that make local AI possible.
        </p>
      </section>
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
    <div className={styles.spec}>
      <dt className={styles.specLabel}>{label}</dt>
      <dd className={`${styles.specValue} ${mono ? styles.mono : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}
