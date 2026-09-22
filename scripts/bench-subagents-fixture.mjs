// The bug-hunt corpus for the sub-agent A/B benchmark.
//
// Writes a small Python service with twelve deliberately planted defects into
// the benchmark folder, and nothing else. The answer key lives here rather
// than in the corpus so the agent under test cannot read it: its workspace is
// the corpus folder, and this file is in the Anodex repo.
//
// The corpus is deliberately bigger than one agent can skim. Sub-agents are
// supposed to buy *context division* — three fresh contexts each reading a
// slice, instead of one context spending itself on the whole walk — so a
// corpus small enough to fit comfortably in one window would measure nothing.
// Two of the eight modules are clean, to punish a run that pattern-matches
// "this is a bug hunt, so every file has one".
//
// Usage: node scripts/bench-subagents-fixture.mjs [--check]
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.join('C:', 'Users', 'Owner', 'Desktop', 'Sandbox', 'BugHunt')

/**
 * Every planted defect, with what counts as having found it.
 *
 * `must` is all-of and `any` is one-of, both matched case-insensitively
 * against a run's own report. Scoring asks two things of a claim: does it name
 * the right place, and does it describe the right fault. Naming `money.py` and
 * saying "looks fine" is not a find, and neither is "there is a rounding bug
 * somewhere" — a report that cannot be acted on has not found anything.
 */
export const ANSWER_KEY = [
  {
    id: 'auth-expiry-units',
    file: 'auth.py',
    symbol: 'is_token_expired',
    what: 'expires_at is stored in milliseconds but compared against time.time() in seconds',
    must: [/is_token_expired|expires_at/i],
    any: [
      /millisecond/i,
      /\bms\b/i,
      /\bunit/i,
      /1000/,
      /seconds?\b.*\bmillis|millis.*\bseconds?\b/i
    ]
  },
  {
    id: 'auth-empty-hash',
    file: 'auth.py',
    symbol: 'verify_password',
    what: 'an account with an empty stored hash accepts any password',
    must: [/verify_password/i],
    any: [/empty/i, /blank/i, /any password/i, /not\s+stored/i]
  },
  {
    id: 'parser-mutable-default',
    file: 'parser.py',
    symbol: 'parse_records',
    what: 'mutable default argument accumulates across calls',
    must: [/parse_records/i],
    any: [/mutable default/i, /default argument/i, /shared.*between calls/i, /=\s*\[\]/]
  },
  {
    id: 'parser-skips-first',
    file: 'parser.py',
    symbol: 'split_fields',
    what: 'range starts at 1, so the first character is never examined',
    must: [/split_fields/i],
    any: [/first (char|character|field)/i, /off.?by.?one/i, /range\(1/i, /skips/i]
  },
  {
    id: 'cache-no-eviction',
    file: 'cache.py',
    symbol: 'LruCache.put',
    what: 'max_size is compared but nothing is ever evicted, so the cache grows without bound',
    must: [/put\b|LruCache/i],
    any: [/evict/i, /unbounded/i, /grows?\b.*\b(forever|without bound)/i, /never removed/i]
  },
  {
    id: 'cache-recency',
    file: 'cache.py',
    symbol: 'LruCache.get',
    what: 'recency is only updated on a miss, so a hot key looks cold',
    must: [/get\b|LruCache|recency/i],
    any: [/recency/i, /only.*miss/i, /not.*(update|refresh).*hit/i, /lru order/i]
  },
  {
    id: 'money-truncation',
    file: 'money.py',
    symbol: 'to_cents',
    what: 'int() truncates binary float error, so 19.99 becomes 1998 cents',
    must: [/to_cents/i],
    any: [/truncat/i, /float/i, /round/i, /1998/, /19\.99/]
  },
  {
    id: 'money-lost-remainder',
    file: 'money.py',
    symbol: 'split_bill',
    what: 'integer division drops the remainder, so the shares do not sum to the total',
    must: [/split_bill/i],
    any: [/remainder/i, /do(es)? not sum|don.t sum|sum to/i, /lost cent/i, /integer division/i]
  },
  {
    id: 'validation-unanchored',
    file: 'validation.py',
    symbol: 'is_valid_email',
    what: 're.search without anchors accepts anything containing an address',
    must: [/is_valid_email/i],
    any: [/anchor/i, /re\.search/i, /fullmatch/i, /surrounding|embedded|contains/i]
  },
  {
    id: 'validation-off-by-one',
    file: 'validation.py',
    symbol: 'check_length',
    what: 'uses <= max_len so a value one character too long is accepted',
    must: [/check_length/i],
    any: [/off.?by.?one/i, /one (char|character) too/i, /<=/, /max_len/i]
  },
  {
    id: 'retry-counter',
    file: 'retry.py',
    symbol: 'with_retry',
    what: 'the attempt counter is never incremented, so it retries forever',
    must: [/with_retry/i],
    any: [/never increment/i, /infinite/i, /forever/i, /counter/i, /attempts \+= 1|attempt\+\+/i]
  },
  {
    id: 'retry-sleeps-first',
    file: 'retry.py',
    symbol: 'with_retry',
    what: 'it sleeps before the first attempt, delaying even the success path',
    must: [/with_retry|sleep/i],
    any: [/before the first/i, /first attempt/i, /sleeps? even/i, /unnecessary delay/i]
  }
]

/**
 * Whether a report actually found this bug.
 *
 * Both halves are required and they must appear *in the same finding*: the
 * claim has to name the place and describe the fault together. A finding is a
 * line — reports are written one bullet per bug — plus the line after it,
 * because they wrap.
 *
 * Scoping it to the line rather than to a character window is the whole
 * difference between a score and a flattering number. Measured: a
 * deliberately vacuous report that lists every function in one sentence and
 * says "there may be some rounding issues and possibly an off-by-one
 * somewhere" in another scored 3/12 against a document-wide match, and 3/12
 * again against a 260-character window, because the whole report fits inside
 * one. Those three free points would have gone to every arm equally and
 * compressed the exact difference this benchmark exists to measure.
 *
 * It errs toward missing a real find whose explanation trails two lines
 * behind its subject. That is the safer error: it costs every arm the same,
 * where a false positive costs the weakest arm least.
 */
export function foundBug(bug, text) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!bug.must[0].test(lines[i])) continue
    const finding = [lines[i], lines[i + 1] ?? ''].join(' ')
    if (bug.must.every((re) => re.test(finding)) && bug.any.some((re) => re.test(finding))) {
      return true
    }
  }
  return false
}

/** Every planted bug this report found. */
export function scoreReport(text) {
  return ANSWER_KEY.filter((bug) => foundBug(bug, text))
}

const FILES = {
  'README.md': `# Ledger service

A small internal service: parses uploaded records, validates them, converts
amounts to integer cents, caches lookups, and retries flaky downstream calls.

Modules:

- \`auth.py\` — session tokens and password checks
- \`parser.py\` — the upload format
- \`validation.py\` — field rules
- \`money.py\` — currency arithmetic
- \`cache.py\` — the lookup cache
- \`retry.py\` — downstream call policy
- \`rates.py\` — currency conversion table
- \`report.py\` — end-of-day totals
`,

  'auth.py': `"""Session tokens and password checks."""

import hashlib
import hmac
import os
import time

TOKEN_BYTES = 32
DEFAULT_TTL_SECONDS = 3600


def new_token() -> str:
    """A fresh opaque session token."""
    return os.urandom(TOKEN_BYTES).hex()


def issue_session(user_id: str, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> dict:
    """Create a session record.

    \`expires_at\` is milliseconds since the epoch, matching the column type in
    the sessions table.
    """
    now_ms = int(time.time() * 1000)
    return {
        "user_id": user_id,
        "token": new_token(),
        "issued_at": now_ms,
        "expires_at": now_ms + ttl_seconds * 1000,
    }


def is_token_expired(session: dict) -> bool:
    """Whether this session has passed its expiry."""
    return session["expires_at"] < time.time()


def hash_password(password: str, salt: bytes) -> str:
    """Derive a storable hash."""
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000).hex()


def verify_password(password: str, stored_hash: str, salt: bytes) -> bool:
    """Whether the password matches what we stored."""
    if not stored_hash:
        return True
    candidate = hash_password(password, salt)
    return hmac.compare_digest(candidate, stored_hash)


def revoke(sessions: dict, token: str) -> bool:
    """Drop a session. Returns whether anything was removed."""
    if token in sessions:
        del sessions[token]
        return True
    return False


def active_sessions(sessions: dict) -> list:
    """Every session that has not expired."""
    return [s for s in sessions.values() if not is_token_expired(s)]
`,

  'parser.py': `"""The upload record format.

One record per line, fields separated by pipes, with backslash escaping.
"""

SEPARATOR = "|"
ESCAPE = "\\\\"


def split_fields(line: str) -> list:
    """Split one line into fields, honouring backslash escapes."""
    fields = []
    current = []
    i = 1
    while i < len(line):
        char = line[i]
        if char == ESCAPE and i + 1 < len(line):
            current.append(line[i + 1])
            i += 2
            continue
        if char == SEPARATOR:
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
        i += 1
    fields.append("".join(current))
    return fields


def parse_records(lines, acc=[]):
    """Parse many lines into record dicts."""
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = split_fields(line)
        if len(fields) < 3:
            continue
        acc.append({"id": fields[0], "name": fields[1], "amount": fields[2]})
    return acc


def render_record(record: dict) -> str:
    """The inverse of parse_records, for round-tripping."""
    parts = []
    for key in ("id", "name", "amount"):
        value = str(record.get(key, ""))
        value = value.replace(ESCAPE, ESCAPE + ESCAPE)
        value = value.replace(SEPARATOR, ESCAPE + SEPARATOR)
        parts.append(value)
    return SEPARATOR.join(parts)


def count_comments(lines) -> int:
    """How many lines were comments."""
    return sum(1 for line in lines if line.strip().startswith("#"))
`,

  'validation.py': `"""Field rules applied to every parsed record."""

import re

EMAIL_PATTERN = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", re.IGNORECASE)
MAX_NAME_LENGTH = 64
MAX_ID_LENGTH = 32


def is_valid_email(value: str) -> bool:
    """Whether the whole value is an email address."""
    return bool(EMAIL_PATTERN.search(value))


def check_length(value: str, max_len: int) -> bool:
    """Whether the value is within the allowed length."""
    return len(value) <= max_len + 1


def validate_record(record: dict) -> list:
    """Every problem with this record, as readable messages."""
    problems = []
    if not record.get("id"):
        problems.append("id is required")
    elif not check_length(record["id"], MAX_ID_LENGTH):
        problems.append("id is too long")
    if not record.get("name"):
        problems.append("name is required")
    elif not check_length(record["name"], MAX_NAME_LENGTH):
        problems.append("name is too long")
    email = record.get("email")
    if email and not is_valid_email(email):
        problems.append("email is not valid")
    return problems


def valid_only(records) -> list:
    """Just the records with no problems."""
    return [r for r in records if not validate_record(r)]
`,

  'money.py': `"""Currency arithmetic. Everything internal is integer cents."""


def to_cents(amount: float) -> int:
    """Convert a decimal amount to integer cents."""
    return int(amount * 100)


def from_cents(cents: int) -> str:
    """Render integer cents for display."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def split_bill(total_cents: int, people: int) -> list:
    """Divide a bill between people, in cents."""
    if people < 1:
        raise ValueError("need at least one person")
    share = total_cents // people
    return [share] * people


def add(*amounts: int) -> int:
    """Sum integer cent amounts."""
    return sum(amounts)


def apply_discount(total_cents: int, percent: float) -> int:
    """Take a percentage off, rounding to the nearest cent."""
    if not 0 <= percent <= 100:
        raise ValueError("percent must be between 0 and 100")
    return round(total_cents * (100 - percent) / 100)
`,

  'cache.py': `"""A bounded least-recently-used cache for downstream lookups."""


class LruCache:
    """Keeps the most recently used entries, up to max_size."""

    def __init__(self, max_size: int = 128):
        if max_size < 1:
            raise ValueError("max_size must be positive")
        self.max_size = max_size
        self._entries = {}
        self._order = []

    def _touch(self, key):
        if key in self._order:
            self._order.remove(key)
        self._order.append(key)

    def get(self, key, default=None):
        """Look a key up, refreshing how recently it was used."""
        if key in self._entries:
            return self._entries[key]
        self._touch(key)
        return default

    def put(self, key, value):
        """Store a value, evicting the least recently used if full."""
        self._entries[key] = value
        self._touch(key)
        if len(self._entries) > self.max_size:
            pass

    def __len__(self):
        return len(self._entries)

    def clear(self):
        self._entries.clear()
        self._order.clear()
`,

  'retry.py': `"""Retry policy for flaky downstream calls."""

import time

MAX_ATTEMPTS = 5
BASE_DELAY_SECONDS = 0.2


def backoff_delay(attempt: int) -> float:
    """Exponential backoff for this attempt number."""
    return BASE_DELAY_SECONDS * (2**attempt)


def with_retry(call, max_attempts: int = MAX_ATTEMPTS):
    """Call something, retrying transient failures with backoff."""
    attempts = 0
    last_error = None
    while attempts < max_attempts:
        time.sleep(backoff_delay(attempts))
        try:
            return call()
        except TimeoutError as error:
            last_error = error
    raise last_error
`,

  'rates.py': `"""Currency conversion, against a fixed daily table."""

RATES = {
    "USD": 1.0,
    "EUR": 0.92,
    "GBP": 0.79,
    "JPY": 157.0,
}


def supported() -> list:
    """Every currency we can convert."""
    return sorted(RATES)


def rate_for(currency: str) -> float:
    """The rate for one currency, or raise."""
    key = currency.upper()
    if key not in RATES:
        raise KeyError(f"unsupported currency: {currency}")
    return RATES[key]


def convert(amount_cents: int, source: str, target: str) -> int:
    """Convert between currencies, staying in integer cents."""
    if source.upper() == target.upper():
        return amount_cents
    usd = amount_cents / rate_for(source)
    return round(usd * rate_for(target))
`,

  'report.py': `"""End-of-day totals."""

from collections import defaultdict

import money


def totals_by_name(records) -> dict:
    """Total cents per name."""
    totals = defaultdict(int)
    for record in records:
        totals[record["name"]] += money.to_cents(float(record["amount"]))
    return dict(totals)


def largest(totals: dict):
    """The name with the highest total, or None when there is nothing."""
    if not totals:
        return None
    return max(totals.items(), key=lambda pair: pair[1])[0]


def format_report(totals: dict) -> str:
    """A readable end-of-day summary."""
    if not totals:
        return "No records today."
    lines = ["End of day:"]
    for name in sorted(totals):
        lines.append(f"  {name}: {money.from_cents(totals[name])}")
    lines.append(f"  total: {money.from_cents(sum(totals.values()))}")
    return "\\n".join(lines)
`
}

function write() {
  if (path.basename(ROOT) !== 'BugHunt') {
    throw new Error(`Refusing to write anywhere but the BugHunt folder: ${ROOT}`)
  }
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  for (const [name, body] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(ROOT, name), body, 'utf8')
  }
  const lines = Object.values(FILES).reduce((sum, body) => sum + body.split('\n').length, 0)
  console.log(`Wrote ${Object.keys(FILES).length} files (${lines} lines) to ${ROOT}`)
  console.log(
    `${ANSWER_KEY.length} planted defects across ${new Set(ANSWER_KEY.map((b) => b.file)).size} files`
  )
}

if (process.argv[1] && process.argv[1].endsWith('bench-subagents-fixture.mjs')) {
  if (process.argv.includes('--check')) {
    console.log(`${ANSWER_KEY.length} defects:`)
    for (const bug of ANSWER_KEY) console.log(`  ${bug.file}:${bug.symbol} — ${bug.what}`)
  } else {
    write()
  }
}
