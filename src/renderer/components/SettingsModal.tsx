import { useUiStore } from '../stores/uiStore'
import { SettingsView } from '../features/settings/SettingsView'
import { Overlay } from './ui/Overlay'
import { Icon } from './Icon'
import styles from './SettingsModal.module.css'

/**
 * Settings as a proper app-level overlay — sits above the whole layout
 * (sidebar, chat, workspace dock) with its own backdrop, instead of swapping
 * into the same content slot as the chat view. `SettingsView` itself is
 * unchanged; this just supplies the modal-specific sizing and close button
 * around the shared `Overlay` chrome (backdrop, card, Escape-to-close).
 */
export function SettingsModal(): JSX.Element {
  const setView = useUiStore((s) => s.setView)
  const close = (): void => setView('chat')

  return (
    <Overlay
      onClose={close}
      ariaLabel="Settings"
      cardClassName={styles.card}
      overlayClassName={styles.overlay}
    >
      <button className={styles.close} onClick={close} aria-label="Close settings" title="Close">
        <Icon name="close" size={16} />
      </button>
      <SettingsView />
    </Overlay>
  )
}
