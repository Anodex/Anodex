import sys

path, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
lines = open(path, encoding="utf-8").read().splitlines()
for i in range(start, min(end, len(lines)) + 1):
    print(i, lines[i - 1])
