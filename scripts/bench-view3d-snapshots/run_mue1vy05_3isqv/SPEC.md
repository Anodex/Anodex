# Deepdown — a terminal roguelike

Python 3, **standard library only**. No pip packages, no `curses` (it is not
in the Windows standard library).

`main.py` is written and **must not be changed** — it draws the game and reads
keys. It imports `engine.py`, which does not exist yet. **Building `engine.py`
is the job**, one feature at a time, in the order `FEATURES.md` lists them.

## The rule that matters most

**Never break a feature that already works.** Every finished feature is checked
again after every run. Adding feature twelve and breaking feature three scores
worse than not adding feature twelve at all.

## The engine API

This is fixed. Everything that grades this project drives these and nothing
else, so they must keep working exactly as described however the inside
changes.

```python
class Game:
    def __init__(self, seed: int, start_depth: int = 1): ...
    def state(self) -> dict: ...
    def move(self, direction: str) -> None
    def act(self, action: str, **kwargs) -> None
    def save(self, path: str) -> None

    @staticmethod
    def load(path: str) -> "Game"
```

**`seed` makes everything reproducible.** Two `Game(42)` objects must generate
the identical map, monsters and items. Use `random.Random(seed)`, never the
module-level `random`.

**`start_depth`** begins the game already on that floor, exactly as if the
player had walked down to it. It is the dev convenience every roguelike has —
inspecting depth five should not require surviving depths one to four. Add it
when you build stairs (feature 8); before then it can be ignored.

**`direction`** is one of `n s e w ne nw se sw`.

**`act`** takes an action name and keyword arguments:
`wait`, `descend`, `ascend`, `pickup`, `use(index)`, `equip(index)`,
`unequip(slot)`, `drop(index)`, `throw(index, x, y)`, `open(x, y)`,
`close(x, y)`, `eat(index)`.

An action that cannot happen — descending where there are no stairs, using
item 9 of three — does nothing and adds a message. **It never raises.**

## `state()`

One dictionary, the only thing anything outside the engine reads. Keys appear
as the features that own them are built; nothing needs a key before its
feature exists.

```python
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

  # added by the features that make it a game (26 onward)
  'traps':   [{'x': 12, 'y': 3, 'kind': 'dart'}],
  'score':   0,
  'epitaph': None,
}
```

**Tiles** are single characters: `#` wall, `.` floor, `>` stairs down,
`<` stairs up, `+` a shut door, `/` an open one. `tiles[y][x]`, not
`[x][y]`.

**`kind`** is one of `potion`, `scroll`, `weapon`, `armour`, `amulet`,
`food`.

## Definition of done for a feature

`FEATURES.md` states what each feature must do, precisely enough to check.
When one works, tick its box in `FEATURES.md` — and only then.

Run `python check.py` before you finish: it is a smoke test that the engine
imports, builds a game and takes a turn without raising. Passing it does not
mean the feature is done; failing it means nothing else is worth checking.
