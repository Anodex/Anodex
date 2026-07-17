import { useEffect, useRef, useState } from 'react'
import titleLogo from '../../assets/title-logo.png'
import { retryStartup } from '../../hooks/useAnodexBridge'
import { useStartupStore } from '../../stores/startupStore'
import { useUiStore } from '../../stores/uiStore'
import { StartupEngine } from './startupEngine'
import styles from './StartupOverlay.module.css'

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * Cinematic boot overlay: the real `AppShell` renders (and hydrates)
 * underneath from the first frame; this plays a starfield over it and fires
 * the hyperspace jump when `startupStore` reports genuine readiness — never a
 * timer. Renders once and then goes fully imperative (store subscription +
 * refs) so React re-renders can't fight the engine's `data-state` classes;
 * the only state is `gone`, which unmounts the whole thing at the end.
 */
export function StartupOverlay(): JSX.Element | null {
  const [gone, setGone] = useState(() => useStartupStore.getState().phase === 'done')
  const stageRef = useRef<HTMLDivElement>(null)
  const starCanvasRef = useRef<HTMLCanvasElement>(null)
  const settleCanvasRef = useRef<HTMLCanvasElement>(null)
  const statusTextRef = useRef<HTMLSpanElement>(null)
  const errorTitleRef = useRef<HTMLSpanElement>(null)
  const errorDetailRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const stage = stageRef.current
    const starCanvas = starCanvasRef.current
    const settleCanvas = settleCanvasRef.current
    if (!stage || !starCanvas || !settleCanvas) return

    const engine = new StartupEngine({
      stage,
      starCanvas,
      settleCanvas,
      isFirstLaunch: () => useStartupStore.getState().firstLaunch,
      isReducedMotion: () => prefersReducedMotion.matches,
      onFinished: () => {
        useStartupStore.getState().dismiss()
        setGone(true)
      }
    })
    engine.start()

    const applyPhase = (phase: string): void => {
      if (phase === 'ready') engine.launch()
      else if (phase === 'error') engine.fail()
      else if (phase === 'initializing') engine.resume()
    }

    const swapStatus = (text: string): void => {
      const el = statusTextRef.current
      if (!el) return
      const fadeOut = el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 110,
        easing: 'ease-in',
        fill: 'forwards'
      })
      fadeOut.onfinish = () => {
        el.textContent = text
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 170,
          easing: 'ease-out',
          fill: 'forwards'
        })
      }
    }

    const reflectError = (error: { title: string; detail: string } | null): void => {
      if (!error) return
      if (errorTitleRef.current) errorTitleRef.current.textContent = error.title
      if (errorDetailRef.current) errorDetailRef.current.textContent = error.detail
    }

    // Hydration may already have finished (or failed) before this effect ran.
    const initial = useStartupStore.getState()
    reflectError(initial.error)
    applyPhase(initial.phase)

    const unsubscribe = useStartupStore.subscribe((state, prev) => {
      if (state.statusText !== prev.statusText) swapStatus(state.statusText)
      if (state.error !== prev.error) reflectError(state.error)
      if (state.phase !== prev.phase) applyPhase(state.phase)
    })

    return () => {
      unsubscribe()
      engine.destroy()
    }
  }, [])

  if (gone) return null

  const handleRetry = (): void => {
    void retryStartup()
  }

  const handleOpenSettings = (): void => {
    useUiStore.getState().openSettings()
    useStartupStore.getState().dismiss()
    setGone(true)
  }

  return (
    <div className={styles.root}>
      <div className={styles.stage} ref={stageRef}>
        <canvas className={styles.stars} ref={starCanvasRef} aria-hidden="true" />
        <div className={styles.vignette} aria-hidden="true" />
        <div className={styles.vanishPoint} aria-hidden="true" />
        <div className={styles.shockwave} aria-hidden="true" />
        <div className={styles.flash} aria-hidden="true" />

        <div className={styles.lockup}>
          <div className={styles.halo} aria-hidden="true" />
          <div className={styles.markWrap}>
            <img className={styles.logo} src={titleLogo} alt="Anodex" width={132} height={132} />
            <div
              className={styles.sheen}
              style={{ WebkitMaskImage: `url("${titleLogo}")`, maskImage: `url("${titleLogo}")` }}
              aria-hidden="true"
            />
          </div>
        </div>

        <div className={styles.status} role="status" aria-live="polite">
          <span ref={statusTextRef}>Starting local core</span>
          <span className={styles.dots} aria-hidden="true" />
        </div>

        <div className={styles.errorPanel} role="alert">
          <span className={styles.errorTitle} ref={errorTitleRef} />
          <span className={styles.errorDetail} ref={errorDetailRef} />
          <div className={styles.errorActions}>
            <button type="button" className={styles.errorPrimary} onClick={handleRetry}>
              Try again
            </button>
            <button type="button" onClick={handleOpenSettings}>
              Open Settings
            </button>
          </div>
        </div>
      </div>

      <canvas className={styles.settle} ref={settleCanvasRef} aria-hidden="true" />
    </div>
  )
}
