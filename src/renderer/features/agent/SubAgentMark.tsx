import type { JSX } from 'react'
import styles from './SubAgentMark.module.css'

/**
 * The identity mark for one sub-agent: a hub wired to three, four or five
 * nodes, lighting in turn while it works.
 *
 * ## Why this shape
 *
 * It is the delegation itself, drawn — a centre that sent work out, and the
 * points it sent work to, answering one after another. Alone among the shapes
 * considered for this, its form means what the feature means, and it echoes
 * the constellation the app already runs behind chat.
 *
 * It is also drawn in this app's language rather than a borrowed one: flat
 * angular geometry in `currentColor`, no gradients, no fills that need a
 * theme to look right. An earlier version of this used soft overlapping
 * circles, which looked well enough and belonged to a different product.
 *
 * ## Why the node count changes and not just the colour
 *
 * Colour alone would carry identity for most people and none of it for anyone
 * with a red-green deficiency — and this view puts red and green a few pixels
 * away meaning "failed" and "finished". It also fails for everyone at the
 * moment it matters most: once all three sub-agents finish, their colours
 * converge on green and stop distinguishing anything at all. Alpha has three
 * nodes, Bravo four, Charlie five, so the marks stay apart in a screenshot,
 * in greyscale, and after the colours have collapsed. Colour is then free to
 * carry the thing it is better at, which is state.
 */
export function SubAgentMark({
  /** Which sub-agent this is, counting from zero. Decides the node count. */
  index,
  /** Whether that sub-agent is working right now — the only thing that animates. */
  working = false,
  size = 18,
  className
}: {
  index: number
  working?: boolean
  size?: number
  className?: string
}): JSX.Element {
  const nodes = NODES[index % NODES.length]
  const points = Array.from({ length: nodes }, (_, node) => {
    // Starting at twelve o'clock, so every mark has a node at the top and the
    // set reads as one family rather than as shapes at arbitrary rotations.
    const angle = (node / nodes) * Math.PI * 2 - Math.PI / 2
    return { x: 12 + Math.cos(angle) * ORBIT, y: 12 + Math.sin(angle) * ORBIT }
  })

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Spokes first, so the nodes sit on top of where they meet. */}
      {points.map((point, node) => (
        <line
          key={`spoke-${node}`}
          x1={12}
          y1={12}
          x2={point.x}
          y2={point.y}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeOpacity={0.4}
        />
      ))}
      {points.map((point, node) => (
        <circle
          key={`node-${node}`}
          cx={point.x}
          cy={point.y}
          r={2.5}
          fill="currentColor"
          className={working ? styles.node : undefined}
          // Staggered round the ring, so the lighting travels rather than
          // every node blinking at once. Set here and not in CSS because the
          // node count is not fixed.
          style={working ? { animationDelay: `${node * 0.3}s` } : undefined}
        />
      ))}
      <circle cx={12} cy={12} r={3} fill="currentColor" />
    </svg>
  )
}

/**
 * Nodes per position. Three, four and five: enough of a step to tell apart at
 * the 16px this is usually drawn at, and there are only ever three of these on
 * screen — see `MAX_SUB_AGENTS`.
 */
const NODES = [3, 4, 5]

/** How far each node sits from the hub, in viewBox units. */
const ORBIT = 7.6
