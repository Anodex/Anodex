// The scorer has to be trustworthy before any arm is run: a scorer that is
// generous to vacuous reports hands every arm the same free points and
// compresses the difference the benchmark exists to measure.
import { describe, expect, it } from 'vitest'
import { ANSWER_KEY, scoreReport } from '../bench-subagents-fixture.mjs'

/** A complete, well-written report — one finding per line, as models write them. */
const COMPLETE = [
  '1. auth.py is_token_expired — expires_at is milliseconds but is compared against time.time(), which is seconds.',
  '2. auth.py verify_password — returns True when stored_hash is empty, so the account accepts any password.',
  '3. parser.py parse_records — mutable default argument acc=[] is shared between calls.',
  '4. parser.py split_fields — the loop starts at index 1, so the first character is skipped.',
  '5. cache.py LruCache.put — compares against max_size but never evicts, so it grows without bound.',
  '6. cache.py LruCache.get — recency is only updated on a miss, so the LRU order is wrong.',
  '7. money.py to_cents — int() truncates, so 19.99 becomes 1998 cents.',
  '8. money.py split_bill — integer division drops the remainder, so shares do not sum to the total.',
  '9. validation.py is_valid_email — re.search without anchors; should be fullmatch.',
  '10. validation.py check_length — compares <= max_len + 1, an off-by-one.',
  '11. retry.py with_retry — attempts is never incremented, so it loops forever.',
  '12. retry.py with_retry — sleeps before the first attempt, delaying even the success path.'
].join('\n')

/**
 * A report that names every function and every category of bug without ever
 * connecting the two. This is the shape a weak model actually produces, and
 * the shape that flatters a naive scorer.
 */
const VACUOUS = [
  'I read auth.py, parser.py, validation.py, money.py, cache.py, retry.py, rates.py and',
  'report.py. The code looks reasonable overall. There may be some rounding issues and',
  'possibly an off-by-one somewhere. I checked is_token_expired, verify_password,',
  'parse_records, split_fields, to_cents, split_bill, is_valid_email, check_length and',
  'with_retry and they appear fine.'
].join('\n')

describe('bug-hunt scoring', () => {
  it('gives a complete report full marks', () => {
    expect(scoreReport(COMPLETE)).toHaveLength(ANSWER_KEY.length)
  })

  it('gives a vacuous report nothing', () => {
    // It names every symbol and gestures at every category. If naming counted,
    // the do-nothing arm would score as well as the working one.
    expect(scoreReport(VACUOUS)).toEqual([])
  })

  it('scores a partial report partially', () => {
    const partial = [
      'money.py to_cents truncates with int(), so 19.99 becomes 1998.',
      'validation.py check_length uses <= max_len + 1, an off-by-one.'
    ].join('\n')
    expect(scoreReport(partial).map((bug) => bug.id)).toEqual([
      'money-truncation',
      'validation-off-by-one'
    ])
  })

  it('accepts a finding whose explanation wraps to the next line', () => {
    const wrapped = ['- money.py to_cents', '  int() truncates, so 19.99 becomes 1998 cents.'].join(
      '\n'
    )
    expect(scoreReport(wrapped).map((bug) => bug.id)).toEqual(['money-truncation'])
  })

  it('refuses a claim that names the place but not the fault', () => {
    expect(scoreReport('money.py to_cents looks correct to me.')).toEqual([])
  })

  it('refuses a fault described without a place', () => {
    expect(scoreReport('There is an off-by-one and a truncation bug somewhere.')).toEqual([])
  })

  it('has a distinct id for every planted bug', () => {
    // Two bugs sharing an id would silently halve the denominator.
    expect(new Set(ANSWER_KEY.map((bug) => bug.id)).size).toBe(ANSWER_KEY.length)
  })
})
