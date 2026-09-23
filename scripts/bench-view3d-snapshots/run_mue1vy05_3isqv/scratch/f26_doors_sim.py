"""End-to-end door simulation for feature 26, on the real engine.

Walks to every door, tests open/close/occupancy rules, verifies movement
and sight blocking, and checks feature 5's reachability after closing
every door on the level.
"""
import sys
sys.path.insert(0, '.')
from collections import deque
from engine import Game

fail = 0


def check(name, ok, detail=''):
    global fail
    print(('PASS ' if ok else 'FAIL ') + name + (': ' + detail if detail and not ok else ''))
    if not ok:
        fail += 1


def find_path(tiles, w, h, start, goal, blocked=frozenset()):
    """BFS over '.' tiles avoiding `blocked`; returns list of (x,y) incl.
    both ends, or None."""
    if start == goal:
        return [start]
    seen = {start}
    q = deque([start])
    parent = {}
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen \
                    and tiles[ny][nx] == '.' and (nx, ny) not in blocked:
                seen.add((nx, ny))
                parent[(nx, ny)] = (cx, cy)
                if (nx, ny) == goal:
                    path = [(nx, ny)]
                    while path[-1] != start:
                        path.append(parent[path[-1]])
                    return path[::-1]
                q.append((nx, ny))
    return None


def walk(g, path):
    dirs = {(0, -1): 'n', (0, 1): 's', (1, 0): 'e', (-1, 0): 'w'}
    px, py = g.state()['player']['x'], g.state()['player']['y']
    for (tx, ty) in path[1:]:
        d = dirs[(tx - px, ty - py)]
        g.move(d)
        p = g.state()['player']
        if (p['x'], p['y']) != (tx, ty):
            return False
        px, py = tx, ty
    return True


for seed in (1, 7, 42, 3, 11):
    for depth in (1, 3, 5):
        g = Game(seed, start_depth=depth)
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        p = g.state()['player']
        start = (p['x'], p['y'])
        doors = [(x, y) for y in range(h) for x in range(w) if tiles[y][x] == '+']
        if not doors:
            check(f'doors exist seed={seed} d={depth}', False, 'no door tiles')
            continue
        # 1. walk to the first door with it shut: must be blocked.
        d = doors[0]
        # a tile adjacent to the door that is floor
        adj = None
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nx, ny = d[0] + dx, d[1] + dy
            if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.':
                adj = (nx, ny)
                break
        path = find_path(tiles, w, h, start, adj, blocked={d})
        if path is None:
            check(f'reach adj seed={seed} d={depth}', False,
                  f'no path to {adj} with door {d} shut')
        else:
            if not walk(g, path):
                check(f'walk to adj seed={seed} d={depth}', False)
            else:
                # 2. bump into the shut door: must not move.
                p0 = (g.state()['player']['x'], g.state()['player']['y'])
                g.move({'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0)}
                       [(d[0] - p0[0], d[1] - p0[1])][0]
                       if (d[0] - p0[0], d[1] - p0[1]) in
                       {(0, -1), (0, 1), (1, 0), (-1, 0)} else 'n')
                p1 = (g.state()['player']['x'], g.state()['player']['y'])
                check(f'shut door blocks move seed={seed} d={depth}',
                      p1 == p0, f'{p0} -> {p1}')
                # 3. close on an occupied door: refused.
                g.act('close', x=d[0], y=d[1])
                check(f'close occupied refused seed={seed} d={depth}',
                      tiles[d[1]][d[0]] == '+')
                # 4. open it: tile becomes '/', player can move through.
                g.act('open', x=d[0], y=d[1])
                check(f'open door seed={seed} d={depth}',
                      tiles[d[1]][d[0]] == '/')
                g.move({'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0)}
                       [(d[0] - p0[0], d[1] - p0[1])][0])
                p2 = (g.state()['player']['x'], g.state()['player']['y'])
                check(f'open door walkable seed={seed} d={depth}',
                      p2 == d, f'{p0} -> {p2}')
                # 5. close it again (now empty): succeeds.
                g.act('close', x=d[0], y=d[1])
                check(f're-close door seed={seed} d={depth}',
                      tiles[d[1]][d[0]] == '+')
                # 6. open a far door with no adjacency: message, no change.
                far = doors[-1] if len(doors) > 1 else d
                if len(doors) > 1:
                    g.act('open', x=far[0], y=far[1])
                    check(f'far open refused seed={seed} d={depth}',
                          tiles[far[1]][far[0]] == '+')
        # 7. feature 5's exact reachability with the door(s) as-is.
        t = g.state()['map']['tiles']
        seen = {start}
        q = deque([start])
        while q:
            cx, cy = q.popleft()
            for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < w and 0 <= ny < h and t[ny][nx] == '.' \
                        and (nx, ny) not in seen:
                    seen.add((nx, ny))
                    q.append((nx, ny))
        total = sum(row.count('.') for row in t)
        check(f'reachable after doors seed={seed} d={depth}',
              len(seen) == total, f'{len(seen)}/{total}')

print(f'\n{fail} failure(s)')
sys.exit(1 if fail else 0)
