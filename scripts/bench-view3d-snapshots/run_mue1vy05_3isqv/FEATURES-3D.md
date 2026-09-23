# The view, one feature per run

Same rules as before: one at a time, tick only what works, break nothing —
including the engine and the terminal view, which both have to keep passing.

- [ ] 1. **A ray finds a wall.** `cast_ray` returns a dict with `distance`,
      `side`, `tile` and `cell`. Fired down a corridor it stops at the near
      face of the first wall — the distance to that face, not to the middle of
      the square, and the `cell` is the wall's own coordinates.
- [ ] 2. **Nothing is not a wall.** A ray with no wall inside `max_distance`
      returns exactly that distance and an empty `tile`, rather than raising
      or looping forever.
- [ ] 3. **Both faces.** A ray striking a vertical wall face reports `side`
      'x'; one striking a horizontal face reports 'y'.
- [ ] 4. **A full sweep.** `cast_view` returns exactly `columns` entries, the
      first at `facing - fov/2` and the last at `facing + fov/2`, each one a
      `cast_ray` result.
- [ ] 5. **No fisheye.** Standing square-on to a flat wall, the corrected
      distances across the middle half of the screen vary by under 5%.
      Uncorrected they bow far more, which is the bug this feature is.
- [ ] 6. **Perspective.** `column_height` halves when distance doubles, never
      exceeds `screen_height`, and never returns less than 1.
- [ ] 7. **Depth shading.** `shade` falls as distance grows, never leaves 0..1,
      and is lower for a 'y' face than an 'x' face at the same distance.
- [ ] 8. **A window with a seam.** `view3d.py` defines `View`, builds against a
      live `engine.Game` with no display, and `frame()` returns a surface of
      the size asked for. `key('q')` is taken without a crash.
- [ ] 9. **Walls in perspective.** `frame()` draws one vertical slice per
      column, sized and placed by `column_height`, shaded by `shade`, cast by
      `cast_view`. Ceiling, wall and floor are not all one colour, and
      neighbouring columns differ.
- [ ] 10. **Turning.** `key('left')` and `key('right')` rotate `facing` in
      opposite directions, by less than a quarter turn a press, and the frame
      drawn afterwards changes with it.
- [ ] 11. **Walking.** `key('w')` moves through the engine in whichever compass
      direction is faced, onto the square that is actually there; `s` reverses
      it; `a` and `d` strafe across the facing in opposite directions.
- [ ] 12. **Things you can see.** `project_sprite` puts a sprite at the centre
      column when it is directly ahead, right of centre when it is to the
      right, left of centre when to the left, and returns None when it is
      behind you. Nearer is bigger.
- [ ] 13. **Hidden behind walls.** `frame()` leaves `View.depth` holding one
      wall distance per column, matching what `cast_view` would say, and the
      sprite path consults it so a thing further off than the wall in its own
      column is not drawn.
- [ ] 14. **Monsters and items on screen.** `sprites()` reports what the last
      frame drew — `project_sprite` dicts carrying the `x` and `y` they came
      from — scaled by distance, and only for squares
      `state()['visible']` says the player can see. Turn your back and they
      are gone.
- [ ] 15. **Doors.** A shut door `+` stops a ray and draws as a wall in its own
      colour from `WALL_COLOURS`; an open one `/` is a doorway sight and feet
      both pass through.
- [ ] 16. **A head-up display.** `hud_lines()` gives what the frame drew over
      the view: the depth, the hp with its number, the character level, and the
      most recent message from the log.
- [ ] 17. **A minimap.** `minimap_rect()` marks a corner of the frame — inside
      it, no more than a corner — holding an overhead map of what has been
      explored, in more than one colour, with the facing shown on it so that
      turning redraws it.
- [ ] 18. **An ending on screen.** `ending_lines()` is empty while the game
      runs. Once `state()['game_over']` is set it gives a screen worth
      reading, carrying the depth reached and the level attained, and victory
      reads differently from death.
