import { describe, expect, it } from 'vitest'
import {
  ANODEX_COMMIT_EMAIL,
  commitAttributionLine,
  hasCommitAttribution,
  withCommitAttribution
} from '../commitAttribution'

describe('withCommitAttribution', () => {
  const on = { enabled: true }

  it('adds the trailer in its own paragraph after a one-line message', () => {
    // Glued to the subject it would become part of the subject, which is what
    // every log, every PR title and every blame view then shows.
    expect(withCommitAttribution('fix: the thing', on)).toBe(
      `fix: the thing\n\nCo-Authored-By: Anodex <${ANODEX_COMMIT_EMAIL}>\n`
    )
  })

  it('joins a trailer block that is already there', () => {
    const message = 'feat: a thing\n\nWhy it matters.\n\nSigned-off-by: A Person <a@example.com>'
    expect(withCommitAttribution(message, on)).toBe(
      `${message}\nCo-Authored-By: Anodex <${ANODEX_COMMIT_EMAIL}>\n`
    )
  })

  it('starts a new paragraph after a body that is prose', () => {
    const message = 'feat: a thing\n\nA sentence explaining it.'
    expect(withCommitAttribution(message, on)).toBe(
      `${message}\n\nCo-Authored-By: Anodex <${ANODEX_COMMIT_EMAIL}>\n`
    )
  })

  it('does not credit Anodex twice', () => {
    const already = `fix: x\n\nCo-Authored-By: Anodex <${ANODEX_COMMIT_EMAIL}>`
    expect(withCommitAttribution(already, on)).toBe(already)
  })

  it('does not add a second trailer when the configured address changes', () => {
    // Matched on the name, so re-pointing the email at a new account does not
    // start stacking trailers onto messages that already carry one.
    const already = 'fix: x\n\nCo-Authored-By: Anodex <someone-else@example.com>'
    expect(withCommitAttribution(already, { enabled: true, email: 'new@example.com' })).toBe(
      already
    )
  })

  it('leaves the message alone when the setting is off', () => {
    expect(withCommitAttribution('fix: the thing', { enabled: false })).toBe('fix: the thing')
  })

  it('leaves an empty message alone rather than committing a bare trailer', () => {
    expect(withCommitAttribution('   ', on)).toBe('   ')
  })

  it('honours a configured address, and falls back when it is blank', () => {
    expect(commitAttributionLine('bot@example.com')).toBe(
      'Co-Authored-By: Anodex <bot@example.com>'
    )
    expect(commitAttributionLine('  ')).toBe(`Co-Authored-By: Anodex <${ANODEX_COMMIT_EMAIL}>`)
  })

  it('recognises a credit written by hand', () => {
    expect(hasCommitAttribution('x\n\nco-authored-by: Anodex <a@b.c>')).toBe(true)
    expect(hasCommitAttribution('x\n\nCo-Authored-By: Someone <a@b.c>')).toBe(false)
  })
})
