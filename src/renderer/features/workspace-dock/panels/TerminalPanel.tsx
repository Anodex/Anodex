import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { anodex } from '../../../lib/anodex'
import { useSettingsStore } from '../../../stores/settingsStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './TerminalPanel.module.css'
import '@xterm/xterm/css/xterm.css'

/**
 * Reads the current theme's real color values from `theme.css` (light or
 * dark, whichever is active) so xterm — which needs literal color strings,
 * not `var(--x)` references — always matches the rest of the app instead of
 * carrying its own separate, hardcoded palette. Reuses existing role tokens
 * for the ANSI colors (danger/success/warn/accent) rather than inventing new
 * saturated hues, consistent with Anodex's muted, no-rainbow accent system.
 */
function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()

  const text = token('--text')
  const accent = token('--accent')
  const cyan = token('--code-inline-text')

  return {
    background: token('--bg-base'),
    foreground: text,
    cursor: accent,
    cursorAccent: token('--bg-base'),
    selectionBackground: token('--accent-soft'),
    black: token('--bg-elevated'),
    brightBlack: token('--text-faint'),
    red: token('--danger'),
    brightRed: token('--danger-hover'),
    green: token('--success'),
    brightGreen: token('--success'),
    yellow: token('--warn'),
    brightYellow: token('--warn'),
    blue: accent,
    brightBlue: token('--accent-hover'),
    magenta: token('--accent-violet'),
    brightMagenta: token('--accent-violet'),
    cyan,
    brightCyan: cyan,
    white: token('--text-muted'),
    brightWhite: text
  }
}

export function TerminalPanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const unsubsRef = useRef<Array<() => void>>([])
  const termRef = useRef<Terminal | null>(null)
  // Re-applying the theme is the only thing that needs to react to an
  // appearance change; everything else about the session is independent of it.
  const appearance = useSettingsStore((s) => s.settings?.appearance)

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTerminalTheme()
  }, [appearance])

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
      theme: readTerminalTheme()
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    if (containerRef.current) {
      term.open(containerRef.current)
      setTimeout(() => fitAddon.fit(), 0)
    }

    const startSession = async (): Promise<void> => {
      const result = await anodex.terminal.create()
      if (!result.ok) {
        term.write(`\r\n\x1b[31mFailed to start terminal: ${result.error.message}\x1b[0m\r\n`)
        return
      }

      const sessionId = result.value

      const unsubData = anodex.terminal.onData(({ sessionId: sid, data }) => {
        if (sid === sessionId) term.write(data)
      })
      unsubsRef.current.push(unsubData)

      const unsubExit = anodex.terminal.onExit(({ sessionId: sid }) => {
        if (sid === sessionId) {
          term.write('\r\n\x1b[33mProcess exited.\x1b[0m\r\n')
        }
      })
      unsubsRef.current.push(unsubExit)

      term.onData((data) => {
        void anodex.terminal.write(sessionId, data)
      })

      term.onResize(({ cols, rows }) => {
        void anodex.terminal.resize(sessionId, cols, rows)
      })

      unsubsRef.current.push(() => {
        void anodex.terminal.kill(sessionId)
      })
    }

    void startSession()

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
      } catch {
        // Container may be detached during rapid resize.
      }
    })
    if (containerRef.current) resizeObserver.observe(containerRef.current)

    return () => {
      for (const unsub of unsubsRef.current) unsub()
      unsubsRef.current = []
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [])

  return (
    <WorkspaceDockPanel title="Terminal">
      <div ref={containerRef} className={styles.terminal} />
    </WorkspaceDockPanel>
  )
}
