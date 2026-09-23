# Deepdown in first person

The engine is built and it works. This is a second way of looking at it: a
first-person raycast view, the way Wolfenstein 3D drew its corridors — walls in
perspective, monsters as flat sprites turned to face you, the dungeon seen from
inside instead of from above.

**Do not change `engine.py`, `main.py`, `check.py` or `tests.py`.** The engine
is finished for this purpose and the terminal view has to keep working.
Everything here goes in new files.

## The split that matters

Two files, and the boundary between them is the point.

**`render3d.py`** — the maths. Standard library only: no pygame, no window, no
files. Given a grid and where you stand, it works out what is on screen. Every
function is pure.

**`view3d.py`** — the window. Owns pygame, the event loop and the drawing. It
asks `render3d` for every number it needs and computes none of them itself.

Both files expose what they know, the way `engine.py` exposes `state()`. A
number that only exists inside a drawing call is a number nobody can check —
not a test, not the next feature, not you in a week. Hand it out.

## Angles

Radians. **0 is east** (+x), and the angle increases toward **south** (+y), the
direction y grows down the map. So east 0, south π/2, west π, north 3π/2.

Facing left to right across the screen, **column 0 is the ray at
`facing - fov/2`** and the last column is at `facing + fov/2`. Facing east that
puts north on the left of the screen and south on the right, which is what
standing there and looking east would give you.

Facing is a float the view owns. The engine knows nothing about it.

## `render3d.py` — the interface

```python
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

    Exactly `columns` entries, the first at `facing - fov/2`. Each is a
    `cast_ray` result whose distance has been **fisheye-corrected** —
    multiplied by the cosine of the angle between that column's ray and
    `facing` — so a flat wall ahead reads flat rather than bowed.
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
```

## `view3d.py` — the interface

`python view3d.py [seed]` opens a window and plays it. But the window is also
driven headlessly, so it needs the same kind of seam:

```python
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
```

Keys: **w/s** walk forward and back, **a/d** strafe, **left/right** turn,
**g** pick up, **>** descend, **<** ascend, **i** inventory, **q** quit.

Walking asks the engine (`game.move(direction)`) with whichever compass
direction is nearest the facing. The engine stays the authority on what is
legal: walls still stop you, and walking into a monster still attacks it. The
view never moves the player itself.

## Definition of done

`FEATURES-3D.md` lists the features in order. Tick a box only when it works.
Run `python check3d.py` before finishing — it casts a ray and builds a View
with no window and no display.
