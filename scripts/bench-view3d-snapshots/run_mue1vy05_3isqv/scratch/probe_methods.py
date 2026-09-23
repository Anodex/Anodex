import re
src = open('engine.py', encoding='utf-8').read().splitlines()
for i, l in enumerate(src, 1):
    if re.match(r'\s+def ', l) or re.match(r'\s+self\._\w+ =', l) and i < 60:
        pass
print('--- all defs ---')
for i, l in enumerate(src, 1):
    if re.match(r'\s+def ', l):
        print(i, l)
print('--- self attrs assigned in __init__ area ---')
ininit = False
for i, l in enumerate(src, 1):
    if 'def __init__' in l:
        ininit = True
    if ininit and l.strip() and not l.startswith(' ') and 'def' in l and 'def __init__' not in l:
        break
    if ininit:
        s = l.strip()
        if s.startswith('self._'):
            print(i, s)
