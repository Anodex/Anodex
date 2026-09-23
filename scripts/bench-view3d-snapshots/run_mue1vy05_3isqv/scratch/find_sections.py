import re

lines = open("engine.py", encoding="utf-8").read().splitlines()
pat = re.compile(r"\bdef \b|potion|scroll|inventory|identified|_names|appearance", re.I)
for i, l in enumerate(lines, 1):
    if pat.search(l):
        print(i, l.rstrip()[:115])
