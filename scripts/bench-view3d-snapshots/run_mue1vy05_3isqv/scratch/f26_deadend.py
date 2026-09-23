"""Probe: corridor dead-end tiles as door spots.

A door at the far tip of a corridor leg (the floor tile adjacent to the
destination room, with no floor beyond) blocks nothing: no floor lies past
it. Verify per seed/depth that at least one such spot exists, that it is a
'.', and that making it a shut door ('+') leaves every '.' reachable.
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


def dead_end_spots(rooms):
    """Far tips of each corridor leg, as computed by the generator."""
    spots = []
    for (ax, ay, aw, ah), (bx, by, bw, bh) in zip(rooms, rooms[1:]):
        x1, y1 = ax + aw // 2, ay + ah // 2
        x2, y2 = bx + bw // 2, by + bh // 2
        if x1 != x2:  # horizontal leg at y1, then vertical leg at x2
            ex = bx if x2 > x1 else bx + bw - 1
            spots.append((ex, y1))          # end of the horizontal leg
            spots.append((x2, by if y2 > y1 else by + bh - 1))
        elif y1 != y2:  # vertical leg at x1, then horizontal leg at y2
            spots.append((x1, by if y2 > y1 else by + bh - 1))
            spots.append((bx if x2 > x1 else bx + bw - 1, y2))
    return spots


bad = 0
for seed in (1, 2, 3, 7, 11, 42, 99):
    for depth in (1, 2, 3, 4, 5):
        g = Game(seed, start_depth=depth)
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        p = g.state()['player']
        start = (p['x'], p['y'])
        total = sum(row.count('.') for row in tiles)
        base = reachable(tiles, w, h, start)
        assert len(base) == total, f"baseline broken seed {seed} d{depth}"
        spots = [s for s in dead_end_spots(g._rooms)
                 if tiles[s[1]][s[0]] == '.' and s != start
                 and len(reachable(tiles, w, h, start, blocked={s})) == total]
        if not spots:
            bad += 1
            print(f"seed {seed} d{depth}: NO SAFE SPOT (total={total})")
        else:
            print(f"seed {seed} d{depth}: ok, {len(spots)} safe spots, "
                  f"first={spots[0]}")
print("bad:", bad)
