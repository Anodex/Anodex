"""Probe: are corridor entrance tiles safe door spots?

The journal's design puts a door on an interior room's SECOND corridor
entrance. The corridor chain is a tree, but the entrance tile lies inside
the room's rectangle, so it may still be on a cycle (the room is >= 6x4
and wraps around the corridor leg). Verify per seed/depth: for each room,
compute its corridor entrances, check each is '.', check whether removing
it (turning it into a non-'.' door tile) still leaves every '.' reachable
from the player start. Report how many entrances are safe.
"""
import sys
sys.path.insert(0, '.')
from collections import deque
from engine import Game


def reachable(tiles, w, h, start, blocked):
    seen = {start}
    q = deque([start])
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nx, ny = cx + dx, cy + dy
            if (0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen
                    and tiles[ny][nx] == '.' and (nx, ny) not in blocked):
                seen.add((nx, ny))
                q.append((nx, ny))
    return seen


def corridor_entrance(room, other):
    """Floor tile inside `room` where the corridor leg to `other` starts:
    the first '.' tile the leg writes that lies within room's rectangle,
    scanning the leg from the room's center outward. Returns None if the
    leg leaves the room through its edge without an interior '.'."""
    x, y, w, h = room
    x1, y1 = x + w // 2, y + h // 2
    x2, y2 = other[0] + other[2] // 2, other[1] + other[3] // 2
    if x1 != x2:
        # horizontal leg at y1, then vertical leg at x2
        step = 1 if x2 > x1 else -1
        for tx in range(x1 + step, x2, step):
            if x <= tx < x + w and y <= y1 < y + h:
                return (tx, y1)
        return None
    if y1 != y2:
        step = 1 if y2 > y1 else -1
        for ty in range(y1 + step, y2, step):
            if x <= x1 < x + w and y <= ty < y + h:
                return (x1, ty)
    return None


bad = 0
checked = 0
for seed in (1, 2, 3, 7, 11, 42, 99):
    for depth in (1, 2, 3, 4, 5):
        g = Game(seed, start_depth=depth)
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        p = g.state()['player']
        start = (p['x'], p['y'])
        base = reachable(tiles, w, h, start, frozenset())
        total = sum(row.count('.') for row in tiles)
        if len(base) != total:
            print(f"seed={seed} d={depth}: BASELINE already broken "
                  f"{len(base)}/{total}")
            bad += 1
            continue
        rooms = g._rooms
        safe = 0
        total_entr = 0
        for i, room in enumerate(rooms):
            for j, other in enumerate(rooms):
                if i == j:
                    continue
                e = corridor_entrance(room, other)
                if e is None or tiles[e[1]][e[0]] != '.':
                    continue
                total_entr += 1
                r = reachable(tiles, w, h, start, frozenset({e}))
                if len(r) == total - 1:
                    safe += 1
                else:
                    print(f"seed={seed} d={depth}: entrance {e} of room "
                          f"{room} SEVERS ({len(r)}/{total - 1})")
                    bad += 1
        print(f"seed={seed} d={depth}: rooms={len(rooms)} "
              f"entrances={total_entr} safe={safe}")

print(f"\nlevels checked, bad: {bad}")
