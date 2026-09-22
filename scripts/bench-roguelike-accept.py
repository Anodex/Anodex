#!/usr/bin/env python3
"""The hidden acceptance suite for the roguelike benchmark.

Never written into the workspace, so nothing can be built to satisfy the tests
instead of the spec.

Every finished feature is checked after every run, not just the new one. That
is the whole point: the question this benchmark exists to answer is whether an
agent breaks what it already built, and a suite that only checked the latest
feature could not see it happen.

Each check is isolated — an engine that raises on feature 11 still gets graded
on features 1 to 10, because "it crashed" and "it regressed" are different
answers and a five-hour run deserves the difference.

Usage: python scripts/bench-roguelike-accept.py <workspace> [--json]
"""
import importlib
import json
import os
import sys
import tempfile


def load_engine(workspace):
    """Import engine.py out of a workspace, fresh each time."""
    sys.path.insert(0, os.path.abspath(workspace))
    for name in ('engine',):
        if name in sys.modules:
            del sys.modules[name]
    return importlib.import_module('engine')


def new_game(engine, seed=42):
    return engine.Game(seed)


def floor_tiles(state):
    tiles = state['map']['tiles']
    return [
        (x, y)
        for y, row in enumerate(tiles)
        for x, char in enumerate(row)
        if char in '.<>'
    ]


def _passable(state, allow=()):
    """Floor squares a player could stand on, minus anything living in the way."""
    tiles = state['map']['tiles']
    blocked = {
        (m['x'], m['y'])
        for m in state.get('monsters', [])
        if m.get('alive', True) and (m['x'], m['y']) not in allow
    }
    return {
        (x, y)
        for y, row in enumerate(tiles)
        for x, char in enumerate(row)
        if char in '.<>' and (x, y) not in blocked
    }


def _route(state, target):
    """Shortest path to a square, or None. Breadth-first, eight-way."""
    from collections import deque

    start = (state['player']['x'], state['player']['y'])
    if start == target:
        return []
    open_squares = _passable(state, allow={target})
    open_squares.add(start)
    if target not in open_squares:
        return None
    came = {start: None}
    queue = deque([start])
    while queue:
        current = queue.popleft()
        if current == target:
            break
        x, y = current
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                       (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nxt = (x + dx, y + dy)
            if nxt in open_squares and nxt not in came:
                came[nxt] = current
                queue.append(nxt)
    if target not in came:
        return None
    path = []
    node = target
    while node != start:
        path.append(node)
        node = came[node]
    return list(reversed(path))


def walk_to(game, x, y, limit=500):
    """Walk the player to a square, re-planning when the world moves.

    Breadth-first rather than greedy. The first version of this walked toward
    the target one step at a time and wedged in the first corridor that turned
    the wrong way — which failed nine checks that were really about stairs,
    items and monsters, and said nothing about the engine at all.
    """
    for _ in range(limit):
        state = game.state()
        if state.get('game_over'):
            return False
        if (state['player']['x'], state['player']['y']) == (x, y):
            return True
        path = _route(state, (x, y))
        if not path:
            return False
        step_x, step_y = path[0]
        dx = step_x - state['player']['x']
        dy = step_y - state['player']['y']
        direction = ('n' if dy < 0 else 's' if dy > 0 else '') + (
            'w' if dx < 0 else 'e' if dx > 0 else ''
        )
        before = (state['player']['x'], state['player']['y'])
        game.move(direction)
        after = game.state()['player']
        if (after['x'], after['y']) == before:
            # Something is in the way that the plan did not know about. One
            # wait lets it move; a second failure means give up rather than
            # spin.
            game.act('wait')
            state = game.state()
            path = _route(state, (x, y))
            if not path:
                return False
    return False


def bump_target(game):
    """Walk beside a living monster and return the direction to hit it.

    The combat checks used to wait for one to come to them. Monsters chase
    what they can see, so on a quiet level nothing ever arrived and the check
    timed out — an engine with working combat scored zero on four features for
    want of an introduction.
    """
    for monster in [m for m in game.state().get('monsters', []) if m.get('alive', True)]:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            beside = (monster['x'] + dx, monster['y'] + dy)
            tiles = game.state()['map']['tiles']
            if not (0 <= beside[1] < len(tiles) and 0 <= beside[0] < len(tiles[0])):
                continue
            if tiles[beside[1]][beside[0]] not in '.<>':
                continue
            if not walk_to(game, *beside):
                continue
            here = game.state()['player']
            sx = (monster['x'] > here['x']) - (monster['x'] < here['x'])
            sy = (monster['y'] > here['y']) - (monster['y'] < here['y'])
            direction = ('n' if sy < 0 else 's' if sy > 0 else '') + (
                'w' if sx < 0 else 'e' if sx > 0 else ''
            )
            if direction:
                return monster, direction
    return None, None


def deep_game(engine, depth, seed=42):
    """A game already at a depth, so a level can be inspected without playing
    down to it. See `start_depth` in the spec."""
    try:
        return engine.Game(seed, start_depth=depth)
    except TypeError:
        return None


# --- the features -----------------------------------------------------------

def f01_map(engine):
    state = new_game(engine).state()
    world = state['map']
    tiles = world['tiles']
    if world['width'] < 40 or world['height'] < 20:
        return False
    if len(tiles) != world['height'] or any(len(row) != world['width'] for row in tiles):
        return False
    flat = [char for row in tiles for char in row]
    if '#' not in flat or '.' not in flat:
        return False
    # Same seed, same world. Everything downstream depends on this.
    return new_game(engine).state()['map']['tiles'] == tiles


def f02_player(engine):
    state = new_game(engine).state()
    player = state['player']
    for key in ('x', 'y', 'hp', 'max_hp'):
        if key not in player:
            return False
    return state['map']['tiles'][player['y']][player['x']] in '.<>'


def f03_movement(engine):
    moved = 0
    for direction, dx, dy in (('e', 1, 0), ('w', -1, 0), ('n', 0, -1), ('s', 0, 1),
                              ('ne', 1, -1), ('nw', -1, -1), ('se', 1, 1), ('sw', -1, 1)):
        game = new_game(engine)
        before = game.state()['player']
        target_x, target_y = before['x'] + dx, before['y'] + dy
        tiles = game.state()['map']['tiles']
        if not (0 <= target_y < len(tiles) and 0 <= target_x < len(tiles[0])):
            continue
        if tiles[target_y][target_x] not in '.<>':
            continue
        game.move(direction)
        after = game.state()['player']
        if (after['x'], after['y']) == (target_x, target_y):
            moved += 1
    # Not all eight are always open from the start square; four proves the
    # mapping rather than a lucky coincidence.
    return moved >= 4


def f04_walls(engine):
    game = new_game(engine)
    tiles = game.state()['map']['tiles']
    for _ in range(200):
        player = game.state()['player']
        for direction, dx, dy in (('e', 1, 0), ('w', -1, 0), ('n', 0, -1), ('s', 0, 1)):
            tx, ty = player['x'] + dx, player['y'] + dy
            if 0 <= ty < len(tiles) and 0 <= tx < len(tiles[0]) and tiles[ty][tx] == '#':
                game.move(direction)
                after = game.state()['player']
                return (after['x'], after['y']) == (player['x'], player['y'])
        game.move('e')
    return False


def f05_rooms(engine):
    state = new_game(engine).state()
    tiles = state['map']['tiles']
    floors = set(floor_tiles(state))
    if len(floors) < 60:
        return False
    # Every floor tile reachable from the player: a map with an island is a
    # map with content nobody can ever see.
    player = state['player']
    start = (player['x'], player['y'])
    if start not in floors:
        return False
    seen = {start}
    stack = [start]
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nxt = (x + dx, y + dy)
            if nxt in floors and nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    if seen != floors:
        return False
    # At least three rooms: count 3x3 blocks of open floor, which corridors
    # cannot produce.
    wide = 0
    for y in range(1, len(tiles) - 1):
        for x in range(1, len(tiles[0]) - 1):
            if all(tiles[y + j][x + i] in '.<>' for j in (-1, 0, 1) for i in (-1, 0, 1)):
                wide += 1
    return wide >= 3


def f06_fov(engine):
    game = new_game(engine)
    state = game.state()
    visible = state.get('visible')
    if not visible:
        return False
    player = state['player']
    if not visible[player['y']][player['x']]:
        return False
    # Something, somewhere, must be hidden — a grid of all True is not a field
    # of view, it is a formality.
    return any(not cell for row in visible for cell in row)


def f07_memory(engine):
    game = new_game(engine)
    start = game.state()['player']
    origin = (start['x'], start['y'])
    for _ in range(12):
        game.move('e')
        game.move('s')
    state = game.state()
    explored = state.get('explored')
    if not explored:
        return False
    if not explored[origin[1]][origin[0]]:
        return False
    # And it is memory, not just the live view.
    visible = state.get('visible') or []
    remembered = sum(
        1
        for y, row in enumerate(explored)
        for x, cell in enumerate(row)
        if cell and visible and not visible[y][x]
    )
    return remembered > 0


def f08_stairs(engine):
    game = new_game(engine)
    state = game.state()
    tiles = state['map']['tiles']
    stairs = [(x, y) for y, row in enumerate(tiles) for x, c in enumerate(row) if c == '>']
    if len(stairs) != 1:
        return False
    before_depth = state.get('depth', 1)
    # Off the stairs it must refuse rather than teleport.
    game.act('descend')
    if game.state().get('depth', 1) != before_depth:
        return False
    if not walk_to(game, *stairs[0]):
        return False
    before_tiles = game.state()['map']['tiles']
    game.act('descend')
    after = game.state()
    return after.get('depth') == before_depth + 1 and after['map']['tiles'] != before_tiles


def f09_monsters(engine):
    state = new_game(engine).state()
    monsters = state.get('monsters') or []
    if not monsters:
        return False
    tiles = state['map']['tiles']
    player = (state['player']['x'], state['player']['y'])
    for monster in monsters:
        for key in ('x', 'y', 'hp', 'max_hp', 'name', 'alive'):
            if key not in monster:
                return False
        if tiles[monster['y']][monster['x']] not in '.<>':
            return False
        if (monster['x'], monster['y']) == player:
            return False
    return True


def f10_chase(engine):
    game = new_game(engine)

    def living():
        return [m for m in game.state().get('monsters', []) if m.get('alive', True)]

    def gap():
        here = game.state()['player']
        return min(
            (max(abs(m['x'] - here['x']), abs(m['y'] - here['y'])) for m in living()),
            default=None,
        )

    # Walk within sight first. A monster across the level behind three walls
    # not coming for you is correct behaviour, not a missing feature — the
    # check is about what happens once it can see you.
    target = None
    for monster in living():
        if walk_to(game, monster['x'] + 4, monster['y']) or walk_to(
            game, monster['x'], monster['y'] + 4
        ):
            target = monster
            break
    if target is None:
        return False

    start = gap()
    if start is None:
        return True
    closest = start
    before_hp = game.state()['player']['hp']
    for _ in range(25):
        game.act('wait')
        state = game.state()
        if state.get('game_over') or state['player']['hp'] < before_hp:
            return True
        now = gap()
        if now is None:
            return True
        closest = min(closest, now)
    return closest < start


def f11_bump(engine):
    game = new_game(engine)
    monster, direction = bump_target(game)
    if monster is None:
        return False
    before_hp = next(
        (m['hp'] for m in game.state()['monsters'] if (m['x'], m['y']) == (monster['x'], monster['y'])),
        None,
    )
    before_pos = (game.state()['player']['x'], game.state()['player']['y'])
    game.move(direction)
    after = game.state()
    same = [m for m in after['monsters'] if (m['x'], m['y']) == (monster['x'], monster['y'])]
    hurt = (not same) or any(m['hp'] < before_hp or not m.get('alive', True) for m in same)
    moved = (after['player']['x'], after['player']['y']) != before_pos
    return hurt and not moved


def f12_death(engine):
    game = new_game(engine)
    monster, direction = bump_target(game)
    if monster is None:
        return False
    for _ in range(40):
        game.move(direction)
        state = game.state()
        if state.get('game_over'):
            # The other half of the rule: a dead player stays put.
            before = (state['player']['x'], state['player']['y'])
            game.move('e')
            now = game.state()['player']
            return (now['x'], now['y']) == before
        dead = [m for m in state['monsters'] if not m.get('alive', True)]
        if dead:
            # And a corpse stops blocking the square it fell on.
            return walk_to(game, dead[0]['x'], dead[0]['y'])
    return False


def f13_messages(engine):
    game = new_game(engine)
    before = len(game.state().get('messages', []))
    monster, direction = bump_target(game)
    if monster is None:
        return False
    game.move(direction)
    return len(game.state().get('messages', [])) > before


def f14_items(engine):
    state = new_game(engine).state()
    items = state.get('items') or []
    if not items:
        return False
    tiles = state['map']['tiles']
    return all(
        'name' in item and 'kind' in item and tiles[item['y']][item['x']] in '.<>'
        for item in items
    )


def f15_pickup(engine):
    game = new_game(engine)
    items = game.state().get('items') or []
    if not items:
        return False
    before_inventory = len(game.state().get('inventory', []))
    # Off an item it must do nothing.
    game.act('pickup')
    if len(game.state().get('inventory', [])) != before_inventory:
        return False
    for item in items:
        if walk_to(game, item['x'], item['y']):
            count = len(game.state().get('items', []))
            game.act('pickup')
            after = game.state()
            return (
                len(after.get('inventory', [])) == before_inventory + 1
                and len(after.get('items', [])) == count - 1
            )
    return False


def f16_capacity(engine):
    game = new_game(engine)
    for _ in range(30):
        for item in list(game.state().get('items', [])):
            if walk_to(game, item['x'], item['y']):
                game.act('pickup')
        if len(game.state().get('inventory', [])) >= 26:
            break
        if not game.state().get('items'):
            break
    return len(game.state().get('inventory', [])) <= 26


def f17_potions(engine):
    game = new_game(engine)
    for item in list(game.state().get('items', [])):
        if item['kind'] != 'potion':
            continue
        if not walk_to(game, item['x'], item['y']):
            continue
        game.act('pickup')
        inventory = game.state().get('inventory', [])
        index = next(
            (i for i, entry in enumerate(inventory) if entry['kind'] == 'potion'), None
        )
        if index is None:
            continue
        # Take damage first, or a heal has nothing to show.
        for _ in range(200):
            state = game.state()
            if state['player']['hp'] < state['player']['max_hp']:
                break
            game.act('wait')
        before = game.state()['player']['hp']
        game.act('use', index=index)
        after = game.state()
        if after['player']['hp'] <= after['player']['max_hp'] and len(
            after.get('inventory', [])
        ) == len(inventory) - 1:
            return after['player']['hp'] >= before
    return False


def f18_equipment(engine):
    game = new_game(engine)
    for item in list(game.state().get('items', [])):
        if item['kind'] not in ('weapon', 'armour'):
            continue
        if not walk_to(game, item['x'], item['y']):
            continue
        game.act('pickup')
        inventory = game.state().get('inventory', [])
        index = next(
            (i for i, e in enumerate(inventory) if e['kind'] in ('weapon', 'armour')), None
        )
        if index is None:
            continue
        slot = 'weapon' if inventory[index]['kind'] == 'weapon' else 'armour'
        stat = 'attack' if slot == 'weapon' else 'defense'
        before = game.state()['player'].get(stat, 0)
        game.act('equip', index=index)
        mid = game.state()
        if mid.get('equipped', {}).get(slot) is None:
            return False
        if mid['player'].get(stat, 0) <= before:
            return False
        game.act('unequip', slot=slot)
        back = game.state()
        return back['player'].get(stat, 0) == before and back['equipped'][slot] is None
    return False


def f19_bestiary(engine):
    names = {}
    for depth in (1, 3, 5):
        game = deep_game(engine, depth)
        if game is None:
            return False
        for monster in game.state().get('monsters', []):
            names[monster['name']] = monster['max_hp']
    return len(names) >= 3 and len(set(names.values())) >= 2


def _depth_hp(engine, depth):
    game = deep_game(engine, depth)
    if game is None:
        return None
    monsters = game.state().get('monsters', [])
    if not monsters:
        return None
    return sum(m['max_hp'] for m in monsters) / len(monsters)


def f20_scaling(engine):
    shallow = _depth_hp(engine, 1)
    deep = _depth_hp(engine, 5)
    return shallow is not None and deep is not None and deep > shallow


def f21_experience(engine):
    game = new_game(engine)
    before = game.state()['player'].get('xp', 0)
    monster, direction = bump_target(game)
    if monster is None:
        return False
    for _ in range(40):
        game.move(direction)
        state = game.state()
        if state.get('game_over'):
            return False
        if state['player'].get('xp', 0) > before:
            return True
    return False


def f22_save_load(engine):
    game = new_game(engine)
    for _ in range(6):
        game.move('e')
        game.act('wait')
    expected = game.state()
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, 'save.json')
        game.save(path)
        restored = engine.Game.load(path)
        return restored.state() == expected


def f23_scrolls(engine):
    """A scroll exists somewhere reachable, and using it does something.

    Searches several seeds on the shallow floors rather than one seed on one
    floor. Two reasons, both found the hard way: scroll placement is random,
    and the reference put none at all on depth one with the test seed — while
    the depth-three scroll it did place killed the probe on the way, because a
    level-one character crossing depth three is a balance question and not a
    feature.
    """
    for seed in (42, 7, 99, 123, 5, 2024):
        for depth in (1, 2):
            try:
                game = engine.Game(seed, start_depth=depth) if depth > 1 else engine.Game(seed)
            except TypeError:
                game = engine.Game(seed) if depth == 1 else None
            if game is None:
                continue
            scrolls = [i for i in game.state().get('items', []) if i['kind'] == 'scroll']
            if not scrolls:
                continue
            if not walk_to(game, scrolls[0]['x'], scrolls[0]['y']):
                continue
            game.act('pickup')
            if game.state().get('game_over'):
                continue
            monster, _ = bump_target(game)
            if monster is None or game.state().get('game_over'):
                continue
            inventory = game.state().get('inventory', [])
            index = next((i for i, e in enumerate(inventory) if e['kind'] == 'scroll'), None)
            if index is None:
                continue
            before = [(m['name'], m['x'], m['y'], m['hp']) for m in game.state()['monsters']]
            game.act('use', index=index)
            after_state = game.state()
            after = [(m['name'], m['x'], m['y'], m['hp']) for m in after_state['monsters']]
            if len(after_state.get('inventory', [])) < len(inventory) and after != before:
                return True
    return False


def f24_throwing(engine):
    game = new_game(engine)
    for item in list(game.state().get('items', [])):
        if not walk_to(game, item['x'], item['y']):
            continue
        game.act('pickup')
        inventory = game.state().get('inventory', [])
        if not inventory:
            continue
        living = [m for m in game.state().get('monsters', []) if m.get('alive', True)]
        if not living:
            continue
        target = living[0]
        before = target['hp']
        game.act('throw', index=0, x=target['x'], y=target['y'])
        after_state = game.state()
        same = [m for m in after_state.get('monsters', []) if m['name'] == target['name']]
        hurt = any(m['hp'] < before for m in same) or not any(
            m.get('alive', True) for m in same
        )
        return hurt and len(after_state.get('inventory', [])) < len(inventory)
    return False


def f25_amulet(engine):
    """The amulet exists where it should, and the exit is guarded.

    Not a playthrough. Walking a level-one character from depth five back to
    daylight is a question about game balance, and the reference
    implementation dies on depth three every time — a check that required it
    would be measuring whether the game is winnable by a robot rather than
    whether the win condition is built.
    """
    deep = deep_game(engine, 5)
    if deep is None:
        return False
    if not any(i['kind'] == 'amulet' for i in deep.state().get('items', [])):
        return False

    # And leaving empty-handed is not winning.
    game = new_game(engine)
    tiles = game.state()['map']['tiles']
    up = [(x, y) for y, row in enumerate(tiles) for x, c in enumerate(row) if c == '<']
    if not up:
        return False
    if not walk_to(game, *up[0]):
        return False
    before = len(game.state().get('messages', []))
    game.act('ascend')
    after = game.state()
    return (
        after.get('won') is False
        and after.get('depth') == 1
        and len(after.get('messages', [])) > before
    )


FEATURES = [
    (1, 'a map exists', f01_map),
    (2, 'the player exists', f02_player),
    (3, 'movement', f03_movement),
    (4, 'walls stop you', f04_walls),
    (5, 'rooms and corridors, all reachable', f05_rooms),
    (6, 'field of view', f06_fov),
    (7, 'explored memory', f07_memory),
    (8, 'stairs and descent', f08_stairs),
    (9, 'monsters', f09_monsters),
    (10, 'they come for you', f10_chase),
    (11, 'bump to attack', f11_bump),
    (12, 'death', f12_death),
    (13, 'messages', f13_messages),
    (14, 'items on the floor', f14_items),
    (15, 'pick things up', f15_pickup),
    (16, 'carrying capacity', f16_capacity),
    (17, 'potions', f17_potions),
    (18, 'equipment', f18_equipment),
    (19, 'a bestiary', f19_bestiary),
    (20, 'it gets worse down there', f20_scaling),
    (21, 'experience', f21_experience),
    (22, 'save and load', f22_save_load),
    (23, 'scrolls', f23_scrolls),
    (24, 'throwing', f24_throwing),
    (25, 'the amulet, and a guarded exit', f25_amulet),
]


def main():
    if len(sys.argv) < 2:
        print('usage: bench-roguelike-accept.py <workspace> [--json]')
        return 1
    workspace = sys.argv[1]
    as_json = '--json' in sys.argv

    try:
        engine = load_engine(workspace)
    except Exception as error:
        results = [
            {'feature': n, 'name': name, 'passed': False, 'error': f'engine will not import: {error}'}
            for n, name, _ in FEATURES
        ]
        print(json.dumps({'passed': 0, 'total': len(FEATURES), 'results': results}, indent=2)
              if as_json else f'engine will not import: {error}')
        return 0

    results = []
    for number, name, check in FEATURES:
        entry = {'feature': number, 'name': name, 'passed': False, 'error': None}
        try:
            entry['passed'] = check(engine) is True
        except Exception as error:
            entry['error'] = f'{type(error).__name__}: {error}'
        results.append(entry)

    passed = sum(1 for r in results if r['passed'])
    if as_json:
        print(json.dumps({'passed': passed, 'total': len(results), 'results': results}, indent=2))
    else:
        for r in results:
            mark = 'PASS' if r['passed'] else 'FAIL'
            print(f"{mark}  {r['feature']:2}. {r['name']}")
            if r['error']:
                print(f"        {r['error']}")
        print(f"\n{passed} of {len(results)} features working")
    return 0


if __name__ == '__main__':
    sys.exit(main())
