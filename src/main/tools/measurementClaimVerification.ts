/**
 * Distinctive numbers a reply states that appear in no tool result this task.
 *
 * ## The failure
 *
 * A run reported the star's corona "verified", quoting a radial profile:
 * "bright core ~157 -> 23.6 at r=14 -> background 8.5 by r=34, no hard edge".
 * A pixel probe of the very image it had rendered showed a flat disc with no
 * falloff at all. Those numbers were never measured; they were written.
 *
 * Every guard passed it. `madeChange` saw real edits. The visual check saw an
 * `inspect_visual` after the last change. The plan guard saw its step ticked.
 * All of them ask whether verification *happened* -- none asks whether it found
 * what the reply says it found.
 *
 * ## What this checks
 *
 * A measurement has to come from somewhere. If a reply states `1.456e-16` or
 * `958464`, that figure should appear in something a tool actually returned --
 * a command's output, a file that was read. When it appears nowhere, the reply
 * is quoting a measurement this task never took.
 *
 * The same shape as `findUnverifiedPathClaims`, and for the same reason: decided
 * from state rather than from whether the prose *sounds* confident.
 *
 * ## Why it is narrow on purpose
 *
 * Only numbers distinctive enough to be a measurement rather than arithmetic or
 * a round figure -- see {@link DISTINCTIVE_NUMBER}. A model legitimately adds up
 * "3 files", says "about 150 bodies", or cites a line number; flagging those
 * would be noise, and a check that cries wolf gets ignored. Missing a fabricated
 * round number costs less than that.
 */
export interface MeasurementClaim {
  /** The number as the reply wrote it. */
  text: string
}

/**
 * Numbers precise enough that they must have been measured, not reasoned to:
 * scientific notation (`1.456e-16`), a decimal carrying real precision
 * (`23.6`, `0.0042`), or a long integer (`958464`).
 *
 * Deliberately excludes small integers, one-decimal round figures and anything
 * a person would write by hand.
 */
const DISTINCTIVE_NUMBER = /-?\d+(?:\.\d+)?[eE][-+]?\d+|-?\d+\.\d{1,}|-?\d{5,}/g

/** Strip separators so `958,464` in prose matches `958464` in output. */
function normalize(value: string): string {
  return value.replace(/,/g, '')
}

export function findUnverifiedMeasurements(
  content: string,
  toolOutput: string
): MeasurementClaim[] {
  const haystack = normalize(toolOutput)
  const seen = new Set<string>()
  const issues: MeasurementClaim[] = []

  for (const match of content.matchAll(DISTINCTIVE_NUMBER)) {
    const raw = match[0]
    const value = normalize(raw)
    if (seen.has(value)) continue
    seen.add(value)
    if (haystack.includes(value)) continue
    // A rounded quotation of something real is honest reporting, not invention:
    // "1.5e-15" for a measured "1.456e-15", or "958464" written as "958,464".
    if (roundedFormOf(value, haystack)) continue
    issues.push({ text: raw })
  }
  return issues
}

/**
 * Whether the haystack holds a number this one is a rounded form of.
 *
 * Reporting `1.6e-15` for a measured `1.600e-15`, or `23.6` for `23.61`, is
 * exactly what a careful summary should do. Only a figure that matches nothing
 * even loosely is a claim with no source.
 */
function roundedFormOf(value: string, haystack: string): boolean {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed === 0) return false
  for (const match of haystack.matchAll(DISTINCTIVE_NUMBER)) {
    const candidate = Number(match[0])
    if (!Number.isFinite(candidate) || candidate === 0) continue
    const ratio = Math.abs(parsed / candidate)
    // Within 1% either way: the same measurement, differently rounded.
    if (ratio > 0.99 && ratio < 1.01) return true
  }
  return false
}

/** A calm, factual note — `null` when there is nothing to flag. */
export function describeUnverifiedMeasurements(claims: MeasurementClaim[]): string | null {
  if (claims.length === 0) return null
  const listed = claims
    .slice(0, 4)
    .map((claim) => `\`${claim.text}\``)
    .join(', ')
  const more = claims.length > 4 ? `, and ${claims.length - 4} more` : ''
  return (
    `stated ${listed}${more} as measured, but no tool output this task contains ` +
    'those figures — treat them as unverified'
  )
}
