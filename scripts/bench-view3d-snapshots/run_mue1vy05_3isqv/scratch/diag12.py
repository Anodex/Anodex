import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import Game

D = {'e': (1, 0), 'w': (-1, 0), 's': (0, 1), 'n': (0, -1)}
INV = {(-dx, -dy): name for name, (dx, dy) in D.items()}

for seed in (7, 42, 3, 11, 99):
    g = Game(seed)
    tiles = g.state()['map']['tiles']
    w, h = len(tiles[0]), len(tiles)
    m = next(mon for mon in g._monsters if mon['alive'])
    mx, my = m['x'], m['y']
    name = None
    for nm, (dx, dy) in D.items():
        ax, ay = mx + dx, my + dy
        if 0 <= ax < w and 0 <= ay < h and tiles[ay][ax] == '.':
            name = nm
            break
    if name is None:
        print(seed, 'no adjacent floor tile')
        continue
    dx, dy = D[name]
    g._player['x'], g._player['y'] = mx + dx, my + dy
    # The OLD test moved `name` here (away from the monster).
    # The FIX moves INV[(dx, dy)] — the opposite direction, INTO the monster.
    toward = INV[(dx, dy)]
    hp_before = m['hp']
    g.move(toward)
    print(f"seed {seed}: monster ({mx},{my}) {m['name']} hp {hp_before} "
          f"-> {m['hp']} alive={m['alive']} (bump toward via {toward!r})")
