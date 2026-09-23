import re
import sys

sys.path.insert(0, '.')
src = open('engine.py').read()
lines = src.splitlines()
print('engine.py lines:', len(lines))
for pat in ('door', "'+'", "'/'", "'open'", "'close'", "toggle"):
    hits = [i + 1 for i, l in enumerate(lines) if re.search(pat, l)]
    print(f'{pat!r} -> {hits[:25]}')
