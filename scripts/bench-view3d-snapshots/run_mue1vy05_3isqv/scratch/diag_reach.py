"""Probe: after the border-door edit, is every floor tile still reachable?
Report any seed/depth where a '.' tile is cut off, and show the door tiles.
"""
import sys
from collections import deque
sys.path.insert(0, '.')
from engine import Game


def reachable(g):
    tiles = g.state()['map']['tiles']
    h = len(tiles)
    w = len(tiles[0])
    p = g.state()['player']
    seen = {(p['x'], p['y'])}
    q = deque([(p['x'], p['y'])])
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen:
                if tiles[ny][nx] in ('.', '>', '<'):
                    seen.add((nx, ny))
                    q.append((nx, ny))
    floors = [(x, y) for y in range(h) for x in range(w) if tiles[y][x] == '.']
    return sorted(set(floors) - seen), h, w


bad = 0
for seed in range(1, 60):
    for depth in (1, 2, 5):
        g = Game(seed, start_depth=depth)
        tiles = g.state()['map']['tiles']
        unreachable, h, w = reachable(g)
        if unreachable:
            bad += 1
            doors = [(x, y) for y in range(h) for x in range(w)
                     if tiles[y][x] == '+']
            print(f"seed {seed} depth {depth}: {len(unreachable)} unreachable "
                  f"floors, doors={doors}")
            print(f"   first unreachable: {unreachable[:5]}")
print("BAD:", bad)
