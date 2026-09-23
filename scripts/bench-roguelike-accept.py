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


# Squares a player can stand on. Doors count: a shut one is an obstacle you
# open, not a wall — and treating it as a wall cut levels in half.
WALKABLE = '.<>/+'
OPEN_DOOR = '/'
SHUT_DOOR = '+'


def floor_tiles(state):
    tiles = state['map']['tiles']
    return [
        (x, y)
        for y, row in enumerate(tiles)
        for x, char in enumerate(row)
        if char in WALKABLE
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
        if char in WALKABLE and (x, y) not in blocked
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
        # A shut door on the path is opened rather than walked into, which
        # is what a player does and what the level's connectivity assumes.
        if state['map']['tiles'][step_y][step_x] == SHUT_DOOR:
            game.act('open', x=step_x, y=step_y)
            if game.state()['map']['tiles'][step_y][step_x] == SHUT_DOOR:
                return False
            continue
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
    """Walk beside a living monster and return it with the direction to hit it.

    Looks again on arrival. The first version walked to a square beside where
    a monster had been and then swung at empty floor, because monsters move
    while you cross the room — so a working engine failed four combat checks
    for being lively.
    """
    def adjacent_now():
        here = game.state()['player']
        for monster in game.state().get('monsters', []):
            if not monster.get('alive', True):
                continue
            dx = monster['x'] - here['x']
            dy = monster['y'] - here['y']
            if max(abs(dx), abs(dy)) == 1:
                direction = ('n' if dy < 0 else 's' if dy > 0 else '') + (
                    'w' if dx < 0 else 'e' if dx > 0 else ''
                )
                return monster, direction
        return None, None

    found, direction = adjacent_now()
    if found is not None:
        return found, direction

    for monster in [m for m in game.state().get('monsters', []) if m.get('alive', True)]:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            beside = (monster['x'] + dx, monster['y'] + dy)
            tiles = game.state()['map']['tiles']
            if not (0 <= beside[1] < len(tiles) and 0 <= beside[0] < len(tiles[0])):
                continue
            if tiles[beside[1]][beside[0]] not in WALKABLE:
                continue
            if not walk_to(game, *beside):
                continue
            found, direction = adjacent_now()
            if found is not None:
                return found, direction
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
    return state['map']['tiles'][player['y']][player['x']] in WALKABLE


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
        if tiles[target_y][target_x] not in WALKABLE:
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
    # Pick a wall off the map and go and stand next to it. Walking in a
    # straight line until something blocks you finds a door as readily as a
    # wall, and a door is meant to stop you.
    for y, row in enumerate(tiles):
        for x, char in enumerate(row):
            if char != '#':
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                spot = (x + dx, y + dy)
                if not (0 <= spot[1] < len(tiles) and 0 <= spot[0] < len(tiles[0])):
                    continue
                if tiles[spot[1]][spot[0]] not in '.<>':
                    continue
                if not walk_to(game, *spot):
                    continue
                here = game.state()['player']
                direction = ('n' if y < here['y'] else 's' if y > here['y'] else '') + (
                    'w' if x < here['x'] else 'e' if x > here['x'] else ''
                )
                if not direction:
                    continue
                before = (here['x'], here['y'])
                game.move(direction)
                after = game.state()['player']
                return (after['x'], after['y']) == before
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
            if all(tiles[y + j][x + i] in WALKABLE for j in (-1, 0, 1) for i in (-1, 0, 1)):
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
        if tiles[monster['y']][monster['x']] not in WALKABLE:
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
    before_hp = monster['hp']
    square = (monster['x'], monster['y'])
    before_pos = (game.state()['player']['x'], game.state()['player']['y'])
    game.move(direction)
    after = game.state()
    # Either something on that square is worse off, or it is no longer there
    # because it died. Both are the feature working.
    same = [m for m in after['monsters'] if (m['x'], m['y']) == square]
    hurt = (not same) or any(
        m['hp'] < before_hp or not m.get('alive', True) for m in same
    )
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
        'name' in item and 'kind' in item and tiles[item['y']][item['x']] in WALKABLE
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
    """The inventory is capped — and there is an inventory to cap.

    The first version asked only whether the carried count stayed at or below
    twenty-six, which an engine with no inventory system at all satisfies
    perfectly. It passed on run one, against ninety-seven lines that had never
    heard of items. A check that a missing feature passes is not a check.
    """
    game = new_game(engine)
    picked = 0
    for _ in range(30):
        items = game.state().get('items', [])
        if not items:
            break
        moved = False
        for item in list(items):
            if walk_to(game, item['x'], item['y']):
                before = len(game.state().get('inventory', []))
                game.act('pickup')
                if len(game.state().get('inventory', [])) > before:
                    picked += 1
                moved = True
                break
        if not moved or game.state().get('game_over'):
            break
        if len(game.state().get('inventory', [])) >= 26:
            break
    if picked == 0:
        return False
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


def _tiles_of(state, char):
    return [
        (x, y)
        for y, row in enumerate(state['map']['tiles'])
        for x, c in enumerate(row)
        if c == char
    ]


def _seeds(engine, depths=(1,), seeds=(42, 7, 99, 123, 5, 2024)):
    """Games to look in. Several, because most of what follows is placed by
    chance and one floor of one game is a dice roll, not a test."""
    for seed in seeds:
        for depth in depths:
            try:
                yield engine.Game(seed, start_depth=depth) if depth > 1 else engine.Game(seed)
            except TypeError:
                if depth == 1:
                    yield engine.Game(seed)


def f26_doors(engine):
    for game in _seeds(engine, depths=(1, 2)):
        shut = _tiles_of(game.state(), '+')
        if not shut:
            continue
        door = shut[0]
        # Stand beside it. A door you cannot reach proves nothing either way.
        beside = None
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            spot = (door[0] + dx, door[1] + dy)
            tiles = game.state()['map']['tiles']
            if not (0 <= spot[1] < len(tiles) and 0 <= spot[0] < len(tiles[0])):
                continue
            if tiles[spot[1]][spot[0]] in '.<>/' and walk_to(game, *spot):
                beside = spot
                break
        if beside is None:
            continue
        here = game.state()['player']
        direction = ('n' if door[1] < here['y'] else 's' if door[1] > here['y'] else '') + (
            'w' if door[0] < here['x'] else 'e' if door[0] > here['x'] else ''
        )
        # Shut: it stops you.
        game.move(direction)
        if (game.state()['player']['x'], game.state()['player']['y']) != tuple(beside):
            return False
        game.act('open', x=door[0], y=door[1])
        if game.state()['map']['tiles'][door[1]][door[0]] != '/':
            return False
        # Open: it does not.
        game.move(direction)
        return (game.state()['player']['x'], game.state()['player']['y']) == door
    return False


def f27_traps(engine):
    for game in _seeds(engine, depths=(1, 2, 3)):
        if not isinstance(game.state().get('traps'), list):
            return False
        if game.state()['traps']:
            return False  # nothing discovered yet, so nothing should be listed
        floors = floor_tiles(game.state())
        for square in floors[:: max(1, len(floors) // 40)]:
            if game.state().get('game_over'):
                break
            walk_to(game, *square)
            found = game.state().get('traps') or []
            if found:
                trap = found[0]
                return all(key in trap for key in ('x', 'y', 'kind'))
    return False


def f28_unidentified(engine):
    for game in _seeds(engine, depths=(1, 2)):
        unknown = [
            i
            for i in game.state().get('items', [])
            if i['kind'] in ('potion', 'scroll') and i.get('identified') is False
        ]
        if not unknown:
            continue
        appearance = unknown[0]['name']
        # Stable within a seed, or the name is noise rather than a disguise.
        twin = engine.Game(42) if game.state()['depth'] == 1 else None
        if not walk_to(game, unknown[0]['x'], unknown[0]['y']):
            continue
        game.act('pickup')
        held = game.state().get('inventory', [])
        index = next((i for i, e in enumerate(held) if e.get('identified') is False), None)
        if index is None:
            continue
        game.act('use', index=index)
        after = game.state()
        # Everything of that type is known now, wherever it is.
        same = [
            i
            for i in after.get('items', []) + after.get('inventory', [])
            if i.get('name') == appearance
        ]
        del twin
        return not same or all(i.get('identified') is True for i in same)
    return False


def f29_effects(engine):
    """An effect can land, tick down, and wear off.

    A fresh game per square, rather than one long tour. Touring a level that
    now has archers and hunger kills the probe before it reaches the third
    room — the level is deterministic for a seed, so walking to one square in
    a new game visits exactly the same place with full health.
    """
    for seed in (42, 7, 99):
        try:
            sample = engine.Game(seed)
        except Exception:
            continue
        if not isinstance(sample.state()['player'].get('effects'), list):
            continue
        squares = floor_tiles(sample.state())
        for square in squares[:: max(1, len(squares) // 25)]:
            game = engine.Game(seed)
            walk_to(game, *square)
            active = game.state()['player'].get('effects') or []
            if not active:
                continue
            if not all('name' in e and 'turns' in e for e in active):
                return False
            # It has to end, or it is a permanent change wearing a timer.
            for _ in range(120):
                game.act('wait')
                if game.state().get('game_over'):
                    return True
                if not (game.state()['player'].get('effects') or []):
                    return True
            return False
    return False


def f30_traits(engine):
    traits = set()
    for game in _seeds(engine, depths=(1, 3, 5), seeds=(42,)):
        for monster in game.state().get('monsters', []):
            trait = monster.get('trait')
            if isinstance(trait, str) and trait.strip():
                traits.add(trait)
    return len(traits) >= 3


def f31_ranged(engine):
    """Something hurts the player from a distance.

    Asked behaviourally — hp lost with nothing adjacent — rather than by
    looking for a trait called "archer". Another engine may reasonably name it
    something else, and a check that reads one implementation's vocabulary is
    testing the vocabulary.
    """
    def nothing_adjacent(state):
        here = state['player']
        return not any(
            m.get('alive', True)
            and max(abs(m['x'] - here['x']), abs(m['y'] - here['y'])) <= 1
            for m in state.get('monsters', [])
        )

    for game in _seeds(engine, depths=(1, 2, 3)):
        for monster in [m for m in game.state().get('monsters', []) if m.get('alive', True)]:
            # Stand a few squares off, in the open, and see what happens.
            tiles = game.state()['map']['tiles']
            perches = [
                (monster['x'] + dx, monster['y'] + dy)
                for dx in range(-5, 6)
                for dy in range(-5, 6)
                if 2 <= max(abs(dx), abs(dy)) <= 5
            ]
            for spot in perches:
                if not (0 <= spot[1] < len(tiles) and 0 <= spot[0] < len(tiles[0])):
                    continue
                if tiles[spot[1]][spot[0]] not in '.<>':
                    continue
                if not walk_to(game, *spot):
                    continue
                for _ in range(12):
                    state = game.state()
                    if state.get('game_over'):
                        break
                    clear = nothing_adjacent(state)
                    before = state['player']['hp']
                    game.act('wait')
                    after = game.state()
                    if after['player']['hp'] < before and clear and nothing_adjacent(after):
                        return True
                break
            if game.state().get('game_over'):
                break
    return False


def f32_hunger(engine):
    game = new_game(engine)
    start = game.state()['player'].get('nutrition')
    if not isinstance(start, (int, float)) or start <= 0:
        return False
    for _ in range(60):
        game.act('wait')
        if game.state().get('game_over'):
            break
    dropped = game.state()['player'].get('nutrition', start) < start
    if not dropped:
        return False
    # And something puts it back.
    for search in _seeds(engine, depths=(1, 2)):
        food = [i for i in search.state().get('items', []) if i['kind'] == 'food']
        if not food or not walk_to(search, food[0]['x'], food[0]['y']):
            continue
        search.act('pickup')
        held = search.state().get('inventory', [])
        index = next((i for i, e in enumerate(held) if e['kind'] == 'food'), None)
        if index is None:
            continue
        for _ in range(40):
            search.act('wait')
        before = search.state()['player']['nutrition']
        search.act('eat', index=index)
        return search.state()['player']['nutrition'] > before
    return False


def f33_boss(engine):
    deep = deep_game(engine, 5)
    if deep is None:
        return False
    monsters = deep.state().get('monsters', [])
    bosses = [m for m in monsters if m.get('boss') is True]
    if len(bosses) != 1:
        return False
    boss = bosses[0]
    others = [m['max_hp'] for m in monsters if not m.get('boss')]
    if others and boss['max_hp'] <= max(others):
        return False
    # Shallower floors have no boss, or it is not a boss.
    shallow = deep_game(engine, 1)
    if shallow and any(m.get('boss') for m in shallow.state().get('monsters', [])):
        return False
    return bool(str(boss.get('name', '')).strip())


def f34_ending(engine):
    game = new_game(engine)
    if 'score' not in game.state() or 'epitaph' not in game.state():
        return False
    # Play until it ends one way or another.
    for _ in range(600):
        if game.state().get('game_over') or game.state().get('won'):
            break
        monster, direction = bump_target(game)
        if monster is None:
            break
        for _ in range(40):
            game.move(direction)
            if game.state().get('game_over'):
                break
    end = game.state()
    if not end.get('game_over'):
        return False
    return isinstance(end.get('score'), (int, float)) and bool(
        str(end.get('epitaph') or '').strip()
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
    (26, 'doors', f26_doors),
    (27, 'traps', f27_traps),
    (28, 'unidentified things', f28_unidentified),
    (29, 'status effects', f29_effects),
    (30, 'monsters worth remembering', f30_traits),
    (31, 'things that shoot back', f31_ranged),
    (32, 'hunger', f32_hunger),
    (33, 'something guarding the way out', f33_boss),
    (34, 'an ending worth reading', f34_ending),
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
