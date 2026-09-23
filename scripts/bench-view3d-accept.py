#!/usr/bin/env python3
"""The hidden rubric for Deepdown's first-person view.

Eighteen checks. The agent never sees this file; it sees FEATURES-3D.md, which
says in prose what each check measures.

Two things learned the hard way from grading the engine are built in here:

  * **Probe faults look like regressions.** Four times the engine was scored as
    broken when the fault was in the probe's idea of the world — a greedy
    walker, doors read as walls, monsters treated as terrain, a perch that was
    usually a wall. So the grids here are built by this file, not drawn from a
    live dungeon, wherever a check can be written that way. The two checks that
    must use a real dungeon (11, 14) look at what is actually there rather than
    assuming, and try several seeds before concluding anything.
  * **A window with no seam cannot be graded.** Eleven of these features live
    in pygame, so FEATURES-3D.md requires `View` to expose what it drew —
    `depth`, `sprites()`, `hud_lines()`, `minimap_rect()`, `ending_lines()`.
    That is not test-fitting; it is the same reason the engine has `state()`.

Usage: python bench-view3d-accept.py [workspace]
Prints one line per feature and a JSON summary on the final line.
"""
import json
import math
import os
import sys
import traceback

os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')
os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')

WORKSPACE = sys.argv[1] if len(sys.argv) > 1 else 'C:/Users/Owner/Desktop/Sandbox/Roguelike'
sys.path.insert(0, WORKSPACE)

# --- grids this file owns, so no check depends on a dungeon that moved -------

CORRIDOR = [list('#########'), list('#.......#'), list('#########')]
#            x: 0123456789          player at 1.5 -> wall face at 8.0

LONG = [list('#' * 42), list('#' + '.' * 40 + '#'), list('#' * 42)]

BOX = [
    list('#####'),
    list('#...#'),
    list('#...#'),
    list('#...#'),
    list('#####'),
]

HALL = [list('#' * 22)] + [list('#' + '.' * 20 + '#') for _ in range(20)] + [list('#' * 22)]

SHUT = [list('#####'), list('#.+.#'), list('#####')]
OPEN = [list('#####'), list('#./.#'), list('#####')]


def _import(name):
    import importlib

    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def _frame_bytes(surface):
    import pygame

    return pygame.image.tostring(surface, 'RGB')


def _build_view(seed=42, width=320, height=200):
    engine = _import('engine')
    view3d = _import('view3d')
    return view3d.View(engine.Game(seed), width=width, height=height)


# --- the pure maths ---------------------------------------------------------


def f01_ray_hits_wall():
    """A ray fired down a corridor stops at the wall's near face."""
    r3 = _import('render3d')
    hit = r3.cast_ray(CORRIDOR, 1.5, 1.5, 0.0)
    for key in ('distance', 'side', 'tile', 'cell'):
        if key not in hit:
            return False, f"cast_ray left out {key!r}"
    # The wall occupies cell x=8; its near face is at x=8.0, so 6.5 away.
    if abs(hit['distance'] - 6.5) > 0.5:
        return False, f"distance {hit['distance']:.2f}, expected about 6.5"
    if hit['tile'] != '#':
        return False, f"tile {hit['tile']!r}, expected '#'"
    if tuple(hit['cell']) != (8, 1):
        return False, f"cell {tuple(hit['cell'])}, expected (8, 1)"
    return True, f"stops at {hit['distance']:.2f} on cell {tuple(hit['cell'])}"


def f02_ray_finds_nothing():
    """With no wall in range the ray gives up rather than raising or looping."""
    r3 = _import('render3d')
    hit = r3.cast_ray(LONG, 1.5, 1.5, 0.0, max_distance=5.0)
    if abs(hit['distance'] - 5.0) > 0.01:
        return False, f"distance {hit['distance']!r}, expected the 5.0 limit"
    if hit['tile'] != '':
        return False, f"tile {hit['tile']!r}, expected '' for nothing found"
    return True, 'gives up at the limit with an empty tile'


def f03_both_faces():
    """A vertical face reads 'x', a horizontal one 'y'."""
    r3 = _import('render3d')
    east = r3.cast_ray(BOX, 1.5, 1.5, 0.0)
    south = r3.cast_ray(BOX, 1.5, 1.5, math.pi / 2)
    if east['side'] != 'x':
        return False, f"east ray reported side {east['side']!r}, expected 'x'"
    if south['side'] != 'y':
        return False, f"south ray reported side {south['side']!r}, expected 'y'"
    return True, "east reads 'x', south reads 'y'"


def f04_sweep():
    """One entry per column, column 0 at facing - fov/2."""
    r3 = _import('render3d')
    columns = 120
    fov = math.pi / 2
    view = r3.cast_view(HALL, 3.5, 10.5, 0.0, fov, columns)
    if not isinstance(view, list) or len(view) != columns:
        got = len(view) if isinstance(view, list) else type(view).__name__
        return False, f"cast_view gave {got}, expected a list of {columns}"
    if not all(isinstance(entry, dict) and 'distance' in entry for entry in view):
        return False, 'entries are not cast_ray results'
    if tuple(view[0]['cell']) == tuple(view[-1]['cell']):
        return False, 'the first and last columns hit the same cell'
    # Column 0 should sit beside the ray at facing - fov/2 (half a step off).
    edge = r3.cast_ray(HALL, 3.5, 10.5, -fov / 2)
    near = abs(view[0]['cell'][0] - edge['cell'][0]) + abs(view[0]['cell'][1] - edge['cell'][1])
    far = abs(view[-1]['cell'][0] - edge['cell'][0]) + abs(view[-1]['cell'][1] - edge['cell'][1])
    if near > far:
        return False, 'column 0 is at facing + fov/2; the sweep runs backwards'
    return True, f"{columns} columns, left edge at facing - fov/2"


def f05_no_fisheye():
    """Square-on to a flat wall, the corrected distances stay flat."""
    r3 = _import('render3d')
    columns = 160
    fov = math.pi / 3
    view = r3.cast_view(HALL, 1.5, 10.5, 0.0, fov, columns)
    middle = [entry['distance'] for entry in view[columns // 4 : 3 * columns // 4]]
    if not middle:
        return False, 'no columns to measure'
    spread = (max(middle) - min(middle)) / min(middle)
    if spread > 0.05:
        return False, f"the wall bows by {spread:.1%} across the middle — not corrected"
    return True, f"flat to within {spread:.2%} across the middle half"


def f06_perspective():
    """Twice as far is half as tall, and it stays on the screen."""
    r3 = _import('render3d')
    near = r3.column_height(2.0, 400)
    far = r3.column_height(4.0, 400)
    if far <= 0:
        return False, f"height at distance 4 was {far}"
    ratio = near / far
    if abs(ratio - 2.0) > 0.2:
        return False, f"doubling the distance changed height by {ratio:.2f}x, expected 2"
    if r3.column_height(0.001, 400) > 400:
        return False, 'a very close wall is taller than the screen'
    if r3.column_height(10_000.0, 400) < 1:
        return False, 'a very distant wall shrank below one pixel'
    return True, f"{ratio:.2f}x per halving, clamped at both ends"


def f07_shading():
    """Further is darker, and a horizontal face is darker than a vertical one."""
    r3 = _import('render3d')
    values = [r3.shade(d, 'x') for d in (0.5, 1, 2, 4, 8, 16, 31)]
    if any(v < 0.0 or v > 1.0 for v in values):
        return False, f"shade left the 0..1 range: {values}"
    if not all(a >= b for a, b in zip(values, values[1:])):
        return False, f"shade does not fall with distance: {values}"
    if values[0] <= values[-1]:
        return False, 'near and far shade the same'
    if not r3.shade(5.0, 'y') < r3.shade(5.0, 'x'):
        return False, "a 'y' face is not dimmer than an 'x' face"
    return True, f"{values[0]:.2f} near to {values[-1]:.2f} far, y dimmer than x"


def f12_sprite_projection():
    """Ahead is centre, right is right, left is left, behind is nothing."""
    r3 = _import('render3d')
    columns, height, fov = 320, 200, math.pi / 3
    centre = columns // 2

    ahead = r3.project_sprite(5.5, 5.5, 0.0, fov, 9.5, 5.5, columns, height)
    if ahead is None:
        return False, 'a sprite directly ahead projected to None'
    if abs(ahead['column'] - centre) > columns * 0.03:
        return False, f"directly ahead landed at column {ahead['column']}, not near {centre}"

    # Facing east with y growing south, screen-right is south.
    right = r3.project_sprite(5.5, 5.5, 0.0, fov, 9.5, 7.0, columns, height)
    left = r3.project_sprite(5.5, 5.5, 0.0, fov, 9.5, 4.0, columns, height)
    if right is None or left is None:
        return False, 'a sprite inside the field of view projected to None'
    if not left['column'] < centre < right['column']:
        return False, f"left {left['column']}, right {right['column']} straddle {centre} wrongly"

    behind = r3.project_sprite(5.5, 5.5, 0.0, fov, 1.5, 5.5, columns, height)
    if behind is not None:
        return False, f"a sprite behind the viewer projected to {behind}"

    near = r3.project_sprite(5.5, 5.5, 0.0, fov, 7.5, 5.5, columns, height)
    if near['size'] <= ahead['size']:
        return False, 'a nearer sprite is not drawn larger'
    return True, f"centre {ahead['column']}, near size {near['size']} > far {ahead['size']}"


def f15_doors():
    """A shut door stops a ray; an open one does not."""
    r3 = _import('render3d')
    shut = r3.cast_ray(SHUT, 1.5, 1.5, 0.0)
    if shut['tile'] != '+':
        return False, f"a shut door gave tile {shut['tile']!r}; sight passed through it"
    walked = r3.cast_ray(OPEN, 1.5, 1.5, 0.0)
    if walked['tile'] != '#':
        return False, f"an open door stopped the ray (tile {walked['tile']!r})"

    view3d = _import('view3d')
    colours = getattr(view3d, 'WALL_COLOURS', None)
    if not isinstance(colours, dict):
        return False, 'view3d has no WALL_COLOURS table'
    if '#' not in colours or '+' not in colours:
        return False, f"WALL_COLOURS is missing '#' or '+': {sorted(colours)}"
    if tuple(colours['#'])[:3] == tuple(colours['+'])[:3]:
        return False, 'a door is drawn the same colour as a wall'
    return True, 'shut stops sight, open does not, and they draw differently'


# --- the window -------------------------------------------------------------


def f08_window_seam():
    """A View builds against a live game and draws a frame with no display."""
    view = _build_view(width=320, height=200)
    surface = view.frame()
    if surface is None:
        return False, 'frame() returned None'
    if tuple(surface.get_size()) != (320, 200):
        return False, f"frame() is {surface.get_size()}, not the size asked for"
    view.key('q')  # must not raise or block
    return True, 'builds, draws 320x200, and takes q without complaint'


def f09_walls_drawn():
    """The frame has structure: columns differ, and so does top from middle."""
    view = _build_view()
    surface = view.frame()
    width, height = surface.get_size()
    row = [surface.get_at((x, height // 2))[:3] for x in range(0, width, 4)]
    if len(set(row)) < 3:
        return False, f"the middle row uses only {len(set(row))} colour(s)"
    columns_differ = sum(1 for a, b in zip(row, row[1:]) if a != b)
    if columns_differ < 3:
        return False, 'neighbouring columns are all the same'
    vertical = {surface.get_at((width // 2, y))[:3] for y in (2, height // 2, height - 3)}
    if len(vertical) < 2:
        return False, 'ceiling, wall and floor are all one colour'
    return True, f"{len(set(row))} colours across the row, ceiling/wall/floor distinct"


def f10_turning():
    """Left and right rotate facing opposite ways, and the picture follows."""
    view = _build_view()
    start = view.facing
    view.key('left')
    left_delta = view.facing - start
    view.key('right')
    view.key('right')
    right_delta = view.facing - (start + left_delta)
    if left_delta == 0 or right_delta == 0:
        return False, f"turning did not move facing (left {left_delta}, right {right_delta})"
    if left_delta * right_delta > 0:
        return False, 'left and right turn the same way'
    if abs(left_delta) > math.pi / 2:
        return False, f"one press turns {abs(left_delta):.2f} rad — more than a quarter turn"

    # The picture has to follow the angle. A blank wall can look the same from
    # two nearby angles, so sweep right round rather than comparing one pair.
    before = _frame_bytes(view.frame())
    for _ in range(12):
        view.key('left')
        if _frame_bytes(view.frame()) != before:
            return True, f"{left_delta:+.3f} rad left, {right_delta:+.3f} right, view follows"
    return False, 'facing changes but the frame never does'


def f11_walking():
    """w walks the way you face, through the engine, and a/d strafe across it."""
    engine = _import('engine')
    view3d = _import('view3d')
    compass = {0.0: (1, 0), math.pi / 2: (0, 1), math.pi: (-1, 0), 3 * math.pi / 2: (0, -1)}

    # Every candidate is tried before concluding anything. Giving up on the
    # first one that did not work reported a failure the moment a single square
    # behaved unexpectedly — a trap, an effect, a monster that moved between
    # reading the state and taking the step — which is how this suite has
    # failed working code before. One success anywhere is the feature working.
    walked = None
    attempts = []
    for seed in (42, 7, 99, 1234):
        for angle, (dx, dy) in compass.items():
            game = engine.Game(seed)
            state = game.state()
            tiles = state['map']['tiles']
            taken = {(m['x'], m['y']) for m in state['monsters'] if m.get('alive')}
            px, py = state['player']['x'], state['player']['y']
            target = (px + dx, py + dy)
            if target in taken:
                continue  # walking into a monster attacks it; that is not this check
            if tiles[target[1]][target[0]] not in '.<>/':
                continue
            view = view3d.View(game, width=160, height=100)
            view.facing = angle
            view.key('w')
            now = game.state()['player']
            if (now['x'], now['y']) == target:
                walked = (seed, angle, target)
                break
            attempts.append(
                f"seed {seed} facing {angle:.2f}: wanted {target}, got ({now['x']}, {now['y']})"
            )
        if walked:
            break
    if not walked:
        if not attempts:
            return False, 'no seed offered a clear square to step onto'
        return False, f"w never moved the player as faced — {'; '.join(attempts[:3])}"

    # Strafing moves across the facing, and a and d disagree about which way.
    for seed in (42, 7, 99, 1234):
        game = engine.Game(seed)
        state = game.state()
        tiles = state['map']['tiles']
        px, py = state['player']['x'], state['player']['y']
        if tiles[py - 1][px] not in '.<>/' or tiles[py + 1][px] not in '.<>/':
            continue
        view = view3d.View(game, width=160, height=100)
        view.facing = 0.0  # east, so a and d must move along y
        view.key('a')
        after_a = game.state()['player']
        moved_a = (after_a['x'] - px, after_a['y'] - py)
        if moved_a == (0, 0):
            continue
        if moved_a[0] != 0:
            return False, f"facing east, a moved {moved_a} — along the facing, not across it"
        view.key('d')
        view.key('d')
        after_d = game.state()['player']
        moved_d = (after_d['x'] - after_a['x'], after_d['y'] - after_a['y'])
        if moved_d == (0, 0) or moved_d[1] * moved_a[1] > 0:
            return False, f"a moved {moved_a} and d moved {moved_d} — not opposites"
        return True, f"w walked to {walked[2]}, a/d strafed {moved_a} and {moved_d}"
    return True, f"w walked to {walked[2]} on seed {walked[0]} (no room to test strafing)"


class StagedGame:
    """A level built here, so occlusion can be tested rather than inferred.

    One monster stands in the open at (3, 1); another at (8, 1) is behind the
    wall at x=6. Both are marked visible, so nothing but a depth test can tell
    them apart — which is exactly the feature.
    """

    TILES = [
        list('##########'),
        list('#.....#..#'),
        list('##########'),
    ]

    def __init__(self):
        self.moves = []

    def state(self):
        width = len(self.TILES[0])
        height = len(self.TILES)
        return {
            'map': {
                'tiles': [list(row) for row in self.TILES],
                'width': width,
                'height': height,
            },
            'player': {
                'x': 1, 'y': 1, 'hp': 10, 'max_hp': 10, 'level': 1,
                'xp': 0, 'attack': 3, 'defense': 1, 'effects': [],
            },
            'monsters': [
                {'x': 3, 'y': 1, 'hp': 4, 'max_hp': 4, 'name': 'rat',
                 'alive': True, 'attack': 1},
                {'x': 8, 'y': 1, 'hp': 4, 'max_hp': 4, 'name': 'rat',
                 'alive': True, 'attack': 1},
            ],
            'items': [],
            'traps': [],
            'inventory': [],
            'equipped': {},
            'messages': ['You stand in a hallway.'],
            'depth': 1,
            'game_over': False,
            'won': False,
            'visible': [[True] * width for _ in range(height)],
            'explored': [[True] * width for _ in range(height)],
        }

    def move(self, direction):
        self.moves.append(direction)

    def act(self, action, **kwargs):
        return None


def f13_occlusion():
    """A depth buffer per column, and sprites tested against it."""
    view = _build_view(width=320, height=200)
    view.frame()
    depth = getattr(view, 'depth', None)
    if depth is None:
        return False, 'View has no depth buffer after a frame'
    # However many columns it casts, not one per pixel. Half-resolution
    # raycasting — 160 rays stretched across 320 pixels — is a standard and
    # entirely correct choice, and demanding one ray per pixel failed an
    # implementation that had done nothing wrong. The real invariant is that
    # the buffer agrees with the geometry, whatever its resolution.
    columns = len(depth)
    if columns < 2:
        return False, f"depth has {columns} entr(y/ies) — that is not a buffer"
    if columns > 320:
        return False, f"depth has {columns} entries for a 320-wide frame — more than there are pixels"
    if not all(isinstance(d, (int, float)) and d > 0 for d in depth):
        return False, 'depth holds something other than positive distances'

    r3 = _import('render3d')
    state = view.game.state()
    fresh = r3.cast_view(
        state['map']['tiles'],
        state['player']['x'] + 0.5,
        state['player']['y'] + 0.5,
        view.facing,
        getattr(view, 'fov', math.pi / 3),
        columns,
    )
    off = max(abs(a - b['distance']) for a, b in zip(depth, fresh))
    if off > 0.5:
        return False, f"depth disagrees with a fresh cast by up to {off:.2f}"

    # Now the feature itself, on a level with a known answer.
    view3d = _import('view3d')
    staged = view3d.View(StagedGame(), width=320, height=200)
    staged.facing = 0.0  # due east, straight down the hallway
    staged.frame()
    drawn = {(s.get('x'), s.get('y')) for s in staged.sprites()}
    if (3, 1) not in drawn:
        return False, 'the monster standing in the open was not drawn at all'
    if (8, 1) in drawn:
        return False, 'the monster behind the wall was drawn through it'
    scale = '' if columns == 320 else f" (half-res: {columns} rays across 320 pixels)"
    return True, f"{columns} columns of depth{scale}; the one behind the wall stayed hidden"


def f14_sprites_on_screen():
    """Sprites are drawn for what the player can see, and only that."""
    engine = _import('engine')
    view3d = _import('view3d')
    for seed in (42, 7, 99, 1234, 2, 5):
        game = engine.Game(seed)
        state = game.state()
        visible = state['visible']
        things = [
            (t['x'], t['y'])
            for t in list(state['monsters']) + list(state['items'])
            if t.get('alive', True) and visible[t['y']][t['x']]
        ]
        if not things:
            continue
        px, py = state['player']['x'], state['player']['y']
        tx, ty = things[0]
        view = view3d.View(game, width=320, height=200)
        view.facing = math.atan2(ty - py, tx - px)
        view.frame()
        sprites = view.sprites()
        if not sprites:
            return False, f"a visible thing at ({tx}, {ty}) is straight ahead but nothing is drawn"
        if not all('column' in s and 'size' in s and 'distance' in s for s in sprites):
            return False, f"sprites() entries are missing fields: {sprites[0]}"

        # Nothing invisible should be in the list.
        drawn = {(s.get('x'), s.get('y')) for s in sprites if 'x' in s and 'y' in s}
        unseen = [p for p in drawn if p[0] is not None and not visible[p[1]][p[0]]]
        if unseen:
            return False, f"drew {len(unseen)} thing(s) the player cannot see, e.g. {unseen[0]}"

        view.facing += math.pi  # turn your back on it
        view.frame()
        if len(view.sprites()) >= len(sprites):
            return False, 'turning away did not remove anything from the frame'
        return True, f"{len(sprites)} sprite(s) facing it, fewer with your back turned"
    return False, 'no seed started with anything visible to draw'


def f16_hud():
    """Depth, hp, level and a recent message, drawn over the view."""
    view = _build_view()
    view.frame()
    lines = view.hud_lines()
    if not lines:
        return False, 'hud_lines() is empty'
    text = ' '.join(str(line) for line in lines).lower()
    state = view.game.state()
    wanted = {
        'depth': 'depth',
        'hp': 'hp',
        'level': 'level',
    }
    missing = [label for label, needle in wanted.items() if needle not in text]
    if missing:
        return False, f"the hud never mentions {', '.join(missing)}: {lines}"
    if str(state['player']['hp']) not in text:
        return False, f"the hud shows no hp number (hp is {state['player']['hp']}): {lines}"
    last = str(state['messages'][-1]).lower()[:20]
    if last and last not in text:
        return False, f"the hud shows no recent message; expected something like {last!r}"
    return True, f"{len(lines)} line(s) carrying depth, hp, level and the log"


def f17_minimap():
    """A corner map of what has been explored, with the facing on it."""
    view = _build_view(width=320, height=200)
    surface = view.frame()
    rect = view.minimap_rect()
    if rect is None:
        return False, 'minimap_rect() gave nothing back — there is no minimap yet'
    try:
        x, y, w, h = tuple(rect)[:4]
    except (TypeError, ValueError):
        return False, f"minimap_rect() is not an (x, y, width, height): {rect!r}"
    if w <= 0 or h <= 0:
        return False, f"the minimap has no area: {rect}"
    if x < 0 or y < 0 or x + w > 320 or y + h > 200:
        return False, f"the minimap {rect} falls outside the 320x200 frame"
    if w > 320 * 0.6 or h > 200 * 0.6:
        return False, f"the minimap {rect} is more than a corner of the screen"
    pixels = {
        surface.get_at((px, py))[:3]
        for px in range(x, x + w, max(1, w // 16))
        for py in range(y, y + h, max(1, h // 16))
    }
    if len(pixels) < 2:
        return False, 'the minimap is one flat colour'
    before = _frame_bytes(surface)
    for _ in range(12):
        view.key('left')
        if _frame_bytes(view.frame()) != before:
            return True, f"{w}x{h} at ({x}, {y}), {len(pixels)} colours, follows the facing"
    return False, 'the minimap never changes as you turn — no facing shown'


def f18_ending():
    """Death and victory each draw a screen worth reading."""
    view = _build_view()
    view.frame()
    if view.ending_lines():
        return False, 'an ending is drawn while the player is still alive'

    class Ended:
        """A game that has finished, so the ending can be drawn without dying."""

        def __init__(self, real, won):
            self._state = json.loads(json.dumps(real.state()))
            self._state['game_over'] = True
            self._state['won'] = won
            self._state['messages'].append('You die.' if not won else 'You escape.')

        def state(self):
            return self._state

        def move(self, direction):
            return None

        def act(self, action, **kwargs):
            return None

    view3d = _import('view3d')
    engine = _import('engine')
    for won in (False, True):
        ended = view3d.View(Ended(engine.Game(42), won), width=320, height=200)
        ended.frame()
        lines = ended.ending_lines()
        if not lines:
            return False, f"nothing drawn for {'victory' if won else 'death'}"
        text = ' '.join(str(line) for line in lines).lower()
        state = ended.game.state()
        if str(state['depth']) not in text:
            return False, f"the ending never says how deep you got: {lines}"
        if str(state['player']['level']) not in text:
            return False, f"the ending never says what level you reached: {lines}"
        verdict = 'escape' in text or 'win' in text or 'victor' in text
        if won and not verdict:
            return False, f"victory reads the same as death: {lines}"
        if not won and verdict:
            return False, f"death reads like a victory: {lines}"
    return True, 'death and victory each read differently, with depth and level'


CHECKS = [
    ('1. a ray finds a wall', f01_ray_hits_wall),
    ('2. nothing is not a wall', f02_ray_finds_nothing),
    ('3. both faces', f03_both_faces),
    ('4. a full sweep', f04_sweep),
    ('5. no fisheye', f05_no_fisheye),
    ('6. perspective', f06_perspective),
    ('7. depth shading', f07_shading),
    ('8. a window with a seam', f08_window_seam),
    ('9. walls in perspective', f09_walls_drawn),
    ('10. turning', f10_turning),
    ('11. walking', f11_walking),
    ('12. things you can see', f12_sprite_projection),
    ('13. hidden behind walls', f13_occlusion),
    ('14. monsters and items on screen', f14_sprites_on_screen),
    ('15. doors', f15_doors),
    ('16. a head-up display', f16_hud),
    ('17. a minimap', f17_minimap),
    ('18. an ending on screen', f18_ending),
]


def main():
    results = []
    for label, check in CHECKS:
        try:
            passed, detail = check()
        except Exception as error:
            passed = False
            detail = f"{type(error).__name__}: {error}"
            if os.environ.get('BENCH_TRACE'):
                traceback.print_exc()
        results.append({'feature': label, 'passed': bool(passed), 'detail': str(detail)})
        print(f"{'PASS' if passed else 'FAIL'}  {label}: {detail}")

    passed = sum(1 for r in results if r['passed'])
    print(f"\n{passed}/{len(results)} features")
    print(json.dumps({'passed': passed, 'total': len(results), 'results': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
