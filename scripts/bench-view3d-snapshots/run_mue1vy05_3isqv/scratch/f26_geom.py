"""One-off: reproduce the seed-7 door sight failure and print the geometry."""
import sys
sys.path.insert(0, '.')
from engine import Game

for seed in (7, 11):
    g = Game(seed)
    tiles = g.state()['map']['tiles']
    w, h = len(tiles[0]), len(tiles)
    door = None
    for (dx, dy) in [(x, y) for y in range(h)
                     for x in range(w) if tiles[y][x] == '/']:
        nbs = [(dx + a, dy + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        free = [n for n in nbs
                if 0 <= n[0] < w and 0 <= n[1] < h
                and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
        if len(free) >= 2:
            door = (dx, dy)
            break
    dx, dy = door
    free = [(dx + a, dy + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))]
    free = [n for n in free
            if 0 <= n[0] < w and 0 <= n[1] < h
            and tiles[n[1]][n[0]] in ('.', '/', '<', '>')]
    sx, sy = free[0]
    g._player['x'], g._player['y'] = sx, sy
    g._visible = g._compute_fov()
    g.act('close', x=dx, y=dy)
    other_buggy = (dx - (sx - dx), dy - (sy - sy))
    other_correct = (dx - (sx - dx), dy - (sy - dy))
    vis = g.state()['visible']
    print(f"seed {seed}: door={door} player={(sx, sy)}")
    print(f"  buggy   other={other_buggy} tile={tiles[other_buggy[1]][other_buggy[0]]!r} visible={vis[other_buggy[1]][other_buggy[0]]}")
    print(f"  correct other={other_correct} tile={tiles[other_correct[1]][other_correct[0]]!r} visible={vis[other_correct[1]][other_correct[0]]}")
    # show 5x5 neighbourhood
    for yy in range(dy - 2, dy + 3):
        row = ''.join(tiles[yy][xx] if 0 <= xx < w else ' '
                      for xx in range(dx - 2, dx + 3))
        mark = ' <-door-row' if yy == dy else ''
        print(f"  y={yy}: {row}{mark}")
