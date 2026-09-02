import { beforeEach, describe, expect, it } from 'vitest'
import { findRecentDuplicateSend, recordSentEmail, resetSentEmailLog } from '../sentEmailLog'

/**
 * Conversation scoping is the part worth pinning down. The guard exists so an
 * approval card can say "you already sent this one" — and it must say that
 * about *this* conversation only. A warning sourced from an unrelated chat
 * would be noise, and noise on a security-shaped prompt is worse than silence,
 * because it teaches people to click through.
 */
const message = {
  to: ['someone@example.com'],
  subject: 'Anodex send test',
  body: 'This is an automated delivery test from Anodex.'
}

describe('sentEmailLog', () => {
  beforeEach(() => resetSentEmailLog())

  it('finds nothing before anything is sent', () => {
    expect(findRecentDuplicateSend('c1', message)).toBeNull()
  })

  it('recognises the same message sent again in the same conversation', () => {
    recordSentEmail('c1', message)
    expect(findRecentDuplicateSend('c1', message)?.subject).toBe('Anodex send test')
  })

  it('keeps conversations apart', () => {
    recordSentEmail('c1', message)
    expect(findRecentDuplicateSend('c2', message)).toBeNull()
  })

  it('does not flag a different message in the same conversation', () => {
    recordSentEmail('c1', message)
    expect(findRecentDuplicateSend('c1', { ...message, subject: 'Something else' })).toBeNull()
  })

  it('recognises a retyped body with different whitespace', () => {
    // The realistic repeat: the model re-composes rather than replaying bytes.
    recordSentEmail('c1', message)
    const retyped = { ...message, body: 'This is an automated\n   delivery test from Anodex.' }
    expect(findRecentDuplicateSend('c1', retyped)).not.toBeNull()
  })

  it('still finds a send after many later ones, up to the cap', () => {
    recordSentEmail('c1', message)
    for (let index = 0; index < 40; index++) {
      recordSentEmail('c1', { ...message, subject: `filler ${index}` })
    }
    expect(findRecentDuplicateSend('c1', message)).not.toBeNull()
  })

  it('drops the oldest once the cap is passed', () => {
    // Bounded on purpose: a conversation that has sent fifty emails is no
    // longer the "sent the same thing twice by accident" case.
    recordSentEmail('c1', message)
    for (let index = 0; index < 60; index++) {
      recordSentEmail('c1', { ...message, subject: `filler ${index}` })
    }
    expect(findRecentDuplicateSend('c1', message)).toBeNull()
  })

  it('forgets everything on reset', () => {
    recordSentEmail('c1', message)
    resetSentEmailLog()
    expect(findRecentDuplicateSend('c1', message)).toBeNull()
  })
})
