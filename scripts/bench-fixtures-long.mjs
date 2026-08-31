// The long-task fixture, kept in its own file.
//
// It is the largest of the seeded projects and the only one whose purpose is
// duration rather than difficulty, so it sits apart from `bench-fixtures.mjs`
// where the defect-hunting fixtures live.
import fs from 'node:fs'
import path from 'node:path'

const ELLIPSIS = '…'

/**
 * Twelve small, independent requirements across four modules.
 *
 * Every other benchmark finishes in three to sixteen turns on a capable model,
 * and the median run across everything measured is five. So nothing has
 * exercised what happens over a *long* run — compaction, the context-epoch
 * handoff, and the loop-guard forgiveness that lives there — on a model that is
 * working rather than stuck. Those are the paths the hardest bugs have
 * historically hidden in, and they are reached by duration, not by cleverness.
 *
 * Long by structure. Each function is a few lines and none is hard; there are
 * simply twelve of them, spread across four files, each named by its own check.
 * A model cannot collapse that into a single edit, and partial progress is
 * measurable because the checks fail one at a time — which also means a run that
 * stops early can be scored on how far it got rather than pass or fail.
 *
 * The modules exist with docstrings and `NotImplementedError` bodies, so the
 * task is to fill them in rather than to design anything.
 */
export function writeLongTaskFixture(root) {
  const pkg = path.join(root, 'toolkit')
  fs.mkdirSync(pkg, { recursive: true })

  write(path.join(pkg, '__init__.py'), [
    '"""A small utility toolkit, waiting to be filled in."""',
    '',
    'from .text import slugify, truncate, word_wrap',
    'from .numbers import clamp, round_to, percent_of',
    'from .lists import chunk, unique, flatten',
    'from .dates import days_between, is_weekend, month_name',
    '',
    '__all__ = [',
    '    "slugify",',
    '    "truncate",',
    '    "word_wrap",',
    '    "clamp",',
    '    "round_to",',
    '    "percent_of",',
    '    "chunk",',
    '    "unique",',
    '    "flatten",',
    '    "days_between",',
    '    "is_weekend",',
    '    "month_name",',
    ']'
  ])

  write(path.join(pkg, 'text.py'), [
    '"""Text helpers. Each function is described precisely by its checks."""',
    '',
    '',
    'def slugify(text):',
    '    """Lowercase, spaces to hyphens, punctuation dropped, no repeated hyphens."""',
    '    raise NotImplementedError',
    '',
    '',
    'def truncate(text, limit):',
    '    """Cut to limit characters, ending with a single ellipsis when cut."""',
    '    raise NotImplementedError',
    '',
    '',
    'def word_wrap(text, width):',
    '    """Split into lines of at most width characters, never breaking a word."""',
    '    raise NotImplementedError'
  ])

  write(path.join(pkg, 'numbers.py'), [
    '"""Numeric helpers. Each function is described precisely by its checks."""',
    '',
    '',
    'def clamp(value, low, high):',
    '    """Hold value inside the range, raising ValueError when low is above high."""',
    '    raise NotImplementedError',
    '',
    '',
    'def round_to(value, step):',
    '    """Round to the nearest multiple of step, with halves going up."""',
    '    raise NotImplementedError',
    '',
    '',
    'def percent_of(part, whole):',
    '    """Whole percent of whole that part represents, raising ValueError on zero."""',
    '    raise NotImplementedError'
  ])

  write(path.join(pkg, 'lists.py'), [
    '"""List helpers. Each function is described precisely by its checks."""',
    '',
    '',
    'def chunk(items, size):',
    '    """Split into lists of at most size, raising ValueError when size is below one."""',
    '    raise NotImplementedError',
    '',
    '',
    'def unique(items):',
    '    """Drop duplicates, keeping first appearance order."""',
    '    raise NotImplementedError',
    '',
    '',
    'def flatten(items):',
    '    """Flatten one level only, leaving deeper nesting alone."""',
    '    raise NotImplementedError'
  ])

  write(path.join(pkg, 'dates.py'), [
    '"""Date helpers, using only the standard library."""',
    '',
    'import datetime',
    '',
    '',
    'def days_between(first, second):',
    '    """Whole days between two dates, never negative."""',
    '    raise NotImplementedError',
    '',
    '',
    'def is_weekend(day):',
    '    """True for Saturday and Sunday."""',
    '    raise NotImplementedError',
    '',
    '',
    'def month_name(number):',
    '    """English month name for 1 to 12, raising ValueError otherwise."""',
    '    raise NotImplementedError'
  ])

  write(path.join(root, 'test_toolkit.py'), [
    '"""Twenty-two checks over twelve functions. Do not change this file."""',
    '',
    'import datetime',
    'import toolkit',
    '',
    'checks = 0',
    '',
    '',
    'def check(ok, what):',
    '    global checks',
    '    assert ok, "FAILED: " + what',
    '    checks += 1',
    '    print("OK: " + what)',
    '',
    '',
    'def raises_value_error(fn, *args):',
    '    """True only for ValueError - an unimplemented function must not count."""',
    '    try:',
    '        fn(*args)',
    '    except ValueError:',
    '        return True',
    '    except NotImplementedError:',
    '        return False',
    '    return False',
    '',
    '',
    '# --- text ---------------------------------------------------------------',
    'check(toolkit.slugify("Hello, World!") == "hello-world", "slugify lowercases and hyphenates")',
    'check(toolkit.slugify("a  --  b") == "a-b", "slugify collapses repeated hyphens")',
    `check(toolkit.truncate("abcdefghij", 5) == "abcd${ELLIPSIS}", "truncate ends with one ellipsis")`,
    'check(toolkit.truncate("abc", 10) == "abc", "truncate leaves short text alone")',
    'check(',
    '    toolkit.word_wrap("the quick brown fox", 10) == ["the quick", "brown fox"],',
    '    "word_wrap never breaks a word",',
    ')',
    '',
    '# --- numbers ------------------------------------------------------------',
    'check(toolkit.clamp(5, 1, 3) == 3, "clamp holds the upper bound")',
    'check(toolkit.clamp(0, 1, 3) == 1, "clamp holds the lower bound")',
    'check(raises_value_error(toolkit.clamp, 1, 3, 2), "clamp rejects an inverted range")',
    'check(toolkit.round_to(7, 5) == 5, "round_to rounds down to the nearest step")',
    'check(toolkit.round_to(7.5, 5) == 10, "round_to sends a half upward")',
    'check(toolkit.percent_of(1, 4) == 25, "percent_of returns whole percent")',
    'check(raises_value_error(toolkit.percent_of, 1, 0), "percent_of rejects a zero whole")',
    '',
    '# --- lists --------------------------------------------------------------',
    'check(toolkit.chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]], "chunk splits into sizes")',
    'check(raises_value_error(toolkit.chunk, [1], 0), "chunk rejects a size below one")',
    'check(toolkit.unique([3, 1, 3, 2, 1]) == [3, 1, 2], "unique keeps first appearance order")',
    'check(toolkit.flatten([[1, 2], [3], [[4]]]) == [1, 2, 3, [4]], "flatten goes one level only")',
    '',
    '# --- dates --------------------------------------------------------------',
    'check(',
    '    toolkit.days_between(datetime.date(2026, 1, 1), datetime.date(2026, 1, 11)) == 10,',
    '    "days_between counts whole days",',
    ')',
    'check(',
    '    toolkit.days_between(datetime.date(2026, 1, 11), datetime.date(2026, 1, 1)) == 10,',
    '    "days_between is never negative",',
    ')',
    'check(toolkit.is_weekend(datetime.date(2026, 8, 30)), "is_weekend knows Sunday")',
    'check(not toolkit.is_weekend(datetime.date(2026, 8, 31)), "is_weekend knows Monday")',
    'check(toolkit.month_name(3) == "March", "month_name names a month")',
    'check(raises_value_error(toolkit.month_name, 13), "month_name rejects an impossible month")',
    '',
    'print("ALL CHECKS PASSED (%d)" % checks)'
  ])
}

function write(file, rows) {
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf-8')
}
