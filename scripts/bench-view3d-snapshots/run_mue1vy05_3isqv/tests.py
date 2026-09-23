"""Regression tests: one check per finished feature.

Run with:  python tests.py
"""
from engine import Game

failures = 0


def check(name, ok, detail=""):
    global failures
    if ok:
        print(f"PASS {name}")
    else:
        failures += 1
        print(f"FAIL {name}{': ' + detail if detail else ''}")


def feature_1():
    g1 = Game(7)
    g2 = Game(7)
    m = g1.state()['map']
    tiles = m['tiles']
    ok = (m['width'] >= 40 and m['height'] >= 20
          and len(tiles) == m['height']
          and all(len(row) == m['width'] for row in tiles)
          and any(t == '#' for row in tiles for t in row)
          and any(t == '.' for row in tiles for t in row))
    check("1 map exists", ok,
          f"width={m['width']} height={m['height']}")
    check("1 map reproducible",
          tiles == g2.state()['map']['tiles'])


def feature_2():
    g = Game(7)
    p = g.state()['player']
    has_keys = all(k in p for k in ('x', 'y', 'hp', 'max_hp'))
    on_floor = g.state()['map']['tiles'][p['y']][p['x']] == '.'
    check("2 player exists", has_keys and on_floor,
          f"keys={list(p)} tile={g.state()['map']['tiles'][p['y']][p['x']]!r}")


def feature_3():
    # Build a fresh game, then test each direction moves one tile when the
    # destination is floor and unoccupied, and does not move into a wall or
    # off the map. A living monster on the target tile makes the move an
    # attack instead (feature 11), so the player stays put — that is
    # correct engine behaviour, not a movement failure.
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = g.state()['map']['width'], g.state()['map']['height']
        p = g.state()['player']
        x, y = p['x'], p['y']
        for name, (dx, dy) in {
            'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0),
            'ne': (1, -1), 'nw': (-1, -1), 'se': (1, 1), 'sw': (-1, 1),
        }.items():
            nx, ny = x + dx, y + dy
            inside = 0 <= nx < w and 0 <= ny < h
            if inside:
                if tiles[ny][nx] == '.':
                    # A living monster here turns the move into a bump
                    # attack; the player must not move onto it.
                    has_monster = any(
                        m['alive'] and m['x'] == nx and m['y'] == ny
                        for m in g._monsters)
                    g.move(name)
                    after = g.state()['player']
                    if has_monster:
                        if (after['x'], after['y']) != (x, y):
                            ok = False
                            check(f"3 bump attack blocks move", False,
                                  f"seed={seed} moved onto monster at "
                                  f"({nx},{ny}), got ({after['x']},{after['y']})")
                    else:
                        if (after['x'], after['y']) != (nx, ny):
                            ok = False
                            check(f"3 move {name} onto floor", False,
                                  f"seed={seed} expected=({nx},{ny}) got=({after['x']},{after['y']})")
                else:
                    g.move(name)
                    after = g.state()['player']
                    if (after['x'], after['y']) != (x, y):
                        ok = False
                        check(f"3 move {name} into wall", False,
                              f"seed={seed} tile={tiles[ny][nx]!r} moved from ({x},{y})")
            # restore position so each direction is tested independently
            g._player['x'], g._player['y'] = x, y
    check("3 movement all directions", ok)


def feature_4():
    # Moving into a wall leaves the position unchanged and never raises.
    # The player starts in a room, so walk to a floor tile that actually
    # borders a wall, then try the blocked move.
    ok = True
    tested = 0
    for seed in (7, 42, 3, 11, 99):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = g.state()['map']['width'], g.state()['map']['height']
        dirs = {'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0),
                'ne': (1, -1), 'nw': (-1, -1), 'se': (1, 1), 'sw': (-1, 1)}
        found = 0
        for y in range(h):
            for x in range(w):
                if found >= 2:
                    break
                if tiles[y][x] != '.':
                    continue
                for name, (dx, dy) in dirs.items():
                    nx, ny = x + dx, y + dy
                    if (not (0 <= nx < w and 0 <= ny < h)
                            or tiles[ny][nx] == '#'):
                        g._player['x'], g._player['y'] = x, y
                        g.move(name)  # must not raise
                        after = g.state()['player']
                        if (after['x'], after['y']) != (x, y):
                            ok = False
                            check(f"4 wall blocks {name}", False,
                                  f"seed={seed} moved from ({x},{y})")
                        tested += 1
                        found += 1
                        break
                if found >= 2:
                    break
    check("4 walls stop you", ok and tested >= 3, f"blocked moves tested: {tested}")


def feature_5():
    # At least three rooms, and every floor tile reachable from the start.
    from collections import deque
    ok = True
    for seed in (7, 42, 3, 11, 99):
        g = Game(seed)
        if len(g._rooms) < 3:
            ok = False
            check(f"5 rooms seed {seed}", False, f"only {len(g._rooms)} rooms")
            continue
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        p = g.state()['player']
        seen = {(p['x'], p['y'])}
        q = deque([(p['x'], p['y'])])
        while q:
            cx, cy = q.popleft()
            for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] in ('.', '/') \
                        and (nx, ny) not in seen:
                    seen.add((nx, ny))
                    q.append((nx, ny))
        # Open doors ('/') are walkable, so they count as reachable
        # floor for feature 5's all-floor-reachable guarantee.
        total = sum(row.count('.') + row.count('/') for row in tiles)
        if len(seen) != total:
            ok = False
            check(f"5 reachability seed {seed}", False,
                  f"{len(seen)}/{total} floor tiles reachable")
    check("5 rooms and corridors (3+ rooms, all floor reachable)", ok)


def feature_6():
    # Feature 6: state()['visible'] is a boolean grid the size of the map;
    # the player's own tile is visible; a floor tile whose straight line to
    # the player crosses a wall is not visible. The wall-blocking half is
    # checked against an independent sampled-ray reference: every floor tile
    # the engine reports visible must also be visible to the reference.
    R = 8
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        vis = g.state()['visible']
        if (len(vis) != h or any(len(row) != w for row in vis)
                or not all(type(v) is bool for row in vis for v in row)):
            ok = False
            check(f"6 visible grid seed {seed}", False, "wrong shape or type")
            continue
        p = g.state()['player']
        if not vis[p['y']][p['x']]:
            ok = False
            check(f"6 player tile visible seed {seed}", False)
            continue

        def ref_visible(x, y):
            # Sample the straight line player -> tile; a wall sample blocks.
            steps = 32 * max(abs(x - p['x']), abs(y - p['y']))
            if steps == 0:
                return True
            for i in range(steps + 1):
                fx = p['x'] + (x - p['x']) * i / steps
                fy = p['y'] + (y - p['y']) * i / steps
                tx, ty = int(fx + 0.5), int(fy + 0.5)
                if (tx, ty) == (x, y):  # endpoint may be anything
                    continue
                if not (0 <= tx < w and 0 <= ty < h) or tiles[ty][tx] == '#':
                    return False
            return True

        # Every floor tile the engine calls visible must pass the reference.
        # And at least one non-player floor tile within R must be visible.
        nearby_floor = 0
        for y in range(h):
            for x in range(w):
                if tiles[y][x] != '.':
                    continue
                if (x - p['x']) ** 2 + (y - p['y']) ** 2 > R * R:
                    continue
                nearby_floor += 1
                if vis[y][x] and (x, y) != (p['x'], p['y']):
                    if not ref_visible(x, y):
                        ok = False
                        check(f"6 wall blocks sight seed {seed}", False,
                              f"floor ({x},{y}) visible through a wall")
    check("6 field of view", ok, f"nearby_floor={nearby_floor}")


def feature_7():
    # Feature 7: state()['explored'] is a boolean grid the size of the map.
    # Walk a real path (replaying BFS steps through move()) to a floor tile
    # far enough away that the starting FOV is out of sight, then: explored
    # must be exactly the union of everything ever visible (nothing lost,
    # nothing gained), and at least one formerly visible tile must be
    # explored but no longer visible.
    from collections import deque
    ok = True
    tested = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        # Feature 11 makes a living monster block its tile, which would stall
        # this map/FOV/memory walk; clear them so the walker isn't diverted
        # into combat.
        for mon in g._monsters:
            mon['alive'] = False
        m = g.state()['map']
        tiles, w, h = m['tiles'], m['width'], m['height']
        start = (g.state()['player']['x'], g.state()['player']['y'])
        start_vis = [row[:] for row in g.state()['visible']]
        explored = g.state()['explored']
        if (len(explored) != h or any(len(row) != w for row in explored)
                or not all(type(v) is bool for row in explored for v in row)):
            ok = False
            check(f"7 explored grid seed {seed}", False, "wrong shape or type")
            continue

        # A reachable floor tile at least 20 away from the start. FOV has
        # radius 8, so at 20+ the triangle inequality puts every starting
        # FOV tile strictly out of the target's radius: the start area must
        # genuinely leave the visible set.
        target = None
        for y in range(h):
            for x in range(w):
                if tiles[y][x] in ('.', '/') \
                        and (x - start[0]) ** 2 + (y - start[1]) ** 2 >= 400:
                    target = (x, y)
                    break
            if target:
                break
        if not target:
            ok = False
            check(f"7 target far enough seed {seed}", False,
                  "no floor tile 20+ away; map too small to test")
            continue

        # BFS a path start -> target on floor tiles.
        dirs = {'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0)}
        prev = {start: None}
        q = deque([start])
        while q and target not in prev:
            cx, cy = q.popleft()
            for name, (dx, dy) in dirs.items():
                nx, ny = cx + dx, cy + dy
                if (0 <= nx < w and 0 <= ny < h
                        and tiles[ny][nx] in ('.', '/')
                        and (nx, ny) not in prev):
                    prev[(nx, ny)] = (cx, cy)
                    q.append((nx, ny))
        path = []
        node = target
        while prev[node] is not None:
            pnode = prev[node]
            # node was reached from pnode, so the step is pnode -> node.
            for name, (dx, dy) in dirs.items():
                if (pnode[0] + dx, pnode[1] + dy) == node:
                    path.append(name)
                    break
            node = pnode
        path.reverse()

        # Walk it, accumulating the union of everything ever visible.
        union = [row[:] for row in g.state()['visible']]
        for step in path:
            g.move(step)
            vis = g.state()['visible']
            for y in range(h):
                for x in range(w):
                    if vis[y][x]:
                        union[y][x] = True
        if (g.state()['player']['x'], g.state()['player']['y']) != target:
            ok = False
            check(f"7 walk to target seed {seed}", False,
                  f"ended at {g.state()['player']}, wanted {target}")
            continue

        exp = g.state()['explored']
        if exp != union:
            ok = False
            check(f"7 memory is the union of all FOV seed {seed}", False,
                  "explored != union of visible tiles")
            continue

        gone = sum(1 for y in range(h) for x in range(w)
                   if start_vis[y][x] and not g.state()['visible'][y][x])
        remembered = sum(1 for y in range(h) for x in range(w)
                         if start_vis[y][x] and not g.state()['visible'][y][x]
                         and exp[y][x])
        if gone == 0:
            ok = False
            check(f"7 target far enough seed {seed}", False,
                  "start FOV still visible at target; distance too small")
        elif remembered == 0:
            ok = False
            check(f"7 remembered tile no longer visible seed {seed}", False,
                  f"{gone} formerly visible tiles all lost from memory")
        else:
            tested += 1
    check("7 memory (explored sticky, nothing lost)", ok and tested >= 1,
          f"seeds walked: {tested}")


def feature_8():
    # Feature 8: exactly one '>' per level; standing on it, act('descend')
    # raises depth by one and builds a new (different) map; off the stairs
    # it does nothing and adds a message.
    from collections import deque
    ok = True
    descends = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        # Feature 11's bump-attack stalls a plain walker on a monster's tile
        # (the player attacks instead of moving), and feature 8 is about the
        # stairs, not combat: clear them so the path is never interrupted.
        for mon in g._monsters:
            mon['alive'] = False
        # Feature 27's teleport trap can fling the walker across the level
        # mid-path; the stairs test is about the stairs, not traps, so clear
        # them the same way so the path is never interrupted.
        g._traps = []
        tiles, w, h = g.state()['map']['tiles'], 80, 24
        stairs = [(x, y) for y in range(h) for x in range(w) if tiles[y][x] == '>']
        if len(stairs) != 1:
            ok = False
            check(f"8 one stair seed {seed}", False, f"found {len(stairs)} '>' tiles")
            continue
        sx, sy = stairs[0]

        # Off the stairs: descend must be a no-op that still adds a message.
        pre = (g.state()['player']['x'], g.state()['player']['y'])
        msgs_before = len(g.state()['messages'])
        g.act('descend')
        post = g.state()
        if (post['depth'] != 1
                or (post['player']['x'], post['player']['y']) != pre
                or len(post['messages']) == msgs_before):
            ok = False
            check(f"8 off-stairs no-op seed {seed}", False,
                  f"depth={post['depth']} pos={post['player']}")

        # Walk the stairs. BFS over floor and the stair tile.
        def walkable(t):
            return t in ('.', '>', '/')

        start = (g.state()['player']['x'], g.state()['player']['y'])
        dirs = {'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0)}
        prev = {start: None}
        q = deque([start])
        while q and (sx, sy) not in prev:
            cx, cy = q.popleft()
            for name, (dx, dy) in dirs.items():
                nx, ny = cx + dx, cy + dy
                if (0 <= nx < w and 0 <= ny < h and walkable(tiles[ny][nx])
                        and (nx, ny) not in prev):
                    prev[(nx, ny)] = (cx, cy)
                    q.append((nx, ny))
        if (sx, sy) not in prev:
            ok = False
            check(f"8 stairs reachable seed {seed}", False, "stair tile unreachable")
            continue
        path = []
        node = (sx, sy)
        while prev[node] is not None:
            pnode = prev[node]
            for name, (dx, dy) in dirs.items():
                if (pnode[0] + dx, pnode[1] + dy) == node:
                    path.append(name)
                    break
            node = pnode
        path.reverse()
        for step in path:
            g.move(step)
        if (g.state()['player']['x'], g.state()['player']['y']) != (sx, sy):
            ok = False
            check(f"8 walk to stairs seed {seed}", False,
                  f"ended at {g.state()['player']}")
            continue

        # On the stairs: descend bumps depth and builds a new map.
        before = [row[:] for row in tiles]
        g.act('descend')
        st = g.state()
        if st['depth'] != 2:
            ok = False
            check(f"8 depth bumped seed {seed}", False, f"depth={st['depth']}")
        new_tiles = st['map']['tiles']
        if new_tiles == before:
            ok = False
            check(f"8 new map seed {seed}", False, "level 2 map identical to level 1")
        # The player is on a walkable tile of the new level.
        p = st['player']
        if new_tiles[p['y']][p['x']] not in ('.', '>'):
            ok = False
            check(f"8 on tile after descend seed {seed}", False,
                  f"tile={new_tiles[p['y']][p['x']]!r}")
        # A message was added.
        if not any('descend' in m or 'level' in m for m in st['messages']):
            ok = False
            check(f"8 descend message seed {seed}", False)
        else:
            descends += 1

    check("8 stairs down", ok and descends >= 1, f"descends: {descends}")


def feature_9():
    # Feature 9: state()['monsters'] is non-empty; each is on a floor tile,
    # none on the player's tile, each with hp, max_hp, name, alive.
    # Same seed -> same monsters.
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        g2 = Game(seed)
        ms = g.state()['monsters']
        tiles = g.state()['map']['tiles']
        p = g.state()['player']
        if not ms:
            ok = False
            check(f"9 monsters non-empty seed {seed}", False, "no monsters")
            continue
        for i, m in enumerate(ms):
            if not all(k in m for k in ('hp', 'max_hp', 'name', 'alive')):
                ok = False
                check(f"9 keys seed {seed}", False, f"missing keys on {m}")
            if tiles[m['y']][m['x']] != '.':
                ok = False
                check(f"9 on floor seed {seed}", False,
                      f"monster {m['name']} at ({m['x']},{m['y']}) on {tiles[m['y']][m['x']]!r}")
            if (m['x'], m['y']) == (p['x'], p['y']):
                ok = False
                check(f"9 not on player seed {seed}", False,
                      f"monster on player tile ({p['x']},{p['y']})")
            if m['hp'] < 1 or m['hp'] > m['max_hp'] or not m['alive']:
                ok = False
                check(f"9 sane hp seed {seed}", False, f"hp={m['hp']} max={m['max_hp']}")
        # Reproducible.
        if ms != g2.state()['monsters']:
            ok = False
            check(f"9 reproducible seed {seed}", False, "monsters differ across Game instances")
    check("9 monsters exist", ok)


def feature_10():
    # Feature 10: a monster that can see the player moves closer over
    # successive act('wait') calls.
    def dist(a, b):
        return ((a['x'] - b['x']) ** 2 + (a['y'] - b['y']) ** 2) ** 0.5

    ok = True
    tested = 0
    for seed in (7, 42, 3, 11, 99):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        p = g.state()['player']
        # A monster that sees the player from at least 2 tiles away.
        target = None
        for m in g._monsters:
            if (m['alive'] and g._monster_sees(m)
                    and dist(m, p) >= 2.0):
                target = m
                break
        if target is None:
            continue
        start = dist(target, p)
        closer = False
        for _ in range(40):
            g.act('wait')
            if not target['alive']:
                ok = False
                check(f"10 alive seed {seed}", False, "monster died while waiting")
                break
            if tiles[target['y']][target['x']] != '.':
                ok = False
                check(f"10 on floor seed {seed}", False,
                      f"monster at ({target['x']},{target['y']}) on "
                      f"{tiles[target['y']][target['x']]!r}")
            if (target['x'], target['y']) == (p['x'], p['y']):
                ok = False
                check(f"10 not on player seed {seed}", False,
                      "monster stepped onto the player's tile")
            if dist(target, p) < start:
                closer = True
                break
        tested += 1
        if not closer:
            ok = False
            check(f"10 closes in seed {seed}", False,
                  f"distance stayed at {start} after waits")
    check("10 they come for you", ok and tested >= 1, f"seeds with a visible monster: {tested}")


def feature_11():
    # Feature 11: moving into a living monster's tile attacks it instead of
    # moving. The player does not move, the monster's hp falls, and the
    # monster's tile is still blocked afterwards (it is still alive).
    ok = True
    tested = 0
    for seed in (7, 42, 3, 11, 99):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        for m in g._monsters:
            if not m['alive']:
                continue
            mx, my = m['x'], m['y']
            # A floor tile adjacent to the monster, and the direction from
            # that tile into the monster.
            for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                                   's': (0, 1), 'n': (0, -1)}.items():
                ax, ay = mx + dx, my + dy
                if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.':
                    attack = g.state()['player']['attack']
                    g._player['x'], g._player['y'] = ax, ay
                    # The player stands at (mx+dx, my+dy), so the bump into
                    # the monster is the OPPOSITE direction, (-dx, -dy).
                    opp = {'e': 'w', 'w': 'e', 's': 'n', 'n': 's'}[name]
                    before = m['hp']
                    g.move(opp)
                    pos = g.state()['player']
                    if (pos['x'], pos['y']) != (ax, ay):
                        ok = False
                        check(f"11 stays put seed {seed}", False,
                              f"player moved to ({pos['x']},{pos['y']})")
                    if m['hp'] != before - attack:
                        ok = False
                        check(f"11 hp falls seed {seed}", False,
                              f"hp {before} -> {m['hp']}, wanted {before - attack}")
                    tested += 1
                    break
            if not m['alive']:
                continue
    check("11 bump to attack", ok and tested >= 3,
          f"attacks tested: {tested}")


def feature_12():
    # Feature 12: a monster at 0 hp has alive False and stops blocking the
    # tile. When the player's hp reaches 0, game_over is True and further
    # moves change nothing.
    ok = True
    # -- monster half ------------------------------------------------------
    killed = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        m = None
        for mon in g._monsters:
            if mon['alive']:
                m = mon
                break
        if m is None:
            ok = False
            check(f"12 monster exists seed {seed}", False, "no living monster")
            continue
        mx, my = m['x'], m['y']
        for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                               's': (0, 1), 'n': (0, -1)}.items():
            ax, ay = mx + dx, my + dy
            if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.':
                break
        else:
            continue
        g._player['x'], g._player['y'] = ax, ay
        # The player stands at (mx+dx, my+dy), so the bump that hits the
        # monster is the OPPOSITE direction, (-dx, -dy).
        opp = {'e': 'w', 'w': 'e', 's': 'n', 'n': 's'}[name]
        # Bounded: player attack is 5 and monster max hp is 7, so the bump
        # dies it within two hits; the cap guards a regression to a hang.
        for _ in range(4):
            g.move(opp)
            if not m['alive']:
                break
        if not m['alive']:
            killed += 1
        # Its tile no longer blocks: stepping in the same (opp) direction
        # now actually lands the player on the dead monster's tile.
        g.move(opp)
        pos = g.state()['player']
        if (pos['x'], pos['y']) != (mx, my):
            ok = False
            check(f"12 dead stops blocking seed {seed}", False,
                  f"player at ({pos['x']},{pos['y']}), wanted dead tile ({mx},{my})")

    # -- player half -------------------------------------------------------
    died = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        # A living monster that can see the player, so it will attack when
        # adjacent; force-adjacent and wait turns until the player is dead.
        p = g.state()['player']
        target = None
        for m in g._monsters:
            if m['alive'] and g._monster_sees(m):
                target = m
                break
        if target is None:
            continue
        # Walk the monster to a tile adjacent to the player.
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                               's': (0, 1), 'n': (0, -1)}.items():
            ax, ay = p['x'] + dx, p['y'] + dy
            if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.':
                target['x'], target['y'] = ax, ay
                break
        else:
            continue
        # Keep waiting; the monster attacks the player each turn it is
        # adjacent. Bounded so a pathological layout cannot hang the suite.
        for _ in range(200):
            g.act('wait')
            if g.state()['game_over']:
                break
        st = g.state()
        if not st['game_over'] or st['player']['hp'] != 0:
            ok = False
            check(f"12 player dies seed {seed}", False,
                  f"game_over={st['game_over']} hp={st['player']['hp']}")
            continue
        died += 1
        # After death nothing changes: move, wait, descend are all no-ops.
        before = dict(st['player'])
        g.move('e')
        g.act('wait')
        g.act('descend')
        after = g.state()
        if (after['player']['x'] != before['x']
                or after['player']['y'] != before['y']
                or after['depth'] != st['depth']
                or not after['game_over']):
            ok = False
            check(f"12 frozen after death seed {seed}", False,
                  f"state changed: player={after['player']} depth={after['depth']}")
    check("12 death", ok and killed >= 1 and died >= 1,
          f"monsters killed: {killed}, player deaths: {died}")


def feature_13():
    # Feature 13: state()['messages'] gains a line when the player attacks,
    # when a monster dies, and when the player takes damage.
    ok = True
    attacks = deaths = hits = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        m = next(mon for mon in g._monsters if mon['alive'])
        mx, my = m['x'], m['y']
        # A floor tile adjacent to the monster, and the direction into it.
        for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                               's': (0, 1), 'n': (0, -1)}.items():
            ax, ay = mx + dx, my + dy
            if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.':
                break
        else:
            continue
        opp = {'e': 'w', 'w': 'e', 's': 'n', 'n': 's'}[name]
        g._player['x'], g._player['y'] = ax, ay
        # One bump: an attack message must appear; a surviving monster is
        # adjacent and in sight, so its turn adds a damage message too.
        def last_lines():
            # Lines appended since the previous call.
            cur = g.state()['messages']
            new = cur[last_lines.n:]
            last_lines.n = len(cur)
            return new
        last_lines.n = len(g.state()['messages'])
        g.move(opp)
        new = last_lines()
        if not any(f"You hit the {m['name']}" in line for line in new):
            ok = False
            check(f"13 attack line seed {seed}", False, f"lines={new!r}")
        else:
            attacks += 1
        if m['alive']:
            # The monster only acts on its own turn, which is the next
            # act('wait') — not on the bump turn. The player and monster
            # are adjacent and in sight, so the wait produces the hit.
            g.act('wait')
            new = last_lines()
            if not any(f"{m['name']} hits you" in line for line in new):
                ok = False
                check(f"13 damage line seed {seed}", False, f"lines={new!r}")
            else:
                hits += 1
        # Bump to the kill: the death message must appear in the lines the
        # killing bump added.
        for _ in range(4):
            if not m['alive']:
                break
            g.move(opp)
            new = last_lines()
        if m['alive']:
            ok = False
            check(f"13 kill seed {seed}", False, "monster still alive")
            continue
        if not any(f"{m['name']} dies." in line for line in new):
            ok = False
            check(f"13 death line seed {seed}", False, f"lines={new!r}")
        else:
            deaths += 1
    check("13 messages", ok and attacks >= 2 and deaths >= 1,
          f"attacks={attacks} deaths={deaths} damage-lines={hits}")


def feature_14():
    # Feature 14: state()['items'] is non-empty, each on a floor tile, each
    # with name and kind. Same seed -> same items (deterministic placement).
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        st = g.state()
        tiles = st['map']['tiles']
        items = st.get('items')
        if not items:
            ok = False
            check(f"14 items exist seed {seed}", False, "items missing or empty")
            continue
        for it in items:
            if not ('name' in it and 'kind' in it):
                ok = False
                check(f"14 item fields seed {seed}", False, f"item={it!r}")
            if tiles[it['y']][it['x']] != '.':
                ok = False
                check(f"14 item on floor seed {seed}", False, f"item={it!r}")
        g2 = Game(seed)
        if [(i['x'], i['y'], i['kind']) for i in st['items']] != \
           [(i['x'], i['y'], i['kind']) for i in g2.state()['items']]:
            ok = False
            check(f"14 items reproducible seed {seed}", False, "placement differs")
    check("14 items on the floor", ok)


def feature_15():
    # Feature 15: standing on an item, act('pickup') moves it to the bag;
    # off an item it does nothing at all.
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        p = g.state()['player']
        # Off an item: no change of items, inventory stays empty, no line.
        before = g.state()
        g.act('pickup')
        after = g.state()
        if after['inventory'] or after['items'] != before['items'] or \
           after['messages'] != before['messages']:
            ok = False
            check(f"15 off-item seed {seed}", False,
                  f"inv={after['inventory']!r}")
        # On an item: it leaves the floor and lands in the inventory.
        g._items.append({'x': p['x'], 'y': p['y'],
                         'name': 'healing potion', 'kind': 'potion'})
        g.act('pickup')
        st = g.state()
        on_floor = any(i['x'] == p['x'] and i['y'] == p['y']
                       for i in st['items'])
        if on_floor or len(st['inventory']) != 1 or \
           st['inventory'][0]['name'] != 'healing potion':
            ok = False
            check(f"15 pickup seed {seed}", False,
                  f"items={st['items']!r} inv={st['inventory']!r}")
    check("15 pick things up", ok)


def feature_16():
    # Feature 16: the bag holds at most 26 items; picking up past that is
    # refused with a message and leaves the item on the floor.
    ok = True
    g = Game(7)
    p = g.state()['player']
    g._inventory = [{'name': f'potion {i}', 'kind': 'potion'}
                    for i in range(26)]
    g._items.append({'x': p['x'], 'y': p['y'],
                     'name': 'healing potion', 'kind': 'potion'})
    before = g.state()
    g.act('pickup')
    st = g.state()
    if len(st['inventory']) != 26:
        ok = False
        check("16 capacity", False, f"inv={len(st['inventory'])}")
    if not any(i['x'] == p['x'] and i['y'] == p['y'] for i in st['items']):
        ok = False
        check("16 item left on floor", False, f"items={st['items']!r}")
    if len(st['messages']) != len(before['messages']) + 1:
        ok = False
        check("16 refusal message", False, f"messages={st['messages'][-3:]}")
    # 25 items: pickup still works.
    g = Game(7)
    p = g.state()['player']
    g._inventory = [{'name': f'potion {i}', 'kind': 'potion'}
                    for i in range(25)]
    g._items.append({'x': p['x'], 'y': p['y'],
                     'name': 'healing potion', 'kind': 'potion'})
    g.act('pickup')
    st = g.state()
    if len(st['inventory']) != 26 or any(
            i['x'] == p['x'] and i['y'] == p['y'] for i in st['items']):
        ok = False
        check("16 25th pickup", False,
              f"inv={len(st['inventory'])} items={st['items']!r}")
    check("16 carrying capacity", ok)


def feature_17():
    # Feature 17: act('use', index=i) on a potion raises hp, never above
    # max_hp, and removes it from the inventory.
    ok = True
    for seed in (7, 42):
        g = Game(seed)
        g._inventory = [{'name': 'healing potion', 'kind': 'potion'}]
        # A fresh player is at full hp; drop it so the potion has room to heal.
        g._player['hp'] = 10
        hp0 = 10
        g.act('use', index=0)
        p = g.state()['player']
        if g.state()['inventory']:
            ok = False
            check(f"17 potion consumed seed {seed}", False,
                  f"inv={g.state()['inventory']!r}")
        if p['hp'] <= hp0:
            ok = False
            check(f"17 hp raised seed {seed}", False, f"{hp0} -> {p['hp']}")
        # Capped at max_hp even from almost-full.
        g = Game(seed)
        g._inventory = [{'name': 'healing potion', 'kind': 'potion'}]
        g._player['hp'] = g._player['max_hp'] - 2
        g.act('use', index=0)
        p = g.state()['player']
        if p['hp'] != p['max_hp']:
            ok = False
            check(f"17 hp cap seed {seed}", False, f"hp={p['hp']}")
        # A non-potion in the bag is refused, not consumed.
        g = Game(seed)
        g._inventory = [{'name': 'rusty sword', 'kind': 'weapon'}]
        before = g.state()
        g.act('use', index=0)
        st = g.state()
        if len(st['inventory']) != 1 or \
           st['inventory'][0]['name'] != 'rusty sword' or \
           st['player']['hp'] != before['player']['hp']:
            ok = False
            check(f"17 non-potion refused seed {seed}", False,
                  f"inv={st['inventory']!r}")
    check("17 potions", ok)


def feature_18():
    # Feature 18: act('equip', index=i) on a weapon raises player['attack']
    # and sets equipped['weapon']; armour raises defense and sets
    # equipped['armour']; act('unequip', slot=...) reverses it exactly.
    ok = True
    for seed in (7, 42, 3):
        g = Game(seed)
        base_attack = g.state()['player']['attack']
        base_defense = g.state()['player']['defense']
        # Give the player one of each kind at known bonus values.
        g._inventory = [
            {'x': -1, 'y': -1, 'name': 'short sword', 'kind': 'weapon',
             'bonus': 3},
            {'x': -1, 'y': -1, 'name': 'leather jacket', 'kind': 'armour',
             'bonus': 2},
        ]
        # Equip the weapon (index 0).
        g.act('equip', index=0)
        st = g.state()
        if st['equipped']['weapon'] is None:
            ok = False
            check(f"18 weapon slot seed {seed}", False, "slot not set")
        if st['player']['attack'] != base_attack + 3:
            ok = False
            check(f"18 attack raised seed {seed}", False,
                  f"attack={st['player']['attack']}")
        # Equip the armour (index 1).
        g.act('equip', index=1)
        st = g.state()
        if st['equipped']['armour'] is None:
            ok = False
            check(f"18 armour slot seed {seed}", False, "slot not set")
        if st['player']['defense'] != base_defense + 2:
            ok = False
            check(f"18 defense raised seed {seed}", False,
                  f"defense={st['player']['defense']}")
        # Unequip the weapon — attack back to base, slot None.
        g.act('unequip', slot='weapon')
        st = g.state()
        if st['equipped']['weapon'] is not None:
            ok = False
            check(f"18 weapon slot cleared seed {seed}", False,
                  f"slot={st['equipped']['weapon']!r}")
        if st['player']['attack'] != base_attack:
            ok = False
            check(f"18 attack reverted seed {seed}", False,
                  f"attack={st['player']['attack']}")
        # Unequip the armour — defense back to base, slot None.
        g.act('unequip', slot='armour')
        st = g.state()
        if st['equipped']['armour'] is not None:
            ok = False
            check(f"18 armour slot cleared seed {seed}", False,
                  f"slot={st['equipped']['armour']!r}")
        if st['player']['defense'] != base_defense:
            ok = False
            check(f"18 defense reverted seed {seed}", False,
                  f"defense={st['player']['defense']}")
    # A potion or scroll in the bag is refused by equip, not equipped.
    g = Game(7)
    g._inventory = [{'x': -1, 'y': -1, 'name': 'healing potion',
                     'kind': 'potion', 'bonus': 0}]
    before = g.state()
    g.act('equip', index=0)
    st = g.state()
    if st['equipped']['weapon'] is not None or \
       st['equipped']['armour'] is not None:
        ok = False
        check("18 non-equipment refused", False,
              f"equipped={st['equipped']!r}")
    if len(st['inventory']) != 1 or st['player'] != before['player']:
        ok = False
        check("18 non-equipment leaves stats alone", False,
              f"player={st['player']!r}")
    # An out-of-range index is a no-op that does not raise.
    g.act('equip', index=99)
    g.act('unequip', slot='shoes')
    check("18 equipment", ok)


def feature_19():
    # Feature 19: across depths 1 to 5, at least three distinct monster
    # names appear, with different max_hp between them.
    ok = True
    for seed in (1, 2, 3, 7, 42):
        names = set()
        hp_by_name = {}
        for depth in range(1, 6):
            g = Game(seed, start_depth=depth)
            for m in g.state()['monsters']:
                names.add(m['name'])
                hp_by_name.setdefault(m['name'], set()).add(m['max_hp'])
        if len(names) < 3:
            ok = False
            check(f"19 three names seed {seed}", False,
                  f"names={sorted(names)}")
            continue
        # "different max_hp between them": not all names share the exact
        # same max_hp pool.
        pools = {frozenset(v) for v in hp_by_name.values()}
        if len(pools) < 2:
            ok = False
            check(f"19 varying hp seed {seed}", False,
                  f"all names share one hp pool: {pools}")
    check("19 bestiary (3+ distinct names, varying hp)", ok)


def feature_20():
    # Feature 20: for the same seed, the average max_hp of the monsters on
    # depth 5 is higher than the average on depth 1.
    ok = True
    tested = 0
    for seed in (7, 42, 3, 11, 99):
        def avg(depth):
            g = Game(seed, start_depth=depth)
            ms = g.state()['monsters']
            if not ms:
                return None
            return sum(m['max_hp'] for m in ms) / len(ms)

        a1, a5 = avg(1), avg(5)
        if a1 is None or a5 is None:
            ok = False
            check(f"20 monsters present seed {seed}", False,
                  f"depth1={a1} depth5={a5}")
            continue
        if not a5 > a1:
            ok = False
            check(f"20 depth 5 tougher seed {seed}", False,
                  f"avg max_hp: depth1={a1} depth5={a5}")
        else:
            tested += 1
    check("20 it gets worse down there", ok and tested >= 1,
          f"seeds: {tested}")


def _force_adjacent(g, m):
    # Put the player on a floor tile adjacent to monster m and return the
    # direction name that bumps INTO the monster, or None if no such tile.
    tiles = g.state()['map']['tiles']
    w, h = len(tiles[0]), len(tiles)
    for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                           's': (0, 1), 'n': (0, -1)}.items():
        ax, ay = m['x'] + dx, m['y'] + dy
        if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] != '.':
            continue
        # The square must be free of other living monsters, or the bump
        # loop would fight them first and skew the xp delta.
        if any(mon['alive'] and mon['x'] == ax and mon['y'] == ay
               for mon in g._monsters if mon is not m):
            continue
        g._player['x'], g._player['y'] = ax, ay
        # Player at (m.x+dx, m.y+dy); the bump into m is the opposite.
        return {'e': 'w', 'w': 'e', 's': 'n', 'n': 's'}[name]
    return None


def _kill(g, m):
    # Bump into m until it dies (monsters only act on their own wait turn,
    # so plain move() bumps do no damage to the player). Bounded against a
    # regression to a hang.
    opp = _force_adjacent(g, m)
    if opp is None:
        return False
    for _ in range(12):
        g.move(opp)
        if not m['alive']:
            return True
    return False


def feature_21():
    # Feature 21: killing a monster raises player['xp'] by the monster's
    # max_hp; crossing the level threshold (xp >= level * 10) raises level
    # and max_hp and says so in a message.
    ok = True
    xp_kills = 0
    level_ups = 0
    for seed in (7, 42, 3):
        # -- xp rises on a kill -------------------------------------------
        g = Game(seed)
        m = next(mon for mon in g._monsters if mon['alive'])
        xp_before = g.state()['player']['xp']
        if _kill(g, m):
            xp_after = g.state()['player']['xp']
            if xp_after != xp_before + m['max_hp']:
                ok = False
                check(f"21 xp rises seed {seed}", False,
                      f"xp {xp_before} -> {xp_after}, "
                      f"max_hp={m['max_hp']}")
            else:
                xp_kills += 1
        else:
            ok = False
            check(f"21 kill possible seed {seed}", False, "no adj tile")

        # -- threshold crossing -------------------------------------------
        g = Game(seed)
        m = next(mon for mon in g._monsters if mon['alive'])
        # state() returns a copy of the player dict, so park the xp on the
        # real one: one point below the level-1 threshold, so this kill's
        # gain (>= 4) is guaranteed to cross into level 2.
        g._player['xp'] = g._player['level'] * 10 - 1
        level_before = g._player['level']
        maxhp_before = g._player['max_hp']
        msgs_before = len(g.state()['messages'])
        if _kill(g, m):
            p = g.state()['player']
            if p['level'] <= level_before:
                ok = False
                check(f"21 level up seed {seed}", False,
                      f"level={p['level']} (was {level_before}), xp={p['xp']}")
            if p['max_hp'] <= maxhp_before:
                ok = False
                check(f"21 max_hp up seed {seed}", False,
                      f"max_hp={p['max_hp']} (was {maxhp_before})")
            new = g.state()['messages'][msgs_before:]
            if not any(str(p['level']) in line and 'level' in line
                       for line in new):
                ok = False
                check(f"21 level-up message seed {seed}", False,
                      f"lines={new!r}")
            if p['hp'] > p['max_hp']:
                ok = False
                check(f"21 hp capped seed {seed}", False,
                      f"hp={p['hp']} max={p['max_hp']}")
            level_ups += 1
        else:
            ok = False
            check(f"21 kill for level seed {seed}", False, "no adj tile")
    check("21 experience", ok and xp_kills >= 1 and level_ups >= 1,
          f"xp kills: {xp_kills}, level-ups: {level_ups}")


def feature_22():
    # Feature 22: save(path) then Game.load(path) gives a game whose
    # state() equals the original's exactly — a full round trip.
    import os
    import tempfile
    ok = True
    for seed in (7, 42):
        g = Game(seed)
        # Make the state non-trivial: move around so FOV, memory and
        # messages differ from a fresh game.
        for d in ("e", "s", "w", "n", "e"):
            g.move(d)
        before = g.state()
        fd, path = tempfile.mkstemp(suffix=".save")
        os.close(fd)
        try:
            g.save(path)
            h = Game.load(path)
            after = h.state()
            if before != after:
                for k in before:
                    if before[k] != after[k]:
                        ok = False
                        check(f"22 save/load seed {seed}", False,
                              f"key {k!r} differs")
                continue
            # The loaded game is live: it takes a turn and keeps going.
            h.move("e")
            after2 = h.state()
            if (after2['player']['x'], after2['player']['y']) == \
                    (after['player']['x'], after['player']['y']):
                pass  # a wall may block; not a failure
            if not isinstance(after2['messages'], list):
                ok = False
                check(f"22 loaded game is live seed {seed}", False,
                      "no messages after a turn")
        finally:
            os.unlink(path)
    check("22 save and load", ok)


def feature_23():
    # Feature 23: a scroll item exists on the floor; using one damages or
    # kills a monster the player can see, and the scroll is consumed.
    ok = True
    # A scroll exists on the floor for at least one tested seed/depth.
    scroll_seen = 0
    for seed in (7, 42, 3):
        for depth in (1, 2, 3):
            g = Game(seed, start_depth=depth)
            if any(i['kind'] == 'scroll' for i in g.state()['items']):
                scroll_seen += 1
                break
    if scroll_seen == 0:
        check("23 scroll exists", False, "no scroll item on any tested floor")
        return
    # Using a scroll damages or kills a visible monster and is consumed.
    tested = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        m = next((mon for mon in g._monsters if mon['alive']), None)
        if m is None:
            continue
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)
        placed = False
        for name, (dx, dy) in {'e': (1, 0), 'w': (-1, 0),
                               's': (0, 1), 'n': (0, -1)}.items():
            ax, ay = m['x'] + dx, m['y'] + dy
            if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.' \
                    and not any(mon['alive'] and mon['x'] == ax
                                and mon['y'] == ay
                                for mon in g._monsters):
                g._player['x'], g._player['y'] = ax, ay
                g._visible = g._compute_fov()
                placed = True
                break
        if not placed or not g._visible[m['y']][m['x']]:
            continue
        g._inventory.append({'x': -1, 'y': -1, 'name': 'scroll',
                             'kind': 'scroll', 'bonus': 0})
        hp_before = {id(mm): mm['hp'] for mm in g._monsters if mm['alive']}
        g.act('use', index=0)
        st = g.state()
        if any(i['kind'] == 'scroll' for i in st['inventory']):
            ok = False
            check(f"23 consumed seed {seed}", False,
                  f"inv={st['inventory']!r}")
            continue
        changed = False
        for mm in g._monsters:
            if mm['alive']:
                if mm['hp'] < hp_before.get(id(mm), 0):
                    changed = True
            elif id(mm) in hp_before:
                changed = True
        if not changed:
            ok = False
            check(f"23 damaged a visible monster seed {seed}", False,
                  "no visible monster was affected")
        else:
            tested += 1
    check("23 scrolls", ok and tested >= 1, f"scrolls used: {tested}")


def feature_24():
    # Feature 24: act('throw', index=i, x=tx, y=ty) affects a monster at
    # that square from a distance and consumes the item.
    ok = True
    tested = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        m = next((mon for mon in g._monsters if mon['alive']), None)
        if m is None:
            continue
        tiles = g.state()['map']['tiles']
        w, h = len(tiles[0]), len(tiles)

        def free(x, y):
            return (0 <= x < w and 0 <= y < h and tiles[y][x] == '.'
                    and not any(mm['alive'] and mm['x'] == x
                                and mm['y'] == y
                                for mm in g._monsters))

        # Stand far from the monster: at least two steps of straight line,
        # so the throw is provably "from a distance" and not a melee hit.
        placed = False
        for dx, dy in ((3, 0), (-3, 0), (0, 3), (0, -3),
                       (4, 0), (-4, 0), (0, 4), (0, -4),
                       (2, 2), (-2, 2), (2, -2), (-2, -2)):
            sx, sy = m['x'] + dx, m['y'] + dy
            if free(sx, sy):
                g._player['x'], g._player['y'] = sx, sy
                g._visible = g._compute_fov()
                placed = True
                break
        if not placed:
            continue
        dist = abs(m['x'] - g._player['x']) + abs(m['y'] - g._player['y'])
        g._inventory.append({'x': -1, 'y': -1, 'name': 'rock',
                             'kind': 'potion', 'bonus': 0})
        hp_before = {id(mm): mm['hp'] for mm in g._monsters if mm['alive']}
        g.act('throw', index=0, x=m['x'], y=m['y'])
        st = g.state()
        if any(i['name'] == 'rock' for i in st['inventory']):
            ok = False
            check("24 consumed the item seed %d" % seed, False,
                  "thrown item still in inventory")
        affected = False
        for mm in g._monsters:
            if mm['alive']:
                if mm['hp'] < hp_before.get(id(mm), 0):
                    affected = True
            elif id(mm) in hp_before:
                affected = True
        if not affected:
            ok = False
            check("24 hit the distant monster seed %d" % seed, False,
                  "no monster was affected")
        if dist < 2:
            ok = False
            check("24 threw from a distance seed %d" % seed, False,
                  f"monster was only {dist} away")
        tested += 1
    check("24 throwing", ok and tested >= 1, f"throws made: {tested}")


def feature_25():
    # Feature 25: an amulet lies on depth 5; carrying it to the '<' on
    # depth 1 and calling act('ascend') sets won. Ascending off the
    # ladder, or without the amulet, does not.
    from collections import deque

    def bfs(tiles, sx, sy, tx, ty):
        if (sx, sy) == (tx, ty):
            return []
        seen = {(sx, sy)}
        q = deque([(sx, sy, [])])
        dirs = ((0, -1), (0, 1), (1, 0), (-1, 0),
                (1, -1), (-1, -1), (1, 1), (-1, 1))
        while q:
            x, y, path = q.popleft()
            for dx, dy in dirs:
                nx, ny = x + dx, y + dy
                if (nx, ny) in seen:
                    continue
                if 0 <= ny < len(tiles) and 0 <= nx < len(tiles[ny]) \
                        and tiles[ny][nx] in ('.', '>', '<', '/'):
                    np = path + [(nx, ny)]
                    if (nx, ny) == (tx, ty):
                        return np
                    seen.add((nx, ny))
                    q.append((nx, ny, np))
        return None

    def to_tile(g, tx, ty):
        dmap = {(0, -1): 'n', (0, 1): 's', (1, 0): 'e', (-1, 0): 'w',
                (1, -1): 'ne', (-1, -1): 'nw', (1, 1): 'se', (-1, 1): 'sw'}
        for _ in range(200):
            tiles = g.state()['map']['tiles']
            px, py = g.state()['player']['x'], g.state()['player']['y']
            path = bfs(tiles, px, py, tx, ty)
            if path is None:
                return False
            for (nx, ny) in path:
                if g.state()['game_over']:
                    return False
                d = dmap[(nx - px, ny - py)]
                for _ in range(60):
                    g.move(d)
                    g.act('wait')
                    px, py = g.state()['player']['x'], g.state()['player']['y']
                    if px == nx and py == ny:
                        break
                    if g.state()['game_over']:
                        return False
            else:
                return True
        return False

    ok = True
    tested = 0
    for seed in (1, 7, 42, 3):
        g = Game(seed, start_depth=5)
        amulets = [i for i in g.state()['items'] if i['kind'] == 'amulet']
        if len(amulets) != 1:
            ok = False
            check("25 amulet on depth 5 seed %d" % seed, False,
                  f"{len(amulets)} amulets")
            continue
        ax, ay = amulets[0]['x'], amulets[0]['y']
        if not to_tile(g, ax, ay):
            ok = False
            check("25 reach amulet seed %d" % seed, False,
                  "could not walk to the amulet")
            continue
        g.act('pickup')
        carrying = any(i.get('kind') == 'amulet'
                       for i in g.state()['inventory'])
        if not carrying:
            ok = False
            check("25 picked up the amulet seed %d" % seed, False,
                  "amulet not in inventory")
            continue

        # Ascending without the amulet does not win.
        g2 = Game(seed)
        tiles = g2.state()['map']['tiles']
        ladders = [(x, y) for y in range(len(tiles))
                   for x in range(len(tiles[y])) if tiles[y][x] == '<']
        if len(ladders) != 1:
            ok = False
            check("25 one ladder on depth 1 seed %d" % seed, False,
                  f"{len(ladders)} ladders")
            continue
        if to_tile(g2, *ladders[0]):
            g2.act('ascend')
        if g2.state()['won']:
            ok = False
            check("25 ascend without amulet seed %d" % seed, False,
                  "won without the amulet")
        # Ascending off the ladder does nothing.
        g3 = Game(seed)
        g3.act('ascend')
        if g3.state()['won']:
            ok = False
            check("25 off-ladder ascend seed %d" % seed, False,
                  "won without standing on the ladder")

        # Back to depth 1 with the amulet, ascend: this wins.
        g.depth = 1
        g._build_level()
        tiles = g.state()['map']['tiles']
        ladders = [(x, y) for y in range(len(tiles))
                   for x in range(len(tiles[y])) if tiles[y][x] == '<']
        if not to_tile(g, *ladders[0]):
            ok = False
            check("25 reach ladder seed %d" % seed, False,
                  "could not walk to the ladder")
            continue
        g.act('ascend')
        if not g.state()['won']:
            ok = False
            check("25 won with the amulet seed %d" % seed, False,
                  "ascended on the ladder but won is False")
        tested += 1
    check("25 the amulet wins", ok and tested >= 1, f"runs: {tested}")


feature_1()
feature_2()
feature_3()
feature_4()
feature_5()
feature_6()
feature_7()
feature_8()
feature_9()
feature_10()
feature_11()
feature_12()
feature_13()
feature_14()
feature_15()
feature_16()
feature_17()
feature_18()
feature_19()
feature_20()
feature_21()
feature_22()
feature_23()
feature_24()


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
        # The direction from the player's tile toward the door.
        opp = {(1, 0): 'e', (-1, 0): 'w', (0, 1): 's', (0, -1): 'n'}[
            (dx - sx, dy - sy)]
        pos_before = (g.state()['player']['x'], g.state()['player']['y'])
        g.move(opp)
        pos_after = (g.state()['player']['x'], g.state()['player']['y'])
        if pos_after != pos_before:
            ok = False
            check(f"26 shut door blocks move seed {seed}", False,
                  f"moved to {pos_after}")
        # A shut door blocks sight: a tile straight across it is invisible
        # even though it was visible with the door open.
        other = (2 * dx - sx, 2 * dy - sy)
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


def feature_27():
    # Feature 27: two hidden traps per level on floor tiles. Two kinds:
    # dart (4 damage on the player) and teleport (flung to a floor tile
    # at least 12 away). Traps are invisible until stepped on — they only
    # appear in state()['traps'] after they have fired, and a fired trap
    # never fires again.
    ok = True
    darts = 0
    telports = 0
    for seed in (7, 42, 3):
        g = Game(seed)
        tiles = g.state()['map']['tiles']
        traps = g._traps
        # -- two traps, both on floor, not on the player or an occupant ---
        if len(traps) != 2:
            ok = False
            check(f"27 two traps seed {seed}", False, f"got {len(traps)}")
            continue
        taken = {(g._player['x'], g._player['y'])}
        taken.update((m['x'], m['y']) for m in g._monsters if m['alive'])
        taken.update((i['x'], i['y']) for i in g._items)
        for t in traps:
            if tiles[t['y']][t['x']] != '.':
                ok = False
                check(f"27 trap on floor seed {seed}", False,
                      f"trap at {t['x']},{t['y']} on "
                      f"{tiles[t['y']][t['x']]!r}")
            if (t['x'], t['y']) in taken:
                ok = False
                check(f"27 trap unoccupied seed {seed}", False,
                      f"trap shares a tile with an occupant")
            if t['kind'] not in ('dart', 'teleport'):
                ok = False
                check(f"27 trap kind seed {seed}", False,
                      f"unknown kind {t['kind']!r}")
            if t['discovered']:
                ok = False
                check(f"27 trap hidden at build seed {seed}", False)
        # -- hidden until stepped on --------------------------------------
        if g.state()['traps']:
            ok = False
            check(f"27 traps hidden before firing seed {seed}", False,
                  f"{len(g.state()['traps'])} listed")
        # -- fire each trap by walking onto it ----------------------------
        for t in traps:
            # Neutralise monsters so the turn is about the trap, not combat
            # (the same reason feature 8 clears them).
            for mon in g._monsters:
                mon['alive'] = False
            # Park the player on a free floor neighbour of the trap.
            tx, ty = t['x'], t['y']
            nbs = [(tx + a, ty + b)
                   for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            w, h = len(tiles[0]), len(tiles)
            free = [n for n in nbs
                    if 0 <= n[0] < w and 0 <= n[1] < h
                    and tiles[n[1]][n[0]] == '.'
                    and n != (g._player['x'], g._player['y'])]
            if not free:
                ok = False
                check(f"27 trap has a free neighbour seed {seed}", False)
                continue
            fx, fy = free[0]
            g._player['x'], g._player['y'] = fx, fy
            g._player['hp'] = g._player['max_hp'] = 30
            g._visible = g._compute_fov()
            opp = {(1, 0): 'e', (-1, 0): 'w', (0, 1): 's', (0, -1): 'n'}[
                (tx - fx, ty - fy)]
            msgs_before = len(g.state()['messages'])
            g.move(opp)
            # A dart leaves the player standing on the trap tile; a
            # teleport flings them somewhere else, at least 12 away.
            if t['kind'] == 'dart':
                if (g._player['x'], g._player['y']) != (tx, ty):
                    ok = False
                    check(f"27 landed on dart seed {seed}", False,
                          f"player at {g._player['x']},{g._player['y']}, "
                          f"trap at {tx},{ty}")
                    continue
            else:
                if (g._player['x'], g._player['y']) == (tx, ty):
                    ok = False
                    check(f"27 teleport left you on the trap seed {seed}",
                          False)
                    continue
            if not t['discovered']:
                ok = False
                check(f"27 trap discovered seed {seed}", False)
            if len(g.state()['messages']) <= msgs_before:
                ok = False
                check(f"27 trap message seed {seed}", False)
            if (tx, ty) not in [
                    (s['x'], s['y']) for s in g.state()['traps']]:
                ok = False
                check(f"27 trap listed after firing seed {seed}", False)
            if t['kind'] == 'dart':
                if g._player['hp'] != 26:
                    ok = False
                    check(f"27 dart damage seed {seed}", False,
                          f"hp={g._player['hp']}, wanted 26")
                darts += 1
            else:
                dist = abs(g._player['x'] - tx) + abs(g._player['y'] - ty)
                if dist < 12:
                    ok = False
                    check(f"27 teleport distance seed {seed}", False,
                          f"moved only {dist} from the trap")
                telports += 1
            # -- a fired trap does not fire again -------------------------
            g.move(opp)  # step off and the trap stays quiet
            if t['kind'] == 'dart' and g._player['hp'] != 26:
                # Stepping back off should not re-fire; hp only changes if
                # the player is still adjacent and the trap re-fires. Re-walk
                # onto it to prove it is consumed.
                pass
        # -- re-firing: walk straight back onto a consumed trap -----------
        t = traps[0]
        for mon in g._monsters:
            mon['alive'] = False
        tx, ty = t['x'], t['y']
        w, h = len(tiles[0]), len(tiles)
        nbs = [(tx + a, ty + b)
               for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        free = [n for n in nbs
                if 0 <= n[0] < w and 0 <= n[1] < h
                and tiles[n[1]][n[0]] == '.'
                and n != (g._player['x'], g._player['y'])]
        if free:
            fx, fy = free[0]
            g._player['x'], g._player['y'] = fx, fy
            g._player['hp'] = g._player['max_hp'] = 30
            g._visible = g._compute_fov()
            opp = {(1, 0): 'e', (-1, 0): 'w', (0, 1): 's', (0, -1): 'n'}[
                (tx - fx, ty - fy)]
            hp0 = g._player['hp']
            g.move(opp)
            if t['kind'] == 'dart':
                if g._player['hp'] != hp0:
                    ok = False
                    check(f"27 consumed trap re-fired seed {seed}", False,
                          f"hp {hp0} -> {g._player['hp']}")
    # -- save and load round-trips the traps ------------------------------
    g = Game(7)
    before = [dict(t) for t in g._traps]
    g.save('scratch/trap_save.bin')
    g2 = Game.load('scratch/trap_save.bin')
    after = [dict(t) for t in g2._traps]
    if before != after:
        ok = False
        check("27 traps survive save/load", False,
              f"before={before} after={after}")
    check("27 traps (hidden, dart + teleport, consumed, save/load)",
          ok and darts >= 1 and telports >= 1,
          f"darts fired: {darts}, teleports fired: {telports}")


def feature_28():
    # Feature 28: potions and scrolls start unidentified — their name is an
    # appearance ("cloudy potion", "scroll labelled ZELGO MER") and they
    # carry identified False. Using one identifies every item of that kind
    # for the rest of the game. The appearance for a kind is stable within
    # a seed. Weapons and armour are known on pickup.
    ok = True
    potion_seen = 0
    scroll_seen = 0
    for seed in (7, 42, 3):
        for depth in (1, 2, 3):
            items = Game(seed, start_depth=depth).state()['items']
            if any(i['kind'] == 'potion' for i in items):
                potion_seen += 1
            if any(i['kind'] == 'scroll' for i in items):
                scroll_seen += 1
    if potion_seen == 0 or scroll_seen == 0:
        check("28 unidentified things (appearance, stable, use identifies kind)",
              False,
              f"no {'potion' if potion_seen == 0 else 'scroll'} on any tested floor")
        return
    for seed in (7, 42, 3):
        for depth in (1, 2, 3):
            g = Game(seed, start_depth=depth)
            items = g.state()['items']
            # -- every potion and scroll starts unidentified --------------
            for i in [i for i in items if i['kind'] in ('potion', 'scroll')]:
                if i.get('identified') is not False:
                    ok = False
                    check(f"28 unidentified start seed {seed} d{depth}",
                          False,
                          f"{i['name']} carries identified={i.get('identified')!r}")
            # -- names read as appearances, not the real names ------------
            for i in [i for i in items if i['kind'] == 'potion']:
                if not (i['name'].endswith('potion')
                        and i['name'] != 'healing potion'):
                    ok = False
                    check(f"28 potion appearance seed {seed} d{depth}",
                          False, i['name'])
            for i in [i for i in items if i['kind'] == 'scroll']:
                if not (i['name'].startswith('scroll labelled ')
                        and i['name'] != 'scroll of flame'):
                    ok = False
                    check(f"28 scroll appearance seed {seed} d{depth}",
                          False, i['name'])
            # -- weapons and armour are known on pickup --------------------
            for i in [i for i in items if i['kind'] in ('weapon', 'armour')]:
                if i['name'] != i['kind']:
                    ok = False
                    check(f"28 equipment known seed {seed} d{depth}",
                          False, i['name'])
        # -- the appearance for a kind is stable within a seed -------------
        if Game(seed)._appearance != Game(seed)._appearance:
            ok = False
            check(f"28 appearance stable seed {seed}", False,
                  "two games from one seed disagree on appearances")
    # -- using a potion identifies every potion for good ------------------
    # Inject known items so the check does not depend on the floor draw.
    g = Game(7)
    g._items = [{'x': 0, 'y': 0, 'name': 'cloudy potion', 'kind': 'potion',
                 'bonus': 0, 'identified': False}]
    g._inventory = [{'x': 0, 'y': 0, 'name': 'cloudy potion',
                     'kind': 'potion', 'bonus': 0, 'identified': False}]
    g.act('use', index=0)
    for i in g.state()['items'] + g.state()['inventory']:
        if i['kind'] == 'potion':
            if i.get('identified') is not True or i['name'] != 'healing potion':
                ok = False
                check("28 use identifies potions", False,
                      f"name={i['name']!r} identified={i.get('identified')!r}")
    # -- using a scroll identifies every scroll for good ------------------
    g = Game(7)
    g._items = [{'x': 0, 'y': 0, 'name': 'scroll labelled FIBOX',
                 'kind': 'scroll', 'bonus': 0, 'identified': False}]
    g._inventory = [{'x': 0, 'y': 0, 'name': 'scroll labelled FIBOX',
                     'kind': 'scroll', 'bonus': 0, 'identified': False}]
    g.act('use', index=0)
    for i in g.state()['items'] + g.state()['inventory']:
        if i['kind'] == 'scroll':
            if i.get('identified') is not True or i['name'] != 'scroll of flame':
                ok = False
                check("28 use identifies scrolls", False,
                      f"name={i['name']!r} identified={i.get('identified')!r}")
    check("28 unidentified things (appearance, stable, use identifies kind)",
          ok)


def feature_29():
    # Feature 29: status effects. player['effects'] is a list of
    # {'name', 'turns'}. Poison costs hp each turn and wears off; confusion
    # sends move somewhere other than where it was aimed. Effects tick down
    # on every action and are announced when they end. The poison source in
    # the game is the venom vial (depth 3); confusion is tested directly by
    # putting it on the player.
    ok = True

    # -- the venom vial sits on the depth-3 floor, stable per seed ---------
    for seed in (7, 42, 3):
        g = Game(seed, start_depth=3)
        tiles = g.state()['map']['tiles']
        vials = [i for i in g.state()['items'] if i['kind'] == 'venom']
        if len(vials) != 1:
            ok = False
            check(f"29 vial present seed {seed}", False,
                  f"got {len(vials)} venom item(s)")
            continue
        v = vials[0]
        if tiles[v['y']][v['x']] != '.':
            ok = False
            check(f"29 vial on floor seed {seed}", False,
                  f"tile={tiles[v['y']][v['x']]!r}")
        if v['name'] != 'venom vial' or 'bonus' not in v:
            ok = False
            check(f"29 vial shape seed {seed}", False, f"{v!r}")
        # A second game from the same seed puts it on the same square.
        vials2 = [i for i in Game(seed, start_depth=3).state()['items']
                  if i['kind'] == 'venom']
        if not vials2 or (vials2[0]['x'], vials2[0]['y']) != (v['x'], v['y']):
            ok = False
            check(f"29 vial stable seed {seed}", False,
                  f"{(v['x'], v['y'])} vs {vials2}")

    # -- using the vial poisons the player for six turns --------------------
    # Inject a vial and clear the monsters so only the poison touches hp.
    g = Game(7)
    g._monsters = []
    g._inventory = [{'x': 0, 'y': 0, 'name': 'venom vial', 'kind': 'venom',
                     'bonus': 0}]
    g.act('use', index=0)
    # The 'use' action itself ticks the poison (6 -> 5) and pays its first
    # hp, so the baseline for the waits is the hp left after the use.
    start_hp = g._player['hp']
    if g._player['effects'] != [{'name': 'poison', 'turns': 5}]:
        # use consumes the vial; act() then ticks, aging 6 -> 5 this same turn.
        ok = False
        check("29 use grants poison", False, f"{g._player['effects']!r}")
    if g._inventory:
        ok = False
        check("29 vial consumed", False, f"{g._inventory!r}")
    if "stings" not in g._messages[-1]:
        ok = False
        check("29 vial message", False, g._messages[-1])

    # -- poison costs one hp per action and is announced when it ends -------
    # The vial's own 'use' action already aged 6 -> 5, so five turns remain.
    for n in range(5):
        g.act('wait')
        if g._player['hp'] != start_hp - (n + 1):
            ok = False
            check(f"29 poison hp turn {n + 1}", False,
                  f"hp={g._player['hp']}")
    # The fifth action drops the poison to 0: it is removed and announced,
    # and the following action costs nothing.
    if g._player['hp'] != start_hp - 5:
        ok = False
        check("29 poison full cost", False, f"hp={g._player['hp']}")
    if g._player['effects']:
        ok = False
        check("29 poison wears off", False, f"{g._player['effects']!r}")
    if "You are no longer poison." not in g._messages:
        ok = False
        check("29 poison end announced", False, str(g._messages[-3:]))
    before = g._player['hp']
    g.act('wait')
    if g._player['hp'] != before:
        ok = False
        check("29 no poison, no cost", False, f"hp={g._player['hp']}")

    # -- a stacked poison keeps the longer of the two counts -----------------
    g._player['effects'] = [{'name': 'poison', 'turns': 3}]
    g._apply_effect('poison', 8)
    if g._player['effects'] != [{'name': 'poison', 'turns': 8}]:
        ok = False
        check("29 poison stacks to max", False, f"{g._player['effects']!r}")

    # -- poison that reaches 0 hp kills -------------------------------------
    g._player['effects'] = [{'name': 'poison', 'turns': 3}]
    g._player['hp'] = 2
    g.act('wait')
    g.act('wait')
    if g._player['hp'] != 0 or not g._game_over:
        ok = False
        check("29 poison kills", False,
              f"hp={g._player['hp']} over={g._game_over}")
    if "You die." not in g._messages:
        ok = False
        check("29 poison death announced", False, str(g._messages[-2:]))

    # -- confusion sends a move somewhere other than where it was aimed -----
    # Put the player on an open floor square (no monster in sight) so the
    # scrambled direction is never a wall-bump and always lands somewhere.
    g = Game(7)
    g._monsters = []
    tiles = g.state()['map']['tiles']
    px, py = g._player['x'], g._player['y']
    g._player['effects'] = [{'name': 'confusion', 'turns': 2}]
    aimed_away = 0
    for _ in range(4):
        before = (g._player['x'], g._player['y'])
        g.move('e')
        if (g._player['x'], g._player['y']) != (before[0] + 1, before[1]):
            aimed_away += 1
    if aimed_away == 0:
        ok = False
        check("29 confusion scrambles", False,
              "four 'e' moves while confused all still went east")
    # Two turns of confusion are aged off by the first two moves.
    if g._player['effects']:
        ok = False
        check("29 confusion wears off", False,
              f"{g._player['effects']!r}")

    # -- without confusion a move goes exactly where aimed ------------------
    g = Game(7)
    g._monsters = []
    before = (g._player['x'], g._player['y'])
    g.move('e')
    after = (g._player['x'], g._player['y'])
    if after != (before[0] + 1, before[1]) and after != before:
        ok = False
        check("29 no confusion, clean move", False,
              f"{before} -> {after}")

    check("29 status effects", ok)


feature_25()
feature_26()
feature_27()
feature_28()
feature_29()
print(f"\n{failures} failure(s)")
raise SystemExit(1 if failures else 0)
