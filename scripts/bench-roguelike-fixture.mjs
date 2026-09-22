// The long-horizon workload: a terminal roguelike, built one feature per run.
//
// Everything measured so far finished in four to eight turns. Nothing ran long,
// nothing accumulated, and the journal has never gone past run two — so the
// whole design for run thirty-one of a series is untested. This is the test for
// that, and the question it answers is the one nobody measures: does an agent
// break what it already built?
//
// The shape that makes it answerable: the engine's API is fixed here, in the
// spec, and the acceptance suite drives it headlessly with a fixed seed. The
// terminal rendering — the part that cannot be tested without a person looking
// at it — is supplied. So the agent builds the half that can be graded, and
// the half that makes it fun to play is already there waiting for it.
//
// Usage: node scripts/bench-roguelike-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/Roguelike'

const SPEC = `# Deepdown — a terminal roguelike

Python 3, **standard library only**. No pip packages, no \`curses\` (it is not
in the Windows standard library).

\`main.py\` is written and **must not be changed** — it draws the game and reads
keys. It imports \`engine.py\`, which does not exist yet. **Building \`engine.py\`
is the job**, one feature at a time, in the order \`FEATURES.md\` lists them.

## The rule that matters most

**Never break a feature that already works.** Every finished feature is checked
again after every run. Adding feature twelve and breaking feature three scores
worse than not adding feature twelve at all.

## The engine API

This is fixed. Everything that grades this project drives these and nothing
else, so they must keep working exactly as described however the inside
changes.

\`\`\`python
class Game:
    def __init__(self, seed: int, start_depth: int = 1): ...
    def state(self) -> dict: ...
    def move(self, direction: str) -> None
    def act(self, action: str, **kwargs) -> None
    def save(self, path: str) -> None

    @staticmethod
    def load(path: str) -> "Game"
\`\`\`

**\`seed\` makes everything reproducible.** Two \`Game(42)\` objects must generate
the identical map, monsters and items. Use \`random.Random(seed)\`, never the
module-level \`random\`.

**\`start_depth\`** begins the game already on that floor, exactly as if the
player had walked down to it. It is the dev convenience every roguelike has —
inspecting depth five should not require surviving depths one to four. Add it
when you build stairs (feature 8); before then it can be ignored.

**\`direction\`** is one of \`n s e w ne nw se sw\`.

**\`act\`** takes an action name and keyword arguments:
\`wait\`, \`descend\`, \`ascend\`, \`pickup\`, \`use(index)\`, \`equip(index)\`,
\`unequip(slot)\`, \`drop(index)\`, \`throw(index, x, y)\`.

An action that cannot happen — descending where there are no stairs, using
item 9 of three — does nothing and adds a message. **It never raises.**

## \`state()\`

One dictionary, the only thing anything outside the engine reads. Keys appear
as the features that own them are built; nothing needs a key before its
feature exists.

\`\`\`python
{
  'depth': 1,
  'map': {'width': 80, 'height': 24, 'tiles': [['#', '.', ...], ...]},
  'player': {'x': 5, 'y': 5, 'hp': 30, 'max_hp': 30,
             'attack': 4, 'defense': 1, 'level': 1, 'xp': 0},
  'visible':  [[False, ...], ...],
  'explored': [[False, ...], ...],
  'monsters': [{'x': 9, 'y': 4, 'hp': 6, 'max_hp': 6, 'name': 'rat', 'alive': True}],
  'items':    [{'x': 3, 'y': 7, 'name': 'healing potion', 'kind': 'potion'}],
  'inventory':[{'name': 'healing potion', 'kind': 'potion'}],
  'equipped': {'weapon': None, 'armour': None},
  'messages': ['You descend into the dark.'],
  'game_over': False,
  'won': False,
}
\`\`\`

**Tiles** are single characters: \`#\` wall, \`.\` floor, \`>\` stairs down,
\`<\` stairs up. \`tiles[y][x]\`, not \`[x][y]\`.

**\`kind\`** is one of \`potion\`, \`scroll\`, \`weapon\`, \`armour\`, \`amulet\`.

## Definition of done for a feature

\`FEATURES.md\` states what each feature must do, precisely enough to check.
When one works, tick its box in \`FEATURES.md\` — and only then.

Run \`python check.py\` before you finish: it is a smoke test that the engine
imports, builds a game and takes a turn without raising. Passing it does not
mean the feature is done; failing it means nothing else is worth checking.
`

const FEATURES = `# Features

One per run, in order. Tick a box only when that feature actually works.

- [ ] 1. **A map exists.** \`state()['map']\` has \`width\` >= 40, \`height\` >= 20,
      and a \`tiles\` grid of that size containing both \`#\` and \`.\`. Two games
      with the same seed produce identical tiles.
- [ ] 2. **The player exists.** \`state()['player']\` has \`x\`, \`y\`, \`hp\`,
      \`max_hp\`, and the player stands on a \`.\` tile.
- [ ] 3. **Movement.** \`move('e')\` increases the player's x by one when the
      tile east is floor; \`n\` decreases y. All eight directions work.
- [ ] 4. **Walls stop you.** Moving into a \`#\` leaves the position unchanged
      and does not raise.
- [ ] 5. **Rooms and corridors.** The map has at least three rectangular rooms
      joined by corridors, and **every floor tile is reachable** from where the
      player starts.
- [ ] 6. **Field of view.** \`state()['visible']\` is a grid of booleans. The
      player's own tile is visible; a floor tile with a wall between it and the
      player is not.
- [ ] 7. **Memory.** \`state()['explored']\` stays True for any tile that has
      ever been visible, after the player moves away and it is no longer
      visible.
- [ ] 8. **Stairs down.** Exactly one \`>\` tile per level. Standing on it,
      \`act('descend')\` increases \`depth\` by one and builds a new map. Off the
      stairs it does nothing and adds a message.
- [ ] 9. **Monsters.** \`state()['monsters']\` is non-empty, each on a floor
      tile, none on the player's tile, each with \`hp\`, \`max_hp\`, \`name\`,
      \`alive\`.
- [ ] 10. **They come for you.** A monster that can see the player moves
      closer over successive \`act('wait')\` calls.
- [ ] 11. **Bump to attack.** Moving into a living monster's tile attacks it
      instead of moving: the player does not move and the monster's hp falls.
- [ ] 12. **Death.** A monster reduced to 0 hp has \`alive\` False and stops
      blocking the tile. When the player's hp reaches 0, \`game_over\` is True
      and further moves change nothing.
- [ ] 13. **Messages.** \`state()['messages']\` gains a line when the player
      attacks, when a monster dies, and when the player takes damage.
- [ ] 14. **Items on the floor.** \`state()['items']\` is non-empty, each on a
      floor tile, each with \`name\` and \`kind\`.
- [ ] 15. **Pick things up.** Standing on an item, \`act('pickup')\` removes it
      from \`items\` and adds it to \`inventory\`. Off an item it does nothing.
- [ ] 16. **Carrying capacity.** The inventory holds at most 26 items; picking
      up past that refuses with a message and leaves the item on the floor.
- [ ] 17. **Potions.** \`act('use', index=i)\` on a \`potion\` raises the
      player's hp, never above \`max_hp\`, and removes it from the inventory.
- [ ] 18. **Equipment.** \`act('equip', index=i)\` on a \`weapon\` raises
      \`player['attack']\` and sets \`equipped['weapon']\`; armour raises
      \`defense\`. \`act('unequip', slot='weapon')\` reverses it exactly.
- [ ] 19. **A bestiary.** At least three distinct monster \`name\`s appear
      across depths 1 to 5, with different \`max_hp\` between them.
- [ ] 20. **It gets worse down there.** Monsters on depth 5 have a higher
      average \`max_hp\` than monsters on depth 1, for the same seed.
- [ ] 21. **Experience.** Killing a monster raises \`player['xp']\`. Crossing a
      threshold raises \`player['level']\` and \`max_hp\`, and says so in a
      message.
- [ ] 22. **Save and load.** \`game.save(path)\` then \`Game.load(path)\` gives a
      game whose \`state()\` equals the original's exactly.
- [ ] 23. **Scrolls.** A \`scroll\` item exists. Using one damages or kills a
      monster the player can see, and is consumed.
- [ ] 24. **Throwing.** \`act('throw', index=i, x=tx, y=ty)\` affects a monster
      at that square from a distance and consumes the item.
- [ ] 25. **A reason to go down.** An \`amulet\` lies on depth 5. Carrying it
      back to the \`<\` on depth 1 and calling \`act('ascend')\` sets \`won\`.
`

const MAIN = `#!/usr/bin/env python3
"""Deepdown — the part you look at.

Not part of the work: this file is the game's face, and it is finished. It
imports engine.Game and draws whatever state() gives it, so it keeps working
as the engine grows. Do not change it.

Run it with:  python main.py
"""
import os
import sys

try:
    from engine import Game
except ImportError:
    print("engine.py does not exist yet. See SPEC.md and FEATURES.md.")
    sys.exit(1)

KEYS = {
    'w': 'n', 's': 's', 'a': 'w', 'd': 'e',
    'y': 'nw', 'u': 'ne', 'b': 'sw', 'n': 'se',
}


def draw(game):
    state = game.state()
    os.system('cls' if os.name == 'nt' else 'clear')
    grid = state['map']['tiles']
    visible = state.get('visible')
    explored = state.get('explored')

    glyphs = [row[:] for row in grid]
    for item in state.get('items', []):
        glyphs[item['y']][item['x']] = '!' if item['kind'] == 'potion' else '?'
    for monster in state.get('monsters', []):
        if monster.get('alive', True):
            glyphs[monster['y']][monster['x']] = monster['name'][0].upper()
    player = state['player']
    glyphs[player['y']][player['x']] = '@'

    out = []
    for y, row in enumerate(glyphs):
        line = []
        for x, char in enumerate(row):
            if visible is not None and not visible[y][x]:
                if explored is not None and explored[y][x]:
                    line.append(char if char in '#.<>' else ' ')
                else:
                    line.append(' ')
            else:
                line.append(char)
        out.append(''.join(line))
    print('\\n'.join(out))

    print(
        f"depth {state.get('depth', 1)}  hp {player['hp']}/{player['max_hp']}  "
        f"atk {player.get('attack', '-')}  def {player.get('defense', '-')}  "
        f"lvl {player.get('level', 1)}  xp {player.get('xp', 0)}"
    )
    for message in state.get('messages', [])[-4:]:
        print(message)
    print("\\nwasd move  yubn diagonals  g pickup  > descend  < ascend  i inventory  q quit")


def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    game = Game(seed)
    while True:
        draw(game)
        state = game.state()
        if state.get('game_over'):
            print("\\nYou died.")
            return
        if state.get('won'):
            print("\\nYou escaped with the amulet. Well done.")
            return
        try:
            key = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            return
        if key == 'q':
            return
        if key in KEYS:
            game.move(KEYS[key])
        elif key == 'g':
            game.act('pickup')
        elif key == '>':
            game.act('descend')
        elif key == '<':
            game.act('ascend')
        elif key == 'i':
            for index, item in enumerate(game.state().get('inventory', [])):
                print(f"  {index}: {item['name']} ({item['kind']})")
            input("(enter)")
        elif key.startswith('u '):
            game.act('use', index=int(key.split()[1]))
        elif key.startswith('e '):
            game.act('equip', index=int(key.split()[1]))
        else:
            game.act('wait')


if __name__ == '__main__':
    main()
`

const CHECK = `#!/usr/bin/env python3
"""A smoke test, not a grade.

It asks the one question worth asking before anything else: does the engine
import, build a game, and survive a turn? A feature that looks finished on top
of an engine that will not import is not finished.
"""
import sys

try:
    from engine import Game
except Exception as error:
    print(f"FAIL: engine.py does not import: {error}")
    sys.exit(1)

try:
    game = Game(42)
    state = game.state()
    assert isinstance(state, dict), "state() must return a dict"
    assert 'map' in state and 'player' in state, "state() needs 'map' and 'player'"
    game.move('e')
    game.act('wait')
    print("OK: the engine imports, builds a game and takes a turn.")
except Exception as error:
    print(f"FAIL: {type(error).__name__}: {error}")
    sys.exit(1)
`

export function writeWorkspace(root = WORKSPACE) {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'SPEC.md'), SPEC, 'utf8')
  fs.writeFileSync(path.join(root, 'FEATURES.md'), FEATURES, 'utf8')
  fs.writeFileSync(path.join(root, 'main.py'), MAIN, 'utf8')
  fs.writeFileSync(path.join(root, 'check.py'), CHECK, 'utf8')
  return root
}

if (process.argv[1] && process.argv[1].endsWith('bench-roguelike-fixture.mjs')) {
  const root = writeWorkspace()
  const features = FEATURES.split('\n').filter((line) => /^- \[ \] \d+\./.test(line)).length
  console.log(`wrote ${root} — ${features} features to build, one per run`)
}
