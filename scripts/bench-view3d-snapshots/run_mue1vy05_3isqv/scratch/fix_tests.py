"""One-off: update the stale BFS sets in tests.py for open doors.

Feature 26 put open doors ('/') on the corridor where a leg crosses a room
wall, so the tests that walk only on '.' no longer reach everything.
Replace the walkable sets in features 5, 7, 8 and 25, then append the
feature_26 check and wire it into the run list.
"""
import io

src = io.open('tests.py', encoding='utf-8').read()

repls = [
    # feature_5: BFS over floor only -> floor + open doors.
    ("if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.' \\\n"
     "                        and (nx, ny) not in seen:\n"
     "                    seen.add((nx, ny))",
     "if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] in ('.', '/') \\\n"
     "                        and (nx, ny) not in seen:\n"
     "                    seen.add((nx, ny))"),
    # feature_5: the total must count everything that is walkable, not just
    # '.', or the door tiles themselves would be "unreachable" by count.
    ("        total = sum(row.count('.') for row in tiles)",
     "        # Open doors ('/') are walkable, so they count as reachable\n"
     "        # floor for feature 5's all-floor-reachable guarantee.\n"
     "        total = sum(row.count('.') + row.count('/') for row in tiles)"),
    # feature_7: the walker's BFS and target scan must treat open doors as\n"
    # floor, exactly like the engine does.
    ("                if tiles[y][x] == '.' \\\n"
     "                        and (x - start[0]) ** 2 + (y - start[1]) ** 2 >= 400:",
     "                if tiles[y][x] in ('.', '/') \\\n"
     "                        and (x - start[0]) ** 2 + (y - start[1]) ** 2 >= 400:"),
    ("                if (0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.'\n"
     "                        and (nx, ny) not in prev):",
     "                if (0 <= nx < w and 0 <= ny < h\n"
     "                        and tiles[ny][nx] in ('.', '/')\n"
     "                        and (nx, ny) not in prev):"),
    # feature_8: the walkable set for finding the stairs.
    ("        def walkable(t):\n"
     "            return t in ('.', '>')",
     "        def walkable(t):\n"
     "            return t in ('.', '>', '/')"),
    # feature_25: the BFS that walks the amulet and the ladder.
    ("                if 0 <= ny < len(tiles) and 0 <= nx < len(tiles[ny]) \\\n"
     "                        and tiles[ny][nx] in ('.', '>', '<'):",
     "                if 0 <= ny < len(tiles) and 0 <= nx < len(tiles[ny]) \\\n"
     "                        and tiles[ny][nx] in ('.', '>', '<', '/'):"),
    # run list: wire feature_26 in after feature_25.
    ("feature_25()\nprint(f\"\\n{failures} failure(s)\")",
     "feature_25()\nfeature_26()\nprint(f\"\\n{failures} failure(s)\")"),
]

for old, new in repls:
    if old not in src:
        raise SystemExit(f"NOT FOUND:\n{old!r}")
    if src.count(old) != 1:
        raise SystemExit(f"NOT UNIQUE ({src.count(old)}):\n{old!r}")
    src = src.replace(old, new)

f26 = '''

def feature_26():
    # Feature 26: some room entrances are doors - tile '+' shut, '/' open.
    # act('open'/'close', x=, y=) on an adjacent door toggles it. A shut
    # door blocks both movement and sight; an open one blocks neither.
    # A door cannot be shut while something stands on it.
    from collections import deque
    ok = True
    # -- doors exist and sit on the corridor, adjacent to a room ---------
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        doors = [(x, y) for y in range(len(tiles))
                 for x in range(len(tiles[y])) if tiles[y][x] in ('+', '/')]
        if len(doors) < 2:
            ok = False
            check(f"26 doors exist seed {seed}", False,
                  f"only {len(doors)} doors")
            continue
        # Every door is reachable: BFS over floor + open doors from the
        # start must reach at least one open door's tile.
        p = g.state()['player']
        seen = {(p['x'], p['y'])}
        q = deque([(p['x'], p['y'])])
        while q:
            cx, cy = q.popleft()
            for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
                nx, ny = cx + dx, cy + dy
                if (0 <= nx < len(tiles[0]) and 0 <= ny < len(tiles)
                        and tiles[ny][nx] in ('.', '/')
                        and (nx, ny) not in seen):
                    seen.add((nx, ny))
                    q.append((nx, ny))
        if not any(d in seen for d in doors):
            ok = False
            check(f"26 door reachable seed {seed}", False,
                  f"doors={doors} seen={len(seen)}")
    # -- open and close a real door --------------------------------------
    tested = 0
    for seed in (7, 42, 3, 11):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        # An open door with a floor tile on both sides: the doorway is
        # where the corridor crosses the room wall, so both neighbours
        # along the corridor are walkable.
        door = None
        for (dx, dy) in [(x, y) for y in range(h)
                         for x in range(w) if tiles[y][x] == '/']:
            nbs = [(dx + a, dy + b)
                   for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            free = [n for n in nbs
                    if 0 <= n[0] < w and 0 <= n[1] < h
                    and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
            if len(free) >= 2:
                door = (dx, dy)
                break
        if door is None:
            ok = False
            check(f"26 doorway found seed {seed}", False, "no open door")
            continue
        dx, dy = door
        # Park the player on a free neighbour of the door.
        free = [(dx + a, dy + b)
                for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        free = [n for n in free
                if 0 <= n[0] < w and 0 <= n[1] < h
                and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
        sx, sy = free[0]
        g._player['x'], g._player['y'] = sx, sy
        g._visible = g._compute_fov()
        # Close it: tile becomes '+', a message is added.
        msgs_before = len(g.state()['messages'])
        g.act('close', x=dx, y=dy)
        if g.state()['map']['tiles'][dy][dx] != '+':
            ok = False
            check(f"26 close toggles seed {seed}", False,
                  f"tile={g.state()['map']['tiles'][dy][dx]!r}")
        if len(g.state()['messages']) == msgs_before:
            ok = False
            check(f"26 close message seed {seed}", False)
        # A shut door blocks movement: a bump into it leaves the player put.
        opp = {'e': 'w', 'w': 'e', 's': 'n', 'n': 's'}[
            {'(1, 0)': 'e', '(-1, 0)': 'w',
             '(0, 1)': 's', '(0, -1)': 'n'}[(str(sx - dx), str(sy - dy))]]
        pos_before = (g.state()['player']['x'], g.state()['player']['y'])
        g.move(opp)
        pos_after = (g.state()['player']['x'], g.state()['player']['y'])
        if pos_after != pos_before:
            ok = False
            check(f"26 shut door blocks move seed {seed}", False,
                  f"moved to {pos_after}")
        # A shut door blocks sight: a tile straight across it is invisible
        # even though it was visible with the door open.
        other = (dx - (sx - dx), dy - (sy - sy))
        if (0 <= other[0] < w and 0 <= other[1] < h
                and tiles[other[1]][other[0]] in ('.', '/', '<', '>')):
            vis = g.state()['visible']
            if vis[other[1]][other[0]]:
                ok = False
                check(f"26 shut door blocks sight seed {seed}", False,
                      f"tile {other} visible through a shut door")
        # Reopen it: tile back to '/', movement through it works.
        g.act('open', x=dx, y=dy)
        if g.state()['map']['tiles'][dy][dx] != '/':
            ok = False
            check(f"26 open toggles seed {seed}", False,
                  f"tile={g.state()['map']['tiles'][dy][dx]!r}")
        g.move(opp)
        pos_after = (g.state()['player']['x'], g.state()['player']['y'])
        if pos_after != (dx, dy):
            ok = False
            check(f"26 open door walkable seed {seed}", False,
                  f"got {pos_after}, wanted {door}")
        tested += 1
    # -- cannot shut a door with something standing on it ----------------
    blocked = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        door = None
        for (dx, dy) in [(x, y) for y in range(h)
                         for x in range(w) if tiles[y][x] == '/']:
            nbs = [(dx + a, dy + b)
                   for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            free = [n for n in nbs
                    if 0 <= n[0] < w and 0 <= n[1] < h
                    and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
            if len(free) >= 2:
                door = (dx, dy)
                break
        if door is None:
            continue
        dx, dy = door
        free = [(dx + a, dy + b)
                for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        free = [n for n in free
                if 0 <= n[0] < w and 0 <= n[1] < h
                and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
        g._player['x'], g._player['y'] = free[0]
        g._visible = g._compute_fov()
        # A monster standing on the doorway: close must refuse and leave
        # the door open.
        g._monsters.append({'x': dx, 'y': dy, 'hp': 5, 'max_hp': 5,
                            'name': 'rat', 'alive': True, 'attack': 2})
        g.act('close', x=dx, y=dy)
        if g.state()['map']['tiles'][dy][dx] != '/':
            ok = False
            check(f"26 close refused with occupant seed {seed}", False,
                  f"tile={g.state()['map']['tiles'][dy][dx]!r}")
        else:
            blocked += 1
    check("26 doors (open/close, block move and sight, refuse occupied)",
          ok and tested >= 1 and blocked >= 1,
          f"toggled: {tested}, refused: {blocked}")
'''

anchor = "feature_25()\nfeature_26()"
src = src.replace(anchor, f26.rstrip() + "\n\n\n" + anchor)

io.open('tests.py', 'w', encoding='utf-8').write(src)
print("tests.py updated")
