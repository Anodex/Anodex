"""Trace seed 3 depth 1: show rooms, corridors, doors and which '.' tiles
the doors replace, so we can see exactly which leg a door severs."""
import sys
sys.path.insert(0, '.')
from engine import Game

g = Game(3)
s = g.state()
tiles = s['map']['tiles']
rooms = g._rooms
print('rooms:', rooms)
p = s['player']
print('player:', p['x'], p['y'])

for i in range(len(rooms) - 1):
    a, b = rooms[i], rooms[i + 1]
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = ax + aw // 2, ay + ah // 2
    x2, y2 = bx + bw // 2, by + bh // 2
    print(f'\ncorr {i}: A={a} center1=({x1},{y1})  B={b} center2=({x2},{y2})')
    print(f'  H-leg: row y={y1}, x from {x1} to {x2}')
    print(f'  V-leg: col x={x2}, y from {y1} to {y2}')
    # A's door
    if x1 != x2:
        dxa = ax + aw - 1 + (1 if x2 > x1 else -1)
        print(f'  A door (H): ({dxa},{y1}) tile={tiles[y1][dxa]!r}')
    else:
        dya = ay + ah - 1 + (1 if y2 > y1 else -1)
        print(f'  A door (V): ({x1},{dya}) tile={tiles[dya][x1]!r}')
    # B's door
    if y1 != y2:
        dyb = by + bh - 1 + (1 if y1 > y2 else -1)
        print(f'  B door (V): ({x2},{dyb}) tile={tiles[dyb][x2]!r}')
    else:
        dxb = bx + bw - 1 + (1 if x2 > x1 else -1)
        print(f'  B door (H): ({dxb},{y2}) tile={tiles[y2][dxb]!r}')
    # Show the rows/cols around the legs
    for y in range(max(0, min(y1, y2) - 1), min(24, max(y1, y2) + 2)):
        row = ''.join(tiles[y][x] for x in range(len(tiles[0])))
        print(f'  y={y:2d}: {row}')

print('\nAll door tiles on map:')
doors = [(x, y) for y in range(len(tiles)) for x in range(len(tiles[y])) if tiles[y][x] == '+']
for (x, y) in sorted(doors, key=lambda t: (t[1], t[0])):
    print(f'  ({x},{y})')
