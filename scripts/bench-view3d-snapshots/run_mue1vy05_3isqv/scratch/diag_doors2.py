"""Check monster sight + pathing to player after door re-placement."""
import sys
sys.path.insert(0, '.')
from engine import Game

ok_all = True
for seed in (7, 42, 3, 11, 99):
    g = Game(seed)
    s = g.state()
    tiles = s['map']['tiles']
    p = s['player']
    doors = [(x, y) for y in range(len(tiles))
             for x in range(len(tiles[y])) if tiles[y][x] == '+']
    see = [m['name'] for m in s['monsters']
           if m['alive'] and g._monster_sees(m)]
    paths = [(m['name'], bool(g._bfs(m['x'], m['y'], p['x'], p['y'])))
             for m in s['monsters'] if m['alive']]
    any_see = len(see) > 0
    any_path = any(ok for _, ok in paths)
    ok_all = ok_all and any_see and any_path
    print('seed %d: player=(%d,%d) doors=%d sees=%s paths=%s'
          % (seed, p['x'], p['y'], len(doors), see, paths))
    for (dx, dy) in doors:
        print('   door at (%d,%d) manhattan=%d'
              % (dx, dy, abs(dx - p['x']) + abs(dy - p['y'])))
print('ALL SEE+PATH:', ok_all)
