"""One-pass audit of unticked features (12-34) against what engine.py
actually does. Read-only: no engine changes. Prints one verdict line each."""
import os
import sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import Game


def floor_reach(g, sx, sy, tx, ty):
    tiles = g._map()['tiles']
    w, h = len(tiles[0]), len(tiles)

    def walkable(x, y):
        t = tiles[y][x]
        return t in ('.', '>', '<') and g._monster_at(x, y) is None

    seen, q = {(sx, sy)}, deque([(sx, sy)])
    while q:
        x, y = q.popleft()
        if (x, y) == (tx, ty):
            return True
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and walkable(nx, ny):
                seen.add((nx, ny))
                q.append((nx, ny))
    return False


def adjacent_floor(g, x, y):
    tiles = g._map()['tiles']
    w, h = len(tiles[0]), len(tiles)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and tiles[ny][nx] == '.':
            return (nx, ny)
    return None


def f12():
    g = Game(7)
    m = next(mon for mon in g._monsters if mon['alive'])
    adj = adjacent_floor(g, m['x'], m['y'])
    ax, ay = adj
    g._player['x'], g._player['y'] = ax, ay
    d = 'w' if ax > m['x'] else 'e'
    for _ in range(4):
        g.move(d)
        if not m['alive']:
            break
    g.move(d)
    blocked = (g.state()['player']['x'], g.state()['player']['y']) != (m['x'], m['y'])
    # player death: force a seeing monster adjacent and wait
    g2 = Game(42)
    t = next((m for m in g2._monsters if m['alive'] and g2._monster_sees(m)), None)
    died = False
    if t:
        adj = adjacent_floor(g2, g2.state()['player']['x'], g2.state()['player']['y'])
        t['x'], t['y'] = adj
        for _ in range(300):
            g2.act('wait')
            if g2.state()['game_over']:
                died = True
                break
    frozen = True
    if died:
        st = g2.state()
        g2.move('e'); g2.act('wait'); g2.act('descend')
        a = g2.state()
        frozen = (a['player'] == st['player'] and a['depth'] == st['depth']
                  and a['game_over'])
    print(f"12 death: monster-death-not-blocking={not blocked}, player-death={died}, frozen={frozen}")


def f13():
    g = Game(7)
    m = next(mon for mon in g._monsters if mon['alive'])
    adj = adjacent_floor(g, m['x'], m['y'])
    ax, ay = adj
    g._player['x'], g._player['y'] = ax, ay
    d = 'w' if ax > m['x'] else 'e'
    g.move(d)
    lines = g.state()['messages']
    atk = any(f"You hit the {m['name']}" in l for l in lines)
    hit = any(f"{m['name']} hits you" in l for l in lines)
    # monster attacks on a wait while adjacent
    for _ in range(50):
        g.act('wait')
        if g.state()['game_over']:
            break
        if any(f"{m['name']} hits you" in l for l in g.state()['messages']):
            hit = True
            break
    death = any(f"{m['name']} dies." in l for l in g.state()['messages'])
    print(f"13 messages: attack-line={atk}, damage-line={hit}, death-line={death}")


def f14_18():
    print("14 items: 'items' in state:", 'items' in Game(7).state())
    print("15 pickup: act('pickup') supported:", False)  # engine has no items at all


def f19_21():
    names = set()
    for d in range(1, 6):
        g = Game(7, start_depth=d)
        for m in g._monsters:
            names.add((m['name'], m['max_hp']))
    print(f"19 bestiary: distinct names d1-5 = {len(set(n for n, _ in names))} -> {sorted(set(n for n, _ in names))}")
    g1 = Game(7, start_depth=1)
    g5 = Game(7, start_depth=5)
    a1 = [m['max_hp'] for m in g1._monsters]
    a5 = [m['max_hp'] for m in g5._monsters]
    print(f"20 worse down: avg d1 = {sum(a1)/len(a1) if a1 else 0:.2f}, avg d5 = {sum(a5)/len(a5) if a5 else 0:.2f}")
    print(f"21 xp: player keys = {sorted(Game(7).state()['player'].keys())}")


def f22_25():
    try:
        g = Game(7)
        g.save('scratch/save.json')
        ok = 'no raise'
    except NotImplementedError:
        ok = 'NotImplementedError'
    print(f"22 save/load: {ok}")
    print("23 scrolls: no items exist -> False")
    print("24 throwing: no items exist -> False")
    am = False
    for d in range(1, 6):
        g = Game(7, start_depth=d)
        if 'amulet' in str(getattr(g, '_items', None)):
            am = True
    print(f"25 amulet on depth 5: {am} (no items key in engine)")


def f26_34():
    print("26 doors: no door tiles in engine -> False")
    print("27 traps: no 'traps' key -> False")
    print("28 unidentified: no items -> False")
    print("29 status: player has no 'effects' -> False")
    print("30 traits: no monster has 'trait' -> False")
    print("31 ranged: monsters only melee -> False")
    print("32 hunger: player has no 'nutrition' -> False")
    print("33 boss: no monster has 'boss' -> False")
    st = Game(7).state()
    print(f"34 score/epitaph: keys present = {'score' in st, 'epitaph' in st}")


f12()
f13()
f14_18()
f19_21()
f22_25()
f26_34()
print("audit done")
