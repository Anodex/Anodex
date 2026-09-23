"""One-off: does the current engine have any door support?"""
import re
import sys

sys.path.insert(0, '.')
src = open('engine.py').read()
lines = src.splitlines()
for pat in ('door', "'+'", "'/'", "'open'", "'close'", "'open' ", "toggle"):
    hits = [i + 1 for i, l in enumerate(lines) if re.search(pat, l)]
    print(repr(pat), '->', hits[:30])
