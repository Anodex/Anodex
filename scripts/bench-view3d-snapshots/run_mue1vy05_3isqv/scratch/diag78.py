"""Diagnose feature 7/8 walk failures: is a monster sitting on the BFS path?"""
from collections import deque
from engine import Game

DIRS = {'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0)}


def bfs_path(tiles, w, h, walkable, start, goal):
    prev = {start: None}
    q = deque([start])
    while q and goal not in prev:
        cx, cy = q.popleft()
        for name, (dx, dy) in DIRS.items():
            nx, ny = cx + dx, cy + dy
            if (0 <= nx < w and 0 <= ny < h and walkable(tiles[ny][nx])
                    and (nx, ny) not in prev):
                prev[(nx, ny)] = (cx, cy)
                q.append((nx, ny))
    if goal not in prev:
        return None
    path = [goal]
    node = goal
    while prev[node] is not None:
        node = prev[node]
        path.append(node)
    return path[::-1]


for seed in (3, 42):
    g = Game(seed)
    tiles, w, h = g.state()['map']['tiles'], 80, 24
    start = (g.state()['player']['x'], g.state()['player']['y'])
    print(f"--- seed {seed}: start {start}")

    # feature-7 target: first floor tile >= 20 away (same scan order as tests.py)
    target = None
    for y in range(h):
        for x in range(w):
            if tiles[y][x] == '.' and (x - start[0])**2 + (y - start[1])**2 >= 400:
                target = (x, y)
                break
        if target:
            break
    p7 = bfs_path(tiles, w, h, lambda t: t == '.', start, target)
    if p7:
        blockers = [c for c in p7[1:]
                    if any(m['alive'] and (m['x'], m['y']) == c for m in g._monsters)]
        print(f"  f7 target {target}: path len {len(p7)}, monster-blocked cells: {blockers}")
    else:
        print(f"  f7 target {target}: NO PATH")

    # feature-8 stairs
    stairs = [(x, y) for y in range(h) for x in range(w) if tiles[y][x] == '>']
    p8 = bfs_path(tiles, w, h, lambda t: t in ('.', '>'), start, stairs[0])
    if p8:
        blockers = [c for c in p8[1:]
                    if any(m['alive'] and (m['x'], m['y']) == c for m in g._monsters)]
        print(f"  f8 stairs {stairs[0]}: path len {len(p8)}, monster-blocked cells: {blockers}")
    else:
        print(f"  f8 stairs {stairs[0]}: NO PATH")
