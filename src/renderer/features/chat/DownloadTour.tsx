import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { SLIDES } from './downloadTourSlides'
import styles from './DownloadTour.module.css'

const ADVANCE_MS = 6000

/**
 * Stands in for the empty-chat hero while the first model downloads. That wait
 * is minutes long and the user can do nothing else yet, which makes it the one
 * moment they will read what the controls around them are for.
 */
export function DownloadTour(): JSX.Element {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => setIndex((i) => (i + 1) % SLIDES.length), ADVANCE_MS)
    return () => window.clearTimeout(timer)
  }, [index, paused])

  const step = (delta: number): void => setIndex((i) => (i + delta + SLIDES.length) % SLIDES.length)
  const slide = SLIDES[index]

  return (
    <section
      className={styles.tour}
      aria-roledescription="carousel"
      aria-label="What the controls do"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div
        key={index}
        className={styles.slide}
        aria-roledescription="slide"
        aria-label={`${index + 1} of ${SLIDES.length}`}
      >
        <div className={styles.art}>
          <Icon name={slide.icon} size={30} />
          <span className={styles.where}>{slide.where}</span>
        </div>
        <div className={styles.text}>
          <div className={styles.step}>
            While your model downloads · {index + 1} of {SLIDES.length}
          </div>
          <h2 className={styles.title}>{slide.title}</h2>
          <p className={styles.body}>{slide.body}</p>
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
        <div className={styles.dots}>
          {SLIDES.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className={`${styles.dot} ${i === index ? styles.dotActive : ''}`}
              onClick={() => setIndex(i)}
              aria-label={s.title}
              aria-current={i === index ? 'step' : undefined}
            />
          ))}
        </div>
        <button type="button" className={styles.arrow} onClick={() => step(1)} aria-label="Next">
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </section>
  )
}
