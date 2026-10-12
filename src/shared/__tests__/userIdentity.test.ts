import { describe, expect, it } from 'vitest'
import { avatarGradient, firstName, initialsOf, partOfDay, PLACEHOLDER_NAME } from '../userIdentity'

describe('userIdentity', () => {
  it("greets a person by their own first name, and nobody by the placeholder's", () => {
    expect(firstName('Sam Rivera')).toBe('Sam')
    expect(firstName('  Sam  ')).toBe('Sam')
    expect(firstName(PLACEHOLDER_NAME)).toBeNull()
    expect(firstName('')).toBeNull()
  })

  it('draws up to two initials, and none for the placeholder', () => {
    expect(initialsOf('Sam Rivera')).toBe('SR')
    expect(initialsOf('ana maria lopez')).toBe('AM')
    expect(initialsOf(PLACEHOLDER_NAME)).toBe('')
  })

  it("falls back to the mark's own gradient for an unknown look", () => {
    expect(avatarGradient(99)).toBe(avatarGradient(0))
    expect(avatarGradient(3)).toContain('#f5a623')
  })

  it('names the part of the day', () => {
    expect(partOfDay(new Date(2026, 9, 12, 8))).toBe('morning')
    expect(partOfDay(new Date(2026, 9, 12, 14))).toBe('afternoon')
    expect(partOfDay(new Date(2026, 9, 12, 21))).toBe('evening')
    expect(partOfDay(new Date(2026, 9, 12, 2))).toBe('evening')
  })
})
