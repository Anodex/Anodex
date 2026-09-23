import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import Game

def bfs_path(tiles, sx, sy, tx, ty):
    from collections import deque
    if (sx, sy) == (tx, ty):
        return []
    seen = {(sx, sy)}
    q = deque([(sx, sy, [])])
    dirs = [(0,-1),(0,1),(1,0),(-1,0),(1,-1),(-1,-1),(1,1),(-1,1)]
    while q:
        x, y, path = q.popleft()
        for dx, dy in dirs:
            nx, ny = x+dx, y+dy
            if (nx, ny) in seen:
                continue
            if 0 <= ny < len(tiles) and 0 <= nx < len(tiles[ny]) \
                    and tiles[ny][nx] in ('.', '>', '<'):
                np = path + [(nx, ny)]
                if (nx, ny) == (tx, ty):
                    return np
                seen.add((nx, ny))
                q.append((nx, ny, np))
    return None

def to_tile(g, tx, ty):
    """Walk the player to (tx,ty) along a BFS path; wait out monsters."""
    for _ in range(200):  # outer loop: restart if the walk dead-ended
        tiles = g.state()['map']['tiles']
        px, py = g.state()['player']['x'], g.state()['player']['y']
        path = bfs_path(tiles, px, py, tx, ty)
        if path is None:
            return False
        for (nx, ny) in path:
            if g.state()['game_over']:
                break
            dmap = {(0,-1):'n',(0,1):'s',(1,0):'e',(-1,0):'w',
                    (1,-1):'ne',(-1,-1):'nw',(1,1):'se',(-1,1):'sw'}
            px, py = g.state()['player']['x'], g.state()['player']['y']
            d = dmap[(nx-px, ny-py)]
            for _ in range(60):  # inner: wait for a monster to leave
                g.move(d)
                g.act('wait')
                if g.state()['player']['x'] == nx and \
                        g.state()['player']['y'] == ny:
                    break
                if g.state()['game_over']:
                    return False
        else:
            return True
    return False

def ladder_at(g):
    tiles = g.state()['map']['tiles']
    pts = [(x, y) for y in range(len(tiles)) for x in range(len(tiles[y]))
           if tiles[y][x] == '<']
    assert len(pts) == 1, f"exactly one ladder, got {pts}"
    return pts[0]

fails = 0
for seed in (1, 7, 42, 3):
    g2 = Game(seed, start_depth=5)
    amulets = [i for i in g2.state()['items'] if i['kind'] == 'amulet']
    if len(amulets) != 1:
        print(f"seed={seed} FAIL amulet count {len(amulets)}")
        fails += 1
        continue
    ax, ay = amulets[0]['x'], amulets[0]['y']
    got = to_tile(g2, ax, ay)
    if got:
        g2.act('pickup')
    carrying = any(i.get('kind') == 'amulet' for i in g2.state()['inventory'])
    print(f"seed={seed} picked up: {carrying} (walk ok: {got}, "
          f"game_over: {g2.state()['game_over']})")
    if not carrying:
        fails += 1
        continue
    # fresh game: ascend without the amulet must not win
    g3 = Game(seed)
    lx, ly = ladder_at(g3)
    ok = to_tile(g3, lx, ly)
    if ok:
        g3.act('ascend')
    won_no = g3.state()['won']
    print(f"seed={seed} ascend w/o amulet: won={won_no} (expect False) "
          f"msg={g3.state()['messages'][-1]!r}")
    if won_no:
        fails += 1
    # ascend without standing on the ladder must not win
    g4 = Game(seed, start_depth=5)
    g4.act('ascend')
    if g4.state()['won']:
        print(f"seed={seed} FAIL: ascended off-ladder")
        fails += 1
    # back to depth 1 with the amulet and ascend
    g2.depth = 1
    g2._build_level()
    lx, ly = ladder_at(g2)
    ok = to_tile(g2, lx, ly)
    if ok:
        g2.act('ascend')
    won = g2.state()['won']
    print(f"seed={seed} ascend with amulet: won={won} (expect True) "
          f"msg={g2.state()['messages'][-1]!r} (walk ok: {ok})")
    if not won:
        fails += 1
    # save/load round-trip preserves won
    import tempfile
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        pth = tf.name
    g2.save(pth)
    g5 = Game.load(pth)
    if g5.state()['won'] != won:
        print(f"seed={seed} FAIL: save/load lost won")
        fails += 1
print("FAILS:", fails)
sys.exit(1 if fails else 0)
