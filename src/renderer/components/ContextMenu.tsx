import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContextMenuItem, ContextMenuRequest } from '@shared/ipc'
import { anodex } from '../lib/anodex'
import styles from './ContextMenu.module.css'

const VIEWPORT_MARGIN = 8

interface MenuPosition {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function ContextMenu(): JSX.Element | null {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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

  useLayoutEffect(() => {
    if (!request) {
      setPosition(null)
      return
    }

    const rect = menuRef.current?.getBoundingClientRect()
    if (!rect) {
      setPosition({ x: request.x, y: request.y })
      return
    }

    setPosition({
      x: clamp(request.x, VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN),
      y: clamp(request.y, VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    })
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
      style={{
        left: position?.x ?? request.x,
        top: position?.y ?? request.y,
        visibility: position ? 'visible' : 'hidden'
      }}
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
