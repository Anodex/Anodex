"""Diagnose feature 26 regressions: do shut doors block monster LOS/pathing?"""
from engine import Game

for seed in (7, 42, 3, 11, 99):
    g = Game(seed)
    s = g.state()
    tiles = s['map']['tiles']
    p = s['player']
    doors = [(x, y) for y in range(len(tiles)) for x in range(len(tiles[y]))
             if tiles[y][x] in ('+', '/')]
    see = [m['name'] for m in s['monsters'] if m['alive'] and g._monster_sees(m)]
    # Can each monster path to the player right now?
    paths = []
    for m in s['monsters']:
        if not m['alive']:
            continue
        path = g._bfs(m['x'], m['y'], p['x'], p['y'])
        paths.append((m['name'], bool(path)))
    print(f"seed {seed}: player=({p['x']},{p['y']}) doors={len(doors)} "
          f"seeing_player={see} bfs_reaches_player={paths}")
    # What tile is the player on, and where are the doors relative to the start room?
    for d in doors:
        dist = abs(d[0] - p['x']) + abs(d[1] - p['y'])
        print(f"   door {d} tile={tiles[d[1]][d[0]]!r} manhattan_dist_to_player={dist}")
