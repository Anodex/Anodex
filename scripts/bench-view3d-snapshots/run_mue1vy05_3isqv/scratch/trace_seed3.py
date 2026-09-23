"""Find the unreachable region in seed 3: which room, and what blocks it?"""
import sys
from collections import deque
sys.path.insert(0, '.')
from engine import Game

g = Game(3)
tiles = g.state()['map']['tiles']
h = len(tiles)
w = len(tiles[0])
p = g.state()['player']

# BFS like test 5: only '.'
seen = {(p['x'], p['y'])}
q = deque([(p['x'], p['y'])])
while q:
    x, y = q.popleft()
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.' and (nx, ny) not in seen:
            seen.add((nx, ny))
            q.append((nx, ny))

unreach = sorted((x, y) for y in range(h) for x in range(w)
                 if tiles[y][x] == '.' and (x, y) not in seen)
print(f"unreachable count: {len(unreach)}")

# Cluster: find the bounding box
xs = [u[0] for u in unreach]
ys = [u[1] for u in unreach]
print(f"bbox: x {min(xs)}..{max(xs)}, y {min(ys)}..{max(ys)}")

# Print the region around the bbox, marking unreachable as 'X'
y0, y1 = max(0, min(ys) - 3), min(h - 1, max(ys) + 3)
x0, x1 = max(0, min(xs) - 3), min(w - 1, max(xs) + 3)
for y in range(y0, y1 + 1):
    row = []
    for x in range(x0, x1 + 1):
        c = tiles[y][x]
        if c == '.' and (x, y) not in seen:
            c = 'X'
        row.append(c)
    print(f"y={y:2d}: " + ''.join(row))

print("\ndoors:", [(x, y) for y in range(h) for x in range(w) if tiles[y][x] in '+/'])
print("player:", (p['x'], p['y']))
print("\nrooms:")
for r in g._rooms:
    print("  ", r)
