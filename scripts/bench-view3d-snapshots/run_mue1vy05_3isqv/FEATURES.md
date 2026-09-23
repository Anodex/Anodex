# Features

One per run, in order. Tick a box only when that feature actually works.

- [x] 1. **A map exists.** `state()['map']` has `width` >= 40, `height` >= 20,
      and a `tiles` grid of that size containing both `#` and `.`. Two games
      with the same seed produce identical tiles.
- [x] 2. **The player exists.** `state()['player']` has `x`, `y`, `hp`,
      `max_hp`, and the player stands on a `.` tile.
- [x] 3. **Movement.** `move('e')` increases the player's x by one when the
      tile east is floor; `n` decreases y. All eight directions work.
- [x] 4. **Walls stop you.** Moving into a `#` leaves the position unchanged
      and does not raise.
- [x] 5. **Rooms and corridors.** The map has at least three rectangular rooms
      joined by corridors, and **every floor tile is reachable** from where the
      player starts.
- [x] 6. **Field of view.** `state()['visible']` is a grid of booleans. The
      player's own tile is visible; a floor tile with a wall between it and the
      player is not.
- [x] 7. **Memory.** `state()['explored']` stays True for any tile that has
      ever been visible, after the player moves away and it is no longer
      visible.
- [x] 8. **Stairs down.** Exactly one `>` tile per level. Standing on it,
      `act('descend')` increases `depth` by one and builds a new map. Off the
      stairs it does nothing and adds a message.
- [x] 9. **Monsters.** `state()['monsters']` is non-empty, each on a floor
      tile, none on the player's tile, each with `hp`, `max_hp`, `name`,
      `alive`.
- [x] 10. **They come for you.** A monster that can see the player moves
      closer over successive `act('wait')` calls.
- [x] 11. **Bump to attack.** Moving into a living monster's tile attacks it
      instead of moving: the player does not move and the monster's hp falls.
- [x] 12. **Death.** A monster reduced to 0 hp has `alive` False and stops
      blocking the tile. When the player's hp reaches 0, `game_over` is True
      and further moves change nothing.
- [x] 13. **Messages.** `state()['messages']` gains a line when the player
      attacks, when a monster dies, and when the player takes damage.
- [x] 14. **Items on the floor.** `state()['items']` is non-empty, each on a
      floor tile, each with `name` and `kind`.
- [x] 15. **Pick things up.** Standing on an item, `act('pickup')` removes it
      from `items` and adds it to `inventory`. Off an item it does nothing.
- [x] 16. **Carrying capacity.** The inventory holds at most 26 items; picking
      up past that refuses with a message and leaves the item on the floor.
- [x] 17. **Potions.** `act('use', index=i)` on a `potion` raises the
      player's hp, never above `max_hp`, and removes it from the inventory.
- [x] 18. **Equipment.** `act('equip', index=i)` on a `weapon` raises
      `player['attack']` and sets `equipped['weapon']`; armour raises
      `defense`. `act('unequip', slot='weapon')` reverses it exactly.
- [x] 19. **A bestiary.** At least three distinct monster `name`s appear
      across depths 1 to 5, with different `max_hp` between them.
- [x] 20. **It gets worse down there.** Monsters on depth 5 have a higher
      average `max_hp` than monsters on depth 1, for the same seed.
- [x] 21. **Experience.** Killing a monster raises `player['xp']`. Crossing a
      threshold raises `player['level']` and `max_hp`, and says so in a
      message.
- [x] 22. **Save and load.** `game.save(path)` then `Game.load(path)` gives a
      game whose `state()` equals the original's exactly.
- [x] 23. **Scrolls.** A `scroll` item exists. Using one damages or kills a
      monster the player can see, and is consumed.
- [x] 24. **Throwing.** `act('throw', index=i, x=tx, y=ty)` affects a monster
      at that square from a distance and consumes the item.
- [x] 25. **A reason to go down.** An `amulet` lies on depth 5. Carrying it
      back to the `<` on depth 1 and calling `act('ascend')` sets `won`.

## The half that makes it a game

Everything above is the skeleton. Everything below is the reason to play it.
Same rules: one per run, tick only what works, break nothing.

- [x] 26. **Doors.** Some room entrances are doors — tile `+` shut, `/` open.
      `act('open', x=, y=)` and `act('close', x=, y=)` on an adjacent door
      toggle it. A shut door blocks both movement and sight; an open one blocks
      neither. A door cannot be shut on a square something is standing on.
- [x] 27. **Traps.** Hidden squares that fire when stepped on — damage, or a
      teleport across the level. `state()['traps']` lists only the ones the
      player has discovered, each with `x`, `y`, `kind`. Stepping on one
      discovers it, applies it, and says so.
- [x] 28. **Unidentified things.** Potions and scrolls start unknown: `name`
      reads as an appearance — "cloudy potion", "scroll labelled ZELGO MER" —
      and each carries `identified` false. Using one identifies every item of
      that type for the rest of the game. The appearance for a kind is stable
      within a seed. This is the whole tension of finding a potion.
- [x] 29. **Status effects.** `player['effects']` is a list of
      `{'name', 'turns'}`. Poison costs hp each turn and wears off; confusion
      sends `move` somewhere other than where it was aimed. Effects tick down
      on every action and are announced when they end.
- [ ] 30. **Monsters worth remembering.** At least three with a behaviour
      rather than a stat line: one that flees below a third of its hp, one that
      steals an item and runs for the stairs, one that splits into two weaker
      copies when hit and survives. Each names it in `monsters[i]['trait']`.
- [ ] 31. **Things that shoot back.** A monster that attacks along a clear line
      from range instead of closing. It costs hp without ever being adjacent,
      which is what turns a corridor into a decision.
- [ ] 32. **Hunger.** `player['nutrition']` falls every turn from a full start.
      `food` items restore it, eaten with `act('eat', index=i)`. At zero the
      player starves, with warnings well before. This is the clock that stops
      anyone grinding one safe level forever.
- [ ] 33. **Something guarding the way out.** A unique boss on depth 5: its own
      name, `boss` true, more hp than anything else in the game, and the amulet
      in its room. Killing it is the point of the descent.
- [ ] 34. **An ending worth reading.** On death or victory `state()['score']`
      holds a number built from depth reached, xp earned and what was carried
      out, and `state()['epitaph']` is a line naming what killed you, or that
      you got out. A roguelike you lose should still tell you the story.
