import re
import sys

path = sys.argv[1]
pattern = sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 8
txt = open(path, encoding="utf-8").read()
for m in list(re.finditer(pattern, txt, re.I))[:limit]:
    print("----")
    print(txt[max(0, m.start() - 200):m.end() + 300])
