import { describe, expect, it } from 'vitest'
import { contextHeadroom } from '../contextHeadroom'

describe('contextHeadroom', () => {
  it('mentions a window the machine could double', () => {
    // The measured case: a 27B at 8,192 on a machine `contextSizeFor` puts at
    // 32,768. Critical Thinking there read 5,725 characters of the 56,528 it
    // had gathered; at the larger window it read 56,021 of 130,472.
    expect(contextHeadroom(8_192, 32_768)?.worthMentioning).toBe(true)
  })

  it('stays quiet about a difference nobody would act on', () => {
    // Real, but not transformative. A prompt the user cannot usefully act on
    // teaches them to ignore the next one.
    expect(contextHeadroom(24_576, 32_768)?.worthMentioning).toBe(false)
    expect(contextHeadroom(32_768, 32_768)?.worthMentioning).toBe(false)
  })

  it('stays quiet when the window already exceeds the recommendation', () => {
    // Deliberately running larger than advised is a choice, not a mistake.
    expect(contextHeadroom(65_536, 32_768)?.worthMentioning).toBe(false)
  })

  it('says nothing at all when either number is unknown', () => {
    // A cloud model has no local recommendation, and an unloaded engine has no
    // configured size. Guessing in either case would be worse than silence.
    expect(contextHeadroom(undefined, 32_768)).toBeNull()
    expect(contextHeadroom(8_192, undefined)).toBeNull()
    expect(contextHeadroom(0, 32_768)).toBeNull()
  })
})
