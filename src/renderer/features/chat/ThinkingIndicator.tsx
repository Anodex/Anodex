import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import styles from './MessageBubble.module.css'

const THINKING_PHRASES = [
  'Thinking',
  'Reasoning',
  'Reading the code',
  'Tracing the logic',
  'Considering options',
  'Piecing it together',
  'Mapping it out',
  'Checking the details',
  'Working through it',
  'Connecting the dots',
  'Searching the codebase',
  'Weighing the tradeoffs',
  'Following the call path',
  'Checking for edge cases',
  'Cross-referencing files',
  'Double-checking assumptions',
  'Narrowing it down',
  'Looking for the root cause',
  'Sketching a plan',
  'Comparing approaches',
  'Reviewing the context',
  'Working out the details',
  'Testing an idea',
  'Verifying the logic',
  'Scanning related files',
  'Untangling the dependencies',
  'Lining up the pieces',
  'Thinking it through',
  'Checking the types',
  'Walking through the flow',
  'Getting the full picture',
  'Refining the approach',
  'Making sure it holds up',
  'Chasing down references',
  'Working out an edge case',
  'Reconsidering the approach',
  'Checking for side effects',
  'Drafting a response',
  'Fitting the pieces together',
  'Retracing the steps',
  'Validating the plan',
  'Looking at it from another angle',
  'Making sense of the structure',
  'Checking what depends on what',
  'Running through the scenarios',
  'Settling on an approach',
  'Tightening up the logic',
  'Reading through the history',
  'Confirming the details',
  'Bringing it together'
]

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/** A fresh shuffle of every phrase, guaranteed not to start with `avoidFirst` (the last phrase shown). */
function nextShuffle(avoidFirst: string | undefined): string[] {
  const next = shuffled(THINKING_PHRASES)
  if (next.length > 1 && next[0] === avoidFirst) {
    ;[next[0], next[1]] = [next[1], next[0]]
  }
  return next
}

/**
 * Composed thinking indicator: a breathing accent sparkle beside status
 * phrases that shimmer and crossfade. Reshuffles on every full pass through
 * the list (rather than looping one fixed order) so long-running tasks don't
 * read as a canned loop. The outgoing phrase is kept in state so it can
 * animate up and out while the next one rises in.
 */
export function ThinkingIndicator(): JSX.Element {
  const [state, setState] = useState(() => ({
    queue: shuffled(THINKING_PHRASES),
    index: 0,
    prev: null as string | null
  }))

  useEffect(() => {
    const id = window.setInterval(() => {
      setState((prev) => {
        const leaving = prev.queue[prev.index]
        const index = prev.index + 1
        if (index < prev.queue.length) return { queue: prev.queue, index, prev: leaving }
        return { queue: nextShuffle(prev.queue[prev.queue.length - 1]), index: 0, prev: leaving }
      })
    }, 2000)
    return () => window.clearInterval(id)
  }, [])

  const phrase = state.queue[state.index]
  return (
    <span className={styles.thinkingRow} aria-label="Generating">
      <Icon name="sparkle" size={15} className={styles.thinkingSparkle} />
      <span className={styles.thinkingStack}>
        {state.prev !== null && (
          <span
            key={`out-${state.index}-${state.prev}`}
            className={`${styles.thinking} ${styles.phraseOut}`}
            aria-hidden="true"
          >
            {state.prev}
          </span>
        )}
        <span key={phrase} className={`${styles.thinking} ${styles.phraseIn}`}>
          {phrase}
        </span>
      </span>
    </span>
  )
}
