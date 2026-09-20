import { useEffect, useRef, useState } from 'react'
import type { ContextMenuItem, ContextMenuRequest } from '@shared/ipc'
import { anodex } from '../lib/anodex'
import { useAnchoredPosition } from '../hooks/useAnchoredPosition'
import styles from './ContextMenu.module.css'

export function ContextMenu(): JSX.Element | null {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuStyle = useAnchoredPosition(request ? { x: request.x, y: request.y } : null, menuRef)

  useEffect(() => anodex.contextMenu.onShow((next) => setRequest(next)), [])

  useEffect(() => {
    if (!request) return

    const close = (): void => setRequest(null)
    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }

    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [request])

  if (!request) return null

  const runItem = (item: ContextMenuItem): void => {
    if (!item.enabled || item.type === 'separator') return
    setRequest(null)
    void anodex.contextMenu.runAction(item.id)
  }

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={menuStyle}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {request.items.map((item) =>
        item.type === 'separator' ? (
          <div key={item.id} className={styles.separator} role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            className={styles.item}
            disabled={!item.enabled}
            role="menuitem"
            onClick={() => runItem(item)}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
