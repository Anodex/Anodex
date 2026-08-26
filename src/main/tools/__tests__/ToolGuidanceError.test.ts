import { describe, expect, it } from 'vitest'
import { ToolGuidanceError } from '../ToolGuidanceError'

/**
 * The point of the marker is that a transport can tell a refusal written for
 * the model apart from a genuine fault, and log them at different levels.
 */
describe('ToolGuidanceError', () => {
  it('is an Error, so every existing catch still handles it', () => {
    const error = new ToolGuidanceError('argumentsJson must decode to a JSON object.')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('argumentsJson must decode to a JSON object.')
  })

  it('is distinguishable from an ordinary fault', () => {
    expect(new ToolGuidanceError('refused')).toBeInstanceOf(ToolGuidanceError)
    expect(new Error('genuine fault')).not.toBeInstanceOf(ToolGuidanceError)
    expect(new TypeError('genuine fault')).not.toBeInstanceOf(ToolGuidanceError)
  })

  it('names itself, so a serialized log line still says what it was', () => {
    expect(new ToolGuidanceError('refused').name).toBe('ToolGuidanceError')
  })
})
