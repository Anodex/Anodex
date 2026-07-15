import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { useUiStore } from '../stores/uiStore'
import { useSidebarCollapse } from '../stores/sidebarCollapseStore'
import { WorkspaceDockButton } from '../features/workspace-dock/WorkspaceDockButton'
import { anodex } from '../lib/anodex'
import titleLogo from '../assets/title-logo.png'
import styles from './TitleBar.module.css'

/** Custom drag region with window controls and app action buttons. */
export function TitleBar(): JSX.Element {
  const openSettings = useUiStore((s) => s.openSettings)
  const autoCollapsed = useSidebarCollapse((s) => s.autoCollapsed)
  const manuallyCollapsed = useSidebarCollapse((s) => s.manuallyCollapsed)
  const sidebarCollapsed = autoCollapsed || manuallyCollapsed
  const toggleSidebar = useSidebarCollapse((s) => s.toggle)
  // On a narrow window there's no room to dock the sidebar back open, so the
  // toggle only pops it as a temporary overlay — "Show" rather than "Expand"
  // so the label doesn't promise a state that won't stick.
  const sidebarToggleLabel = !sidebarCollapsed
    ? 'Collapse sidebar'
    : autoCollapsed
      ? 'Show sidebar'
      : 'Expand sidebar'
  const [maximized, setMaximized] = useState(false)
  const [isMac, setIsMac] = useState(false)
  const [logoPulseId, setLogoPulseId] = useState(0)
  const isMacRef = useRef(false)

  useEffect(() => {
    const mac = navigator.userAgent.includes('Mac')
    setIsMac(mac)
    isMacRef.current = mac
  }, [])

  useEffect(() => {
    // The `maximize`/`unmaximize` subscription only fires on the next state
    // *change* — query the current state up front too, since the window may
    // already be maximized when this component mounts (e.g. after a reload).
    void anodex.windowControls.isMaximized().then(setMaximized)
    const unsub = anodex.windowControls.onMaximizedChanged((m) => setMaximized(m))
    return unsub
  }, [])

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        {isMac && <span className={styles.macSpacer} />}
        <button
          type="button"
          className={styles.logoButton}
          onClick={() => setLogoPulseId((id) => id + 1)}
          title="Animate Anodex logo"
          aria-label="Animate Anodex logo"
        >
          <span className={styles.logoWrap}>
            {logoPulseId > 0 && (
              <>
                <span key={`ring-${logoPulseId}`} className={styles.pulseRing} />
                <span
                  key={`spark-a-${logoPulseId}`}
                  className={`${styles.spark} ${styles.sparkA}`}
                />
                <span
                  key={`spark-b-${logoPulseId}`}
                  className={`${styles.spark} ${styles.sparkB}`}
                />
                <span
                  key={`spark-c-${logoPulseId}`}
                  className={`${styles.spark} ${styles.sparkC}`}
                />
              </>
            )}
            <img
              key={`logo-${logoPulseId}`}
              src={titleLogo}
              alt=""
              className={`${styles.logo}${logoPulseId > 0 ? ' ' + styles.pulsing : ''}`}
            />
          </span>
        </button>
        <span className={styles.title}>
          Anode<span className={styles.titleAccent}>x</span>
        </span>
      </div>
      <div className={styles.actions}>
        <IconButton
          label={sidebarToggleLabel}
          icon={<Icon name="panel-left" size={18} />}
          size="sm"
          className={sidebarCollapsed ? undefined : styles.activeToggle}
          onClick={toggleSidebar}
        />
        <WorkspaceDockButton />
        <IconButton
          label="Settings"
          icon={<Icon name="settings" size={18} />}
          size="sm"
          onClick={() => openSettings()}
        />
      </div>
      {!isMac && (
        <>
          <span className={styles.separator} />
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.control}
              onClick={() => void anodex.windowControls.minimize()}
              aria-label="Minimize"
              title="Minimize"
            >
              <Icon name="minimize" size={12} />
            </button>
            <button
              type="button"
              className={styles.control}
              onClick={() => void anodex.windowControls.maximize()}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={12} />
            </button>
            <button
              type="button"
              className={`${styles.control} ${styles.close}`}
              onClick={() => void anodex.windowControls.close()}
              aria-label="Close"
              title="Close"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </>
      )}
    </header>
  )
}
