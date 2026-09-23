// Phase two: give Deepdown eyes.
//
// The engine never knew about the terminal — everything it knows leaves through
// one `state()` dictionary, and `main.py` is just one reader of it. That split
// is what let a hidden suite drive the game headlessly, and it is the same
// split that lets a first-person view be added without touching the engine.
//
// Two rules keep this a benchmark rather than a demo:
//
//   1. **The maths lives apart from the pixels.** `render3d.py` imports nothing
//      but the standard library and is graded exactly as the engine was. A
//      raycaster's projection is a pure function of a grid, a position and an
//      angle, so most of what makes a view correct can be measured.
//   2. **The window has a seam.** `view3d.py` must expose what it drew, so the
//      suite can build a View against SDL's dummy driver, press keys and read
//      the result back. That is not test-fitting — it is the same reason the
//      engine has `state()` at all.
//
// Usage: node scripts/bench-view3d-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/Roguelike'

const SPEC = `# Deepdown in first person

The engine is built and it works. This is a second way of looking at it: a
first-person raycast view, the way Wolfenstein 3D drew its corridors — walls in
perspective, monsters as flat sprites turned to face you, the dungeon seen from
inside instead of from above.

**Do not change \`engine.py\`, \`main.py\`, \`check.py\` or \`tests.py\`.** The engine
is finished for this purpose and the terminal view has to keep working.
Everything here goes in new files.

## The split that matters

Two files, and the boundary between them is the point.

**\`render3d.py\`** — the maths. Standard library only: no pygame, no window, no
files. Given a grid and where you stand, it works out what is on screen. Every
function is pure.

**\`view3d.py\`** — the window. Owns pygame, the event loop and the drawing. It
asks \`render3d\` for every number it needs and computes none of them itself.

Both files expose what they know, the way \`engine.py\` exposes \`state()\`. A
number that only exists inside a drawing call is a number nobody can check —
not a test, not the next feature, not you in a week. Hand it out.

## Angles

Radians. **0 is east** (+x), and the angle increases toward **south** (+y), the
direction y grows down the map. So east 0, south π/2, west π, north 3π/2.

Facing left to right across the screen, **column 0 is the ray at
\`facing - fov/2\`** and the last column is at \`facing + fov/2\`. Facing east that
puts north on the left of the screen and south on the right, which is what
standing there and looking east would give you.

Facing is a float the view owns. The engine knows nothing about it.

## \`render3d.py\` — the interface

\`\`\`python
WALLS = '#+'          # a shut door blocks sight; an open one '/' does not

def cast_ray(tiles, x, y, angle, max_distance=32.0) -> dict:
    """The first wall a ray meets.

    Returns {'distance': float, 'side': 'x' | 'y', 'tile': str,
             'cell': (int, int)}. Distance is Euclidean from (x, y).
    'side' is the face struck: 'x' for a vertical face, 'y' for a horizontal
    one. Nothing found inside max_distance returns that distance, tile '' and
    whatever cell the ray gave up in.
    """

def cast_view(tiles, x, y, facing, fov, columns) -> list[dict]:
    """One entry per screen column, left to right.

    Exactly \`columns\` entries, the first at \`facing - fov/2\`. Each is a
    \`cast_ray\` result whose distance has been **fisheye-corrected** —
    multiplied by the cosine of the angle between that column's ray and
    \`facing\` — so a flat wall ahead reads flat rather than bowed.
    """

def column_height(distance, screen_height, scale=1.0) -> int:
    """How tall a wall slice is. Inversely proportional to distance: twice as
    far is half as tall. Never above screen_height, never below 1."""

def shade(distance, side, max_distance=32.0) -> float:
    """Brightness, 0.0 to 1.0. Closer is brighter, and it never leaves that
    range. A 'y' face is dimmer than an 'x' face at the same distance, which is
    what gives corners an edge without any lighting model."""

def project_sprite(x, y, facing, fov, sprite_x, sprite_y, columns, screen_height) -> dict | None:
    """Where a thing standing on the floor appears.

    Returns {'column': int, 'size': int, 'distance': float} — the screen column
    of its centre, its height in pixels, and how far off it is. Nearer means
    bigger. Returns None when it is behind the viewer or outside the field of
    view.
    """
\`\`\`

## \`view3d.py\` — the interface

\`python view3d.py [seed]\` opens a window and plays it. But the window is also
driven headlessly, so it needs the same kind of seam:

\`\`\`python
WALL_COLOURS = {'#': (...), '+': (...), ...}   # a door is not a wall's colour

class View:
    def __init__(self, game, width=640, height=400):
        """Takes a live engine.Game — or anything with the same state() — and
        must work with SDL_VIDEODRIVER=dummy, so nothing here may need a real
        display or wait for input."""

    game                # the game it was handed
    facing: float       # radians, as above
    fov: float          # radians, the field of view frame() casts with
    depth: list[float]  # the last frame's per-column wall distance, one each

    def frame(self):
        """Draw one frame and return the pygame.Surface it was drawn on."""

    def sprites(self) -> list[dict]:
        """What the last frame drew as sprites: the project_sprite dicts, each
        also carrying the 'x' and 'y' of the square it came from. Only things
        the player can see, and only things in front of a wall."""

    def hud_lines(self) -> list[str]:
        """The overlay text the last frame drew."""

    def minimap_rect(self) -> tuple:
        """(x, y, width, height) of the minimap inside the frame."""

    def ending_lines(self) -> list[str]:
        """The death or victory text, or [] while the game is still going."""

    def key(self, name):
        """One keypress by name: 'w' 's' 'a' 'd' 'left' 'right' 'g' '>' '<'
        'i' 'q'. Applies exactly the effect the real key has."""

    def run(self):
        """The real loop — clock, events, quit. Only __main__ calls this."""
\`\`\`

Keys: **w/s** walk forward and back, **a/d** strafe, **left/right** turn,
**g** pick up, **>** descend, **<** ascend, **i** inventory, **q** quit.

Walking asks the engine (\`game.move(direction)\`) with whichever compass
direction is nearest the facing. The engine stays the authority on what is
legal: walls still stop you, and walking into a monster still attacks it. The
view never moves the player itself.

## Definition of done

\`FEATURES-3D.md\` lists the features in order. Tick a box only when it works.
Run \`python check3d.py\` before finishing — it casts a ray and builds a View
with no window and no display.
`

const FEATURES = `# The view, one feature per run

Same rules as before: one at a time, tick only what works, break nothing —
including the engine and the terminal view, which both have to keep passing.

- [ ] 1. **A ray finds a wall.** \`cast_ray\` returns a dict with \`distance\`,
      \`side\`, \`tile\` and \`cell\`. Fired down a corridor it stops at the near
      face of the first wall — the distance to that face, not to the middle of
      the square, and the \`cell\` is the wall's own coordinates.
- [ ] 2. **Nothing is not a wall.** A ray with no wall inside \`max_distance\`
      returns exactly that distance and an empty \`tile\`, rather than raising
      or looping forever.
- [ ] 3. **Both faces.** A ray striking a vertical wall face reports \`side\`
      'x'; one striking a horizontal face reports 'y'.
- [ ] 4. **A full sweep.** \`cast_view\` returns exactly \`columns\` entries, the
      first at \`facing - fov/2\` and the last at \`facing + fov/2\`, each one a
      \`cast_ray\` result.
- [ ] 5. **No fisheye.** Standing square-on to a flat wall, the corrected
      distances across the middle half of the screen vary by under 5%.
      Uncorrected they bow far more, which is the bug this feature is.
- [ ] 6. **Perspective.** \`column_height\` halves when distance doubles, never
      exceeds \`screen_height\`, and never returns less than 1.
- [ ] 7. **Depth shading.** \`shade\` falls as distance grows, never leaves 0..1,
      and is lower for a 'y' face than an 'x' face at the same distance.
- [ ] 8. **A window with a seam.** \`view3d.py\` defines \`View\`, builds against a
      live \`engine.Game\` with no display, and \`frame()\` returns a surface of
      the size asked for. \`key('q')\` is taken without a crash.
- [ ] 9. **Walls in perspective.** \`frame()\` draws one vertical slice per
      column, sized and placed by \`column_height\`, shaded by \`shade\`, cast by
      \`cast_view\`. Ceiling, wall and floor are not all one colour, and
      neighbouring columns differ.
- [ ] 10. **Turning.** \`key('left')\` and \`key('right')\` rotate \`facing\` in
      opposite directions, by less than a quarter turn a press, and the frame
      drawn afterwards changes with it.
- [ ] 11. **Walking.** \`key('w')\` moves through the engine in whichever compass
      direction is faced, onto the square that is actually there; \`s\` reverses
      it; \`a\` and \`d\` strafe across the facing in opposite directions.
- [ ] 12. **Things you can see.** \`project_sprite\` puts a sprite at the centre
      column when it is directly ahead, right of centre when it is to the
      right, left of centre when to the left, and returns None when it is
      behind you. Nearer is bigger.
- [ ] 13. **Hidden behind walls.** \`frame()\` leaves \`View.depth\` holding one
      wall distance per column, matching what \`cast_view\` would say, and the
      sprite path consults it so a thing further off than the wall in its own
      column is not drawn.
- [ ] 14. **Monsters and items on screen.** \`sprites()\` reports what the last
      frame drew — \`project_sprite\` dicts carrying the \`x\` and \`y\` they came
      from — scaled by distance, and only for squares
      \`state()['visible']\` says the player can see. Turn your back and they
      are gone.
- [ ] 15. **Doors.** A shut door \`+\` stops a ray and draws as a wall in its own
      colour from \`WALL_COLOURS\`; an open one \`/\` is a doorway sight and feet
      both pass through.
- [ ] 16. **A head-up display.** \`hud_lines()\` gives what the frame drew over
      the view: the depth, the hp with its number, the character level, and the
      most recent message from the log.
- [ ] 17. **A minimap.** \`minimap_rect()\` marks a corner of the frame — inside
      it, no more than a corner — holding an overhead map of what has been
      explored, in more than one colour, with the facing shown on it so that
      turning redraws it.
- [ ] 18. **An ending on screen.** \`ending_lines()\` is empty while the game
      runs. Once \`state()['game_over']\` is set it gives a screen worth
      reading, carrying the depth reached and the level attained, and victory
      reads differently from death.
`

const CHECK = `#!/usr/bin/env python3
"""A smoke test for the view. No display: SDL's dummy driver stands in."""
import os
import sys

os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')

try:
    import render3d
except Exception as error:
    print(f"FAIL: render3d.py does not import: {error}")
    sys.exit(1)

try:
    tiles = [list('#######'), list('#.....#'), list('#######')]
    hit = render3d.cast_ray(tiles, 1.5, 1.5, 0.0)
    assert isinstance(hit, dict), 'cast_ray must return a dict'
    assert 'distance' in hit, "cast_ray must return 'distance'"
    print(f"OK: render3d casts a ray (distance {hit['distance']:.2f}).")
except Exception as error:
    print(f"FAIL: render3d: {type(error).__name__}: {error}")
    sys.exit(1)

try:
    import engine
    import view3d

    view = view3d.View(engine.Game(42))
    surface = view.frame()
    assert surface is not None, 'frame() must return the surface it drew on'
    print('OK: view3d builds a View and draws a frame with no display.')
except Exception as error:
    print(f"FAIL: view3d: {type(error).__name__}: {error}")
    sys.exit(1)
`

export function writeFixture(root = WORKSPACE) {
  fs.writeFileSync(path.join(root, 'SPEC-3D.md'), SPEC, 'utf8')
  fs.writeFileSync(path.join(root, 'FEATURES-3D.md'), FEATURES, 'utf8')
  fs.writeFileSync(path.join(root, 'check3d.py'), CHECK, 'utf8')
  return root
}

if (process.argv[1] && process.argv[1].endsWith('bench-view3d-fixture.mjs')) {
  const root = writeFixture()
  const count = FEATURES.split('\n').filter((line) => /^- \[ \] \d+\./.test(line)).length
  console.log(`wrote the view spec into ${root} — ${count} features`)
}
