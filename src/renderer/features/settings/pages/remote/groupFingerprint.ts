/**
 * The first 10 bytes, grouped in fives — the same derivation the phone uses.
 *
 * Truncated because a 64-character string does not get read, it gets glanced at
 * and approved, and a fingerprint nobody checks is not a security control.
 * Shared by Settings → Remote and the welcome's phone step, which must agree.
 */
export function groupFingerprint(hex: string): string {
  const bytes = hex.slice(0, 20).toUpperCase().match(/.{2}/g) ?? []
  const first = bytes.slice(0, 5).join(' ')
  const second = bytes.slice(5, 10).join(' ')
  return `${first}  ${second}`
}
