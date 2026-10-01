import { memo, useState } from 'react'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
import type { KeyboardShortcutMap } from '@shared/settings.types'
import { Icon } from '../../components/Icon'
import { ShortcutKeys } from '../../components/ShortcutKeys'
import { useSettingsStore } from '../../stores/settingsStore'
import { CometStatusDot } from '../../components/ui/CometStatusDot'
import { DOCK_PANELS } from '../workspace-dock/workspaceDockTypes'
import { createDefaultSettings } from '@shared/settings.defaults'
import {
  PERMISSION_MODES,
  permissionDescription,
  permissionIcon,
  permissionLabel
} from './composer/permissionModes'
import { SLIDES, TOUR_AREA_LABEL, type TourSlide, type TourVisual } from './downloadTourSlides'
import meterStyles from './ContextMeter.module.css'
import styles from './DownloadTour.module.css'

/**
 * Stands in for the model card's contents while the first model downloads.
 * That wait is minutes long and the user can do nothing else yet, which makes
 * it the one moment they will read what the controls around them are for.
 *
 * Each slide draws its control's area with the real icons, arranged the way the
 * app arranges them (a row for the top bar and message box, a column beside the
 * text for the rail), with its own lit. That is a picture of the buttons rather
 * than of the window: the buttons are stable where the theme around them is not.
 *
 * The segment filling across the top is the timer. A slide advances when its
 * fill animation ends, so pausing the animation on hover or focus pauses the
 * tour exactly where it was, and under reduced motion (no animation) the tour
 * waits to be stepped.
 */
function DownloadTourView({ modelName }: { modelName?: string }): JSX.Element {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)

  const step = (delta: number): void => setIndex((i) => (i + delta + SLIDES.length) % SLIDES.length)
  return (
    <section
      className={`${styles.tour} ${paused ? styles.paused : ''}`}
      aria-roledescription="carousel"
      aria-label="What the controls do"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={styles.segments}>
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`${styles.segment} ${i < index ? styles.segmentDone : ''}`}
            onClick={() => setIndex(i)}
            aria-label={s.title}
            aria-current={i === index ? 'step' : undefined}
          >
            {i === index && (
              <span key={index} className={styles.segmentFill} onAnimationEnd={() => step(1)} />
            )}
          </button>
        ))}
      </div>

      {/* Every slide is laid into the same cell and all but the current one is
          hidden, so the box is always as tall as the tallest slide and does not
          change size from one control to the next, whatever the text wraps to. */}
      <div className={styles.deck}>
        {SLIDES.map((slide, i) => (
          <TourSlideView
            key={slide.id}
            slide={slide}
            position={i}
            active={i === index}
            shortcuts={shortcuts}
            modelName={modelName}
          />
        ))}
      </div>

      <div className={styles.nav}>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => step(-1)}
          aria-label="Previous"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button type="button" className={styles.arrow} onClick={() => step(1)} aria-label="Next">
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </section>
  )
}

/**
 * Memoised because it sits beside the download's progress: every progress
 * report re-renders the card, and a tour that re-rendered all of its slides
 * each time made the window slow to answer a click, Cancel included.
 */
export const DownloadTour = memo(DownloadTourView)

function TourSlideView({
  slide,
  position,
  active,
  shortcuts,
  modelName
}: {
  slide: TourSlide
  position: number
  active: boolean
  shortcuts: Partial<KeyboardShortcutMap> | undefined
  modelName?: string
}): JSX.Element {
  const row = SLIDES.filter((s) => s.area === slide.area && s.icon)
  const shortcut = slide.shortcut
    ? (shortcuts?.[slide.shortcut] ?? DEFAULT_KEYBOARD_SHORTCUTS[slide.shortcut])
    : null

  return (
    <div
      className={`${styles.slide} ${active ? styles.slideActive : ''}`}
      data-area={slide.area}
      aria-roledescription="slide"
      aria-label={`${position + 1} of ${SLIDES.length}`}
      aria-hidden={active ? undefined : true}
    >
      <div className={styles.area}>
        <div className={styles.areaLabel}>{TOUR_AREA_LABEL[slide.area]}</div>
        {slide.visual === 'modelStatus' ? (
          <TourVisualView visual="modelStatus" modelName={modelName} />
        ) : (
          <div className={styles.row} aria-hidden="true">
            {row.map((s) => (
              <span
                key={s.id}
                className={[
                  styles.control,
                  s.detached ? styles.detached : '',
                  s.dividerBefore ? styles.dividerBefore : '',
                  s.id === slide.id ? styles.controlLit : ''
                ].join(' ')}
              >
                {s.icon && <Icon name={s.icon} size={16} />}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={styles.text}>
        <div className={styles.meta}>
          {position + 1} of {SLIDES.length}
        </div>
        <h2 className={styles.title}>{slide.title}</h2>
        <p className={styles.body}>{slide.body}</p>
        <div className={styles.tip}>
          <Icon name="lightbulb" size={13} className={styles.tipIcon} />
          <span>{slide.tip}</span>
          {shortcut && <ShortcutKeys shortcut={shortcut} />}
        </div>
        {slide.visual && slide.visual !== 'modelStatus' && (
          <TourVisualView visual={slide.visual} modelName={modelName} />
        )}
      </div>
    </div>
  )
}

/** A slide's live example, made of the app's own parts so it follows them. */
function TourVisualView({
  visual,
  modelName = 'Your model'
}: {
  visual: TourVisual
  modelName?: string
}): JSX.Element {
  if (visual === 'dockPanels') {
    return (
      <div className={styles.panels} aria-label="Dock panels">
        {DOCK_PANELS.map((panel) => (
          <span key={panel.id} className={styles.panel}>
            <Icon name={panel.icon} size={12} />
            {panel.label}
          </span>
        ))}
      </div>
    )
  }

  if (visual === 'permissionModes') {
    return <PermissionModes />
  }

  if (visual === 'modelStatus') {
    return (
      <div className={styles.states} aria-label="Model status states">
        <div className={styles.state}>
          <CometStatusDot tone="neutral" phase="settled" />
          <span className={styles.stateName}>No model loaded</span>
          <span className={styles.stateNote}>Nothing to answer yet</span>
        </div>
        <div className={styles.state}>
          <CometStatusDot tone="running" phase="loading" />
          <span className={styles.stateName}>{modelName}</span>
          <span className={styles.stateNote}>Loading</span>
        </div>
        <div className={styles.state}>
          <CometStatusDot tone="success" phase="settled" />
          <span className={styles.stateName}>{modelName}</span>
          <span className={styles.stateNote}>Ready</span>
        </div>
      </div>
    )
  }

  // The context meter's own stylesheet, so the example looks like the real one.
  return (
    <div className={`${meterStyles.meter} ${styles.meterExample}`} aria-hidden="true">
      <Icon name="activity" size={12} className={meterStyles.icon} />
      <div className={meterStyles.track}>
        <div className={`${meterStyles.seg} ${meterStyles.segSystem}`} style={{ width: '9%' }} />
        <div className={`${meterStyles.seg} ${meterStyles.segTools}`} style={{ width: '14%' }} />
        <div className={`${meterStyles.seg} ${meterStyles.segHistory}`} style={{ width: '19%' }} />
      </div>
      <span className={meterStyles.label}>
        ~13.4k<span className={meterStyles.labelMuted}> / 32k</span>
      </span>
    </div>
  )
}

/** The composer menu's own modes, marking the one this install is using. */
function PermissionModes(): JSX.Element {
  const current =
    useSettingsStore((s) => s.settings?.general.permissionMode) ??
    createDefaultSettings('').general.permissionMode
  return (
    <div className={styles.modes} aria-label="Permission modes">
      {PERMISSION_MODES.map((mode) => (
        <div key={mode} className={`${styles.mode} ${mode === current ? styles.modeCurrent : ''}`}>
          <Icon name={permissionIcon(mode)} size={14} className={styles.modeIcon} />
          <span className={styles.modeName}>{permissionLabel(mode)}</span>
          <span className={styles.modeText}>{permissionDescription(mode)}</span>
          {mode === current && <span className={styles.modeBadge}>Current</span>}
        </div>
      ))}
    </div>
  )
}
