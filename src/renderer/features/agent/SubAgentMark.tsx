import type { JSX } from 'react'

/**
 * The identity mark for one sub-agent: a rosette of overlapping petals.
 *
 * ## Why a generated mark rather than a letter or a number
 *
 * A delegation is several agents working at once, and the only thing the user
 * has to do with them is tell them apart — at a glance, in a header, at 18px.
 * A letter has to be read. A shape is recognised, and it keeps working once it
 * is also the thing sitting beside that run's card in the list and its report
 * in the transcript.
 *
 * ## Why the petal count changes and not just the colour
 *
 * Colour alone would carry identity for most people and none of it for anyone
 * with a red-green deficiency — and this app already uses red and green for
 * "failed" and "finished" a few pixels away. Alpha has four petals, Bravo six,
 * Charlie eight, so the marks stay distinct in a screenshot, in greyscale, and
 * for a reader who cannot separate the hues at all. Colour is then free to
 * carry the thing it is better at: state.
 *
 * Petals are drawn as overlapping translucent circles, so where they cross the
 * fill doubles and the mark gets its own interior structure for free — no
 * gradients, no paths to hand-tune per count, and it stays legible when it is
 * the size of a full stop.
 */
export function SubAgentMark({
  /** Which sub-agent this is, counting from zero. Decides the petal count. */
  index,
  size = 18,
  className
}: {
  index: number
  size?: number
  className?: string
}): JSX.Element {
  const petals = PETALS[index % PETALS.length]
  // A petal sits this far from the middle, leaving the centre overlapped by
  // every one of them — which is what makes the mark read as a single object
  // rather than a ring of dots.
  const orbit = 5.4
  const radius = 4.6

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: petals }, (_, petal) => {
        const angle = (petal / petals) * Math.PI * 2 - Math.PI / 2
        return (
          <circle
            key={petal}
            cx={12 + Math.cos(angle) * orbit}
            cy={12 + Math.sin(angle) * orbit}
            r={radius}
            fill="currentColor"
            fillOpacity={0.5}
          />
        )
      })}
    </svg>
  )
}

/**
 * Petals per position. Four, six and eight rather than four, five and six:
 * adjacent counts are hard to tell apart at this size, and there are only ever
 * three of these on screen — see `MAX_SUB_AGENTS`.
 */
const PETALS = [4, 6, 8]
