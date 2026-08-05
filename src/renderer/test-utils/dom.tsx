import { cleanup, render as testingLibraryRender } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { ReactElement } from 'react'

/**
 * Renders a component into a real DOM for tests that need one.
 *
 * The suite runs under `environment: 'node'` by default and should keep doing
 * so — main-process tests are the overwhelming majority, they need node APIs,
 * and a DOM for every one of them costs startup time for nothing. A file that
 * needs a document opts in with a docblock at the top:
 *
 * ```ts
 * // @vitest-environment jsdom
 * ```
 *
 * Importing this module registers the unmount that has to happen between
 * tests. `@testing-library/react` normally does that itself through vitest's
 * globals, which this project deliberately does not enable (`globals: false`),
 * so without it every render in a file would stack in the same document and
 * queries would match the previous test's markup.
 *
 * Reach for this only when the thing under test genuinely needs a DOM —
 * component state across a re-render, an effect, an event handler. Logic that
 * can be lifted into a plain module should be, and tested there: that is what
 * `intakeAttachments` was extracted for, and it remains the cheaper answer.
 */
export function render(ui: ReactElement): ReturnType<typeof testingLibraryRender> {
  return testingLibraryRender(ui)
}

afterEach(cleanup)

export { screen, fireEvent, waitFor, within, act } from '@testing-library/react'
