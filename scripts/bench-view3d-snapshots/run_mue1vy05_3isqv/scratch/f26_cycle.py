"""Probe: which corridor tiles lie on a cycle (removable without severing)?

Feature 26 needs a door tile whose removal keeps every '.' reachable.
Enumerate all '.' tiles per seed/depth, remove each, run a '.'-only BFS from
the player start, and count the removable ones. Also report, for the
first-room->second-room corridor, whether the leg tiles are on a cycle.
"""
import sys
sys.path.insert(0, '.')
from collections import deque
from engine import Game


def reachable(tiles, w, h, start, blocked=frozenset()):
    seen = {start}
    q = deque([start])
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen \
                    and tiles[ny][nx] == '.' and (nx, ny) not in blocked:
                seen.add((nx, ny))
                q.append((nx, ny))
    return seen


for seed in (1, 2, 3, 7, 11, 42, 99):
    for depth in (1, 2, 3, 4, 5):
        g = Game(seed, start_depth=depth)
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        p = g.state()['player']
        start = (p['x'], p['y'])
        base = reachable(tiles, w, h, start)
        total = sum(row.count('.') for row in tiles)
        if len(base) != total:
            print(f"seed {seed} d{depth}: BASELINE BROKEN {len(base)}/{total}")
            continue
        removable = []
        for y in range(h):
            for x in range(w):
                if tiles[y][x] != '.' or (x, y) == start:
                    continue
                # The blocked tile itself drops out of the count, so a
                # removable tile leaves exactly total - 1 reachable.
                if len(reachable(tiles, w, h, start, blocked={(x, y)})) == total - 1:
                    removable.append((x, y))
        print(f"seed {seed} d{depth}: {total} floor, "
              f"{len(removable)} removable (on a cycle)")
