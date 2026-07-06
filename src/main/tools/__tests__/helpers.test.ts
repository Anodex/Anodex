import { describe, expect, it } from 'vitest'
import { composeDenialMessage } from '../helpers'

describe('composeDenialMessage', () => {
  it('returns the generic message when no reason is given', () => {
    expect(composeDenialMessage()).toBe(
      'The user denied this action. Do not retry it — ask how they would like to proceed.'
    )
  })

  it('treats a whitespace-only reason as no reason', () => {
    expect(composeDenialMessage('   ')).toBe(
      'The user denied this action. Do not retry it — ask how they would like to proceed.'
    )
  })

  it('weaves a typed reason into the message', () => {
    expect(composeDenialMessage('use a different file name')).toBe(
      'The user denied this action for this reason: "use a different file name". Do not retry it — adjust your approach based on their feedback.'
    )
  })

  it('trims surrounding whitespace from the reason', () => {
    expect(composeDenialMessage('  no  ')).toBe(
      'The user denied this action for this reason: "no". Do not retry it — adjust your approach based on their feedback.'
    )
  })
})
