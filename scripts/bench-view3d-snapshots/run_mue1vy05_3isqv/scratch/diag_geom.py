import sys
sys.path.insert(0, '.')
from engine import Game

g = Game(3, start_depth=1)
tiles = g.state()['map']['tiles']
rooms = g._rooms
print("rooms:", rooms)
print("player:", g.state()['player']['x'], g.state()['player']['y'])
for i in range(len(rooms) - 1):
    a, b = rooms[i], rooms[i + 1]
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = ax + aw // 2, ay + ah // 2
    x2, y2 = bx + bw // 2, by + bh // 2
    print(f"corr {i}: A=({ax},{ay},{aw},{ah}) c1=({x1},{y1}) B=({bx},{by},{bw},{bh}) c2=({x2},{y2})")
    # the door tiles the code placed
    if x1 != x2:
        ad = (ax + (aw - 1 if x2 > x1 else 0), y1)
    else:
        ad = (x1, ay + (ah - 1 if y2 > y1 else 0))
    if y1 != y2:
        bd = (x2, by + (bh - 1 if y1 > y2 else 0))
    else:
        bd = (bx + (bw - 1 if x2 > x1 else 0), y2)
    print(f"  doorA={ad} tile={tiles[ad[1]][ad[0]]!r}  doorB={bd} tile={tiles[bd[1]][bd[0]]!r}")
    # Is the door tile actually on the corridor path?
    on_path_a = (ad[1] == y1 and min(x1, x2) <= ad[0] <= max(x1, x2)) or (ad[0] == x2 and min(y1, y2) <= ad[1] <= max(y1, y2))
    on_path_b = (bd[1] == y2 and min(x1, x2) <= bd[0] <= max(x1, x2)) or (bd[0] == x2 and min(y1, y2) <= bd[1] <= max(y1, y2))
    print(f"  doorA on corridor? {on_path_a}   doorB on corridor? {on_path_b}")
    # print a slice of tiles around the door
    for y in range(max(0, ad[1] - 2), min(len(tiles), ad[1] + 3)):
        row = "".join(tiles[y][x] for x in range(max(0, min(ad[0], bd[0]) - 3), min(len(tiles[0]), max(ad[0], bd[0]) + 4)))
        print(f"  y={y}: {row}")
