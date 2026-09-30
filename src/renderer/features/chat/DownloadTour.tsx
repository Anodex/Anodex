import { useState } from 'react'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
import { Icon } from '../../components/Icon'
import { ShortcutKeys } from '../../components/ShortcutKeys'
import { useSettingsStore } from '../../stores/settingsStore'
import { SLIDES, TOUR_AREA_LABEL } from './downloadTourSlides'
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
export function DownloadTour(): JSX.Element {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)

  const step = (delta: number): void => setIndex((i) => (i + delta + SLIDES.length) % SLIDES.length)
  const slide = SLIDES[index]
  const row = SLIDES.filter((s) => s.area === slide.area)
  const shortcut = slide.shortcut
    ? (shortcuts?.[slide.shortcut] ?? DEFAULT_KEYBOARD_SHORTCUTS[slide.shortcut])
    : null

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

      <div
        key={index}
        className={styles.slide}
        data-area={slide.area}
        aria-roledescription="slide"
        aria-label={`${index + 1} of ${SLIDES.length}`}
      >
        <div className={styles.area}>
          <div className={styles.areaLabel}>{TOUR_AREA_LABEL[slide.area]}</div>
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
                <Icon name={s.icon} size={16} />
              </span>
            ))}
          </div>
        </div>

        <div className={styles.text}>
          <div className={styles.meta}>
            {index + 1} of {SLIDES.length}
          </div>
          <h2 className={styles.title}>{slide.title}</h2>
          <p className={styles.body}>{slide.body}</p>
          <div className={styles.tip}>
            <Icon name="lightbulb" size={13} className={styles.tipIcon} />
            <span>{slide.tip}</span>
            {shortcut && <ShortcutKeys shortcut={shortcut} />}
          </div>
        </div>
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
