import { describe, expect, it } from 'vitest'
import { claimsVisualSuccess } from '../visualVerification'

describe('claimsVisualSuccess', () => {
  it.each([
    'Fixed the sandbox — the canvas now renders correctly.',
    'The page displays correctly now.',
    'The 3D scene is working.',
    'Verified the UI renders as expected.'
  ])('flags %s', (text) => {
    expect(claimsVisualSuccess(text)).toBe(true)
  })

  /**
   * Anodex is a general-purpose coding assistant, not a web tool. The visual
   * gate must stay silent for every project type it cannot photograph —
   * otherwise a Python CLI, a Rust service, or a game engine build would carry
   * a "call inspect_visual" correction that makes no sense and cannot be
   * satisfied.
   *
   * The gate is conditional on the *claim*, not the project: it only asks for a
   * screenshot when the reply asserts something about rendered output.
   */
  it.each([
    ['a Python CLI', 'Added the --verbose flag and the tests now pass.'],
    ['a Rust service', 'cargo test is green; the borrow checker error is fixed.'],
    ['a Go build', 'go build ./... succeeds now that the import cycle is gone.'],
    ['a data pipeline', 'The ETL job completes and writes 12,400 rows.'],
    ['a refactor', 'Renamed the helper and updated its call sites.'],
    ['a type fix', 'The type error in the reducer is fixed and typecheck passes.'],
    ['a game logic fix', 'Collision detection is fixed — the unit tests cover it now.'],
    ['a docs change', 'Updated the README to document the new flag.']
  ])('stays silent for %s', (_label, text) => {
    expect(claimsVisualSuccess(text)).toBe(false)
  })

  it('stays silent when the reply already concedes it is untested', () => {
    expect(
      claimsVisualSuccess(
        'The canvas now renders, but this is unverified — I could not confirm it.'
      )
    ).toBe(false)
  })

  /**
   * A source-level claim is legitimately supportable by reading code, so it
   * must not demand a screenshot. Only claims about what something *looks
   * like* need pixels.
   */
  it('does not treat a claim about source code as a visual claim', () => {
    expect(claimsVisualSuccess('The animate function is now defined before it is called.')).toBe(
      false
    )
  })
})
