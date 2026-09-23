"""Probe for feature 26 (doors) placement.

A door tile ('+' shut or '/' open) is not a '.' tile, and feature 5's test
BFS walks only '.' — so a door may sit only on a non-bridge floor tile:
one whose removal leaves every other '.' reachable (i.e. it lies on a
cycle). Corridor-chain tiles are all bridges; room interiors are full of
cycle tiles. This probe replicates the engine's map build, picks one safe
door tile per room, and re-runs feature 5's exact reachability check.
"""
import random
from collections import deque


def build_rooms(seed, depth):
    rng = random.Random(seed * 100003 + depth)
    width, height = 80, 24
    tiles = [['#'] * width for _ in range(height)]
    rooms = []
    attempts = 0
    while len(rooms) < 3 and attempts < 200:
        attempts += 1
        w = rng.randint(6, 16)
        h = rng.randint(4, 8)
        x = rng.randint(1, width - w - 1)
        y = rng.randint(1, height - h - 1)
        if any(x < rx + rw + 2 and x + w + 2 > rx and
               y < ry + rh + 2 and y + h + 2 > ry
               for rx, ry, rw, rh in rooms):
            continue
        rooms.append((x, y, w, h))
        for ty in range(y, y + h):
            for tx in range(x, x + w):
                tiles[ty][tx] = '.'
    for (ax, ay, aw, ah), (bx, by, bw, bh) in zip(rooms, rooms[1:]):
        x1, y1 = ax + aw // 2, ay + ah // 2
        x2, y2 = bx + bw // 2, by + bh // 2
        xs = range(min(x1, x2), max(x1, x2) + 1)
        ys = range(min(y1, y2), max(y1, y2) + 1)
        for tx in xs:
            tiles[y1][tx] = '.'
        for ty in ys:
            tiles[ty][x2] = '.'
    # Stairs in the last room's centre; ladder in room 0's top-left corner.
    lx, ly, lw, lh = rooms[-1]
    tiles[ly + lh // 2][lx + lw // 2] = '>'
    sx, sy = rooms[0][0], rooms[0][1]
    tiles[sy][sx] = '<'
    px = rooms[0][0] + rooms[0][2] // 2
    py = rooms[0][1] + rooms[0][3] // 2
    return tiles, rooms, width, height, (px, py), (sx, sy)


def reachable(tiles, start):
    seen = {start}
    q = deque([start])
    h = len(tiles)
    w = len(tiles[0])
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.' \
                    and (nx, ny) not in seen:
                seen.add((nx, ny))
                q.append((nx, ny))
    return seen


def is_bridge(tiles, start, x, y):
    """True if removing (x,y) severs the '.' graph."""
    total = sum(row.count('.') for row in tiles)
    seen = reachable(tiles, start)
    if len(seen) != total:
        return True  # baseline already broken
    tiles[y][x] = '#'
    seen2 = reachable(tiles, start)
    tiles[y][x] = '.'
    # (x,y) itself drops out of the count when blocked.
    return len(seen2) != total - 1


def pick_doors(tiles, rooms, start, ladder):
    """One safe (non-bridge) door tile per room: the room's centre if it is
    safe and free, else the first safe free interior tile in row-major order.
    'Free' = '.', not the player start, not the ladder."""
    doors = []
    taken = set()
    for (x, y, w, h) in rooms:
        candidates = []
        cx, cy = x + w // 2, y + h // 2
        candidates.append((cx, cy))
        for ty in range(y, y + h):
            for tx in range(x, x + w):
                if (tx, ty) != (cx, cy):
                    candidates.append((tx, ty))
        for cand in candidates:
            cx2, cy2 = cand
            if (cx2, cy2) in taken:
                continue
            if tiles[cy2][cx2] != '.':
                continue
            if cand == start or cand == ladder:
                continue
            if is_bridge(tiles, start, cx2, cy2):
                continue
            taken.add(cand)
            doors.append(cand)
            break
    return doors


bad = 0
levels = 0
no_door_levels = 0
for seed in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 42, 99, 1000):
    for depth in range(1, 6):
        tiles, rooms, w, h, start, ladder = build_rooms(seed, depth)
        if len(rooms) < 3:
            continue
        levels += 1
        # baseline must hold
        seen0 = reachable(tiles, start)
        total0 = sum(row.count('.') for row in tiles)
        if len(seen0) != total0:
            bad += 1
            print(f"BASELINE FAIL seed={seed} d={depth} {len(seen0)}/{total0}")
            continue
        doors = pick_doors(tiles, rooms, start, ladder)
        if len(doors) < 2:
            no_door_levels += 1
            print(f"FEW DOORS seed={seed} d={depth} doors={doors}")
        for (dx, dy) in doors:
            tiles[dy][dx] = '+'
        seen1 = reachable(tiles, start)
        total1 = sum(row.count('.') for row in tiles)
        if len(seen1) != total1:
            bad += 1
            print(f"DOOR SEVERS seed={seed} d={depth} {len(seen1)}/{total1} "
                  f"doors={doors}")
        # also confirm no door landed on a non-'.' in the ORIGINAL map
        print(f"seed={seed} d={depth} rooms={len(rooms)} doors={len(doors)}",
              end='  ')
print()
print(f"levels={levels} failures={bad} levels_with_few_doors={no_door_levels}")
