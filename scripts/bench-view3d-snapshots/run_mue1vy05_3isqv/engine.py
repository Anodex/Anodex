"""Deepdown — the engine.

Standard library only. Build features in the order FEATURES.md lists them;
never break one that already works. `main.py` draws whatever `state()` gives
it, and the fixed API is the contract: Game(seed, start_depth=1) with
state(), move(direction), act(action, **kwargs) and save/load.
"""
import pickle
import random


DIRECTIONS = {
    'n': (0, -1), 's': (0, 1), 'e': (1, 0), 'w': (-1, 0),
    'ne': (1, -1), 'nw': (-1, -1), 'se': (1, 1), 'sw': (-1, 1),
}

FOV_RADIUS = 8


class Game:
    def __init__(self, seed: int, start_depth: int = 1):
        self.seed = seed
        self.depth = start_depth
        self._messages = ['You descend into the dark.']
        # One map per level, so a seed always rebuilds the same floors.
        self._tiles = {}
        # Feature 12: True once the player's hp hits 0; nothing acts after.
        # Set here, not per level, so death survives a level rebuild.
        self._game_over = False
        # Feature 25: True once the amulet is brought back to the surface.
        self._won = False
        # Feature 15: the player's bag, carried across levels and rebuilds.
        self._inventory = []
        # Feature 18: what the player actually wears; each slot holds the
        # equipped item or None. Carried across levels and rebuilds, like
        # the bag.
        self._equipped = {'weapon': None, 'armour': None}
        # Feature 28: how unknown potions and scrolls look. Drawn once from
        # the seed in _build_level, on a stream of its own, so the same seed
        # always reads the same "cloudy potion" while the map, monsters and
        # item placements are untouched.
        self._appearance = {}
        # The player's body and stats are created once; _build_level only
        # updates the position, so hp and attack survive a descent.
        self._player = {'x': 0, 'y': 0, 'hp': 30, 'max_hp': 30,
                        'attack': 5, 'defense': 1,
                        'level': 1, 'xp': 0,
                        # Feature 29: active status effects, each
                        # {'name', 'turns'}. Ticked on every player action.
                        'effects': []}
        self._roll_appearance()
        self._build_level()

    # -- item appearances ----------------------------------------------------

    def _roll_appearance(self):
        # Feature 28: an appearance per potion/scroll, drawn from the seed on
        # a stream of its own (never self._rng), so the same seed always
        # reads the same look while the level builders' streams stay put.
        roll = random.Random(self.seed * 7919 + 1)
        potions = ['cloudy potion', 'pale potion', 'murky potion',
                   'amber potion', 'gloomy potion']
        labels = ['ZELGO MER', 'FIBOX', 'QUOTY', 'VEXUM', 'RATOS',
                  'PIMBO', 'GLOX', 'WYNDA']
        self._appearance['potion'] = roll.choice(potions)
        self._appearance['scroll'] = f"scroll labelled {roll.choice(labels)}"

    # -- map ---------------------------------------------------------------

    def _build_level(self):
        # The depth must enter the seed or every level would be the same map.
        # Kept on the instance: feature 27's teleport traps draw from the
        # same per-level stream when they fire, and _build_traps is the last
        # builder, so storing it here changes nothing built before it.
        rng = random.Random(self.seed * 100003 + self.depth)
        self._rng = rng
        width, height = 80, 24
        tiles = [['#'] * width for _ in range(height)]

        # At least three rooms; reject overlaps with a margin.
        rooms = []
        attempts = 0
        while len(rooms) < 3 and attempts < 200:
            attempts += 1
            w = rng.randint(6, 16)
            h = rng.randint(4, 8)
            x = rng.randint(1, width - w - 1)
            y = rng.randint(1, height - h - 1)
            if any(x < rx + rw + 2 and x + w + 2 > rx and
                   y < ry + rh + 2 and y + h + 2 > ry
                   for rx, ry, rw, rh in rooms):
                continue
            rooms.append((x, y, w, h))
            for ty in range(y, y + h):
                for tx in range(x, x + w):
                    tiles[ty][tx] = '.'

        # Corridors join the rooms in order; the player starts in the first.
        for (ax, ay, aw, ah), (bx, by, bw, bh) in zip(rooms, rooms[1:]):
            x1, y1 = ax + aw // 2, ay + ah // 2
            x2, y2 = bx + bw // 2, by + bh // 2
            # range() never steps backwards on its own, so build each leg
            # from its smaller to its larger end; order does not matter here.
            xs = range(min(x1, x2), max(x1, x2) + 1)
            ys = range(min(y1, y2), max(y1, y2) + 1)
            for tx in xs:
                tiles[y1][tx] = '.'
            for ty in ys:
                tiles[ty][x2] = '.'

        px = rooms[0][0] + rooms[0][2] // 2
        py = rooms[0][1] + rooms[0][3] // 2

        # Feature 8: exactly one '>' per level, in the last room. Rooms are
        # joined in order, so it is always reachable from the start.
        lx, ly, lw, lh = rooms[-1]
        tiles[ly + lh // 2][lx + lw // 2] = '>'
        if self.depth == 1:
            # Feature 25: the surface ladder, in the first room's top-left
            # corner. The player starts in the room's middle and the
            # corridors only run through room middles, so the corner is
            # never the start tile and is always reachable.
            sx, sy, sw, sh = rooms[0]
            tiles[sy][sx] = '<'

        # Feature 26: a door where each corridor leg crosses a room's wall.
        # The corridor is an L-shape — a horizontal row at y = y1 across
        # x1..x2 and a vertical column at x = x2 down y1..y2. Each leg
        # passes through its room's interior (the room's center is on the
        # leg by construction), so the door is the wall tile just outside
        # that interior on the leg: the exit point, where the corridor
        # leaves the room. Doors start OPEN ('/'): per the spec an open
        # door blocks neither movement nor sight, so a fresh level stays
        # fully connected and a monster can see, and path to, the player
        # across it. The player can then shut a door ('+') to block both.
        for i in range(len(rooms) - 1):
            a, b = rooms[i], rooms[i + 1]
            ax, ay, aw, ah = a
            bx, by, bw, bh = b
            x1, y1 = ax + aw // 2, ay + ah // 2
            x2, y2 = bx + bw // 2, by + bh // 2
            # A's door: the horizontal row (y = y1) exits A's interior at
            # A's east or west wall; if the corridor is purely vertical
            # (x1 == x2) the row is a single tile and the column exits at
            # A's south or north wall instead.
            if x1 != x2:
                tiles[y1][ax + aw - 1 + (1 if x2 > x1 else -1)] = '/'
            else:
                tiles[ay + ah - 1 + (1 if y2 > y1 else -1)][x1] = '/'
            # B's door: the vertical column (x = x2) exits B's interior at
            # B's north or south wall; if the corridor is purely horizontal
            # (y1 == y2) the column is a single tile and the row exits at
            # B's west or east wall instead.
            if y1 != y2:
                tiles[by + bh - 1 + (1 if y1 > y2 else -1)][x2] = '/'
            else:
                tiles[y2][bx + bw - 1 + (1 if x2 > x1 else -1)] = '/'
        self._rooms = rooms  # kept for introspection/testing
        self._tiles[self.depth] = {
            'width': width, 'height': height, 'tiles': tiles,
        }
        # In place: hp, attack and the rest of the character's stats are
        # created once in __init__ and must survive a level rebuild.
        self._player['x'] = px
        self._player['y'] = py
        self._visible = self._compute_fov()
        # Feature 7: a fresh level is a fresh memory.
        self._explored = [row[:] for row in self._visible]
        # Feature 9: monsters, on their own RNG so the map stream is untouched.
        self._build_monsters(rng)
        # Feature 14: items on the floor, built after the monsters so the
        # map and monster streams above are untouched by this draw.
        self._build_items(rng)
        # Feature 27: hidden traps, built after the items so the streams
        # above are untouched by this draw.
        self._build_traps(rng)

    def _build_monsters(self, rng):
        tiles = self._map()['tiles']
        floor = [(x, y) for y in range(len(tiles))
                 for x in range(len(tiles[y])) if tiles[y][x] == '.']
        px, py = self._player['x'], self._player['y']
        taken = {(px, py)}
        names = ['rat', 'bat', 'goblin']
        # Feature 20: the deep levels hit harder. The first four floors keep
        # their flat stats; from depth five on every monster gains +12 max_hp
        # and +2 attack, so the average max_hp on depth 5 is well above
        # depth 1's. The boost is plain arithmetic on the drawn values, not
        # new rng draws — depths 1-4 draw an identical stream, so every
        # existing map, monster and item stays exactly where it was.
        depth_bonus_hp = 12 if self.depth >= 5 else 0
        depth_bonus_attack = 2 if self.depth >= 5 else 0
        monsters = []
        # A couple of monsters per level; none on the player or on each other.
        for _ in range(3):
            if not floor:
                break
            x, y = rng.choice(floor)
            if (x, y) in taken:
                continue
            taken.add((x, y))
            max_hp = 4 + rng.randint(0, 3) + depth_bonus_hp
            # Feature 12: every monster can hurt the player; 2-3 is weak
            # enough that a 30 hp player gets real fights, not one-shots.
            attack = 2 + rng.randint(0, 1) + depth_bonus_attack
            monsters.append({
                'x': x, 'y': y, 'hp': max_hp, 'max_hp': max_hp,
                'name': rng.choice(names), 'alive': True, 'attack': attack,
            })
        self._monsters = monsters

    def _build_items(self, rng):
        # Feature 14: a few items per level, on floor tiles, none on the
        # player or a monster. One kind per item; name matches kind so the
        # later use/equip features can key on either consistently.
        tiles = self._map()['tiles']
        floor = [(x, y) for y in range(len(tiles))
                 for x in range(len(tiles[0])) if tiles[y][x] == '.']
        taken = {(self._player['x'], self._player['y'])}
        taken.update((m['x'], m['y']) for m in self._monsters if m['alive'])
        kinds = ['potion', 'scroll', 'weapon', 'armour']
        items = []
        for _ in range(3):
            if not floor:
                break
            x, y = rng.choice(floor)
            if (x, y) in taken:
                continue
            taken.add((x, y))
            kind = rng.choice(kinds)
            # Feature 18: a weapon's or armour's bonus, drawn after the
            # kind so the placement/kind stream of features 14-17 is
            # untouched. Potions and scrolls carry no bonus.
            if kind in ('weapon', 'armour'):
                bonus = 1 + rng.randint(0, 2)
            else:
                bonus = 0
            # Feature 28: potions and scrolls start unknown — their name is
            # the seed's appearance for the kind, and they carry identified
            # False. Weapons, armour and the amulet are known on pickup.
            if kind in ('potion', 'scroll'):
                items.append({'x': x, 'y': y,
                              'name': self._appearance[kind], 'kind': kind,
                              'bonus': bonus, 'identified': False})
            else:
                items.append({'x': x, 'y': y, 'name': kind, 'kind': kind,
                              'bonus': bonus})
        if self.depth == 5:
            # Feature 25: the amulet — the reason to go down. Drawn after
            # the three normal items, on a floor tile none of them take, so
            # the item stream of features 14-24 (and everything else on the
            # level) is untouched.
            spots = [p for p in floor if p not in taken]
            if spots:
                x, y = rng.choice(spots)
                items.append({'x': x, 'y': y, 'name': 'amulet',
                              'kind': 'amulet', 'bonus': 0})
        if self.depth == 3:
            # Feature 29: the venom vial — the game's poison source. Drawn
            # on a stream of its own (never the level rng), so the map,
            # monster, item and trap placements are all untouched, and the
            # same seed always puts it on the same square.
            spots = [p for p in floor if p not in taken]
            if spots:
                roll = random.Random(self.seed * 104729 + self.depth)
                x, y = roll.choice(spots)
                items.append({'x': x, 'y': y, 'name': 'venom vial',
                              'kind': 'venom', 'bonus': 0})
        self._items = items

    def _build_traps(self, rng):
        # Feature 27: hidden traps on corridor floor tiles. Two kinds:
        #   dart     — fires 4 damage on the player when stepped on.
        #   teleport — moves the player to a random floor tile at least
        #              12 tiles away (Manhattan) so it is a real cross-
        #              level jump, not a nudge.
        # Traps are invisible until stepped on; they are listed in
        # state()['traps'] only after they have fired at least once.
        # A trap that has fired is consumed (discovered=True) and does
        # not fire again.
        tiles = self._map()['tiles']
        floor = [(x, y) for y in range(len(tiles))
                 for x in range(len(tiles[y])) if tiles[y][x] == '.']
        taken = {(self._player['x'], self._player['y'])}
        taken.update((m['x'], m['y']) for m in self._monsters if m['alive'])
        taken.update((i['x'], i['y']) for i in self._items)
        spots = [p for p in floor if p not in taken]
        traps = []
        for _ in range(2):
            if not spots:
                break
            x, y = rng.choice(spots)
            spots.remove((x, y))
            kind = rng.choice(['dart', 'teleport'])
            traps.append({'x': x, 'y': y, 'kind': kind,
                          'discovered': False})
        self._traps = traps

    def _map(self):
        return self._tiles[self.depth]

    # -- the fixed API ------------------------------------------------------

    def state(self) -> dict:
        m = self._map()
        return {
            'depth': self.depth,
            'map': {'width': m['width'], 'height': m['height'],
                    'tiles': [row[:] for row in m['tiles']]},
            'player': dict(self._player),
            'visible': [row[:] for row in self._visible],
            'explored': [row[:] for row in self._explored],
            # Feature 9: shallow copies so callers can't mutate the engine.
            'monsters': [dict(m) for m in self._monsters],
            # Feature 14: items on the floor, same copy rule as the monsters.
            'items': [dict(i) for i in self._items],
            # Feature 15: the bag, same copy rule as the floor items.
            'inventory': [dict(i) for i in self._inventory],
            # Feature 18: None until something is equipped; a weapon's or
            # armour's bonus is already reflected in the player's stats.
            'equipped': {'weapon': self._equipped['weapon'],
                         'armour': self._equipped['armour']},
            'messages': list(self._messages),
            # Feature 12: False until the player's hp hits 0.
            'game_over': self._game_over,
            # Feature 25: True once the amulet is carried back up.
            'won': self._won,
            # Feature 27: hidden until stepped on; only fired traps appear.
            'traps': [dict(t) for t in self._traps if t['discovered']],
        }

    def _walkable(self, tile: str) -> bool:
        # A tile the player may step onto. Floor, the stairs down (feature 8)
        # and the surface ladder (feature 25) once you can stand on them.
        # Feature 26: an open door '/' is walkable; a shut door '+' is not —
        # it stays a wall to movement until act('open') swings it.
        return tile in ('.', '>', '<', '/')

    # -- field of view -----------------------------------------------------

    def _compute_fov(self):
        # Feature 6: a tile is visible when it is within FOV_RADIUS of the
        # player and no wall stands between them along the straight line.
        # Walls themselves are visible; they are the things that block.
        tiles = self._map()['tiles']
        height = len(tiles)
        width = len(tiles[0])
        px, py = self._player['x'], self._player['y']
        visible = [[False] * width for _ in range(height)]
        for y in range(max(0, py - FOV_RADIUS), min(height, py + FOV_RADIUS + 1)):
            for x in range(max(0, px - FOV_RADIUS), min(width, px + FOV_RADIUS + 1)):
                if (x, y) == (px, py):
                    continue
                if (x - px) ** 2 + (y - py) ** 2 > FOV_RADIUS ** 2:
                    continue
                if self._line_of_sight(tiles, px, py, x, y):
                    visible[y][x] = True
        visible[py][px] = True
        return visible

    def _line_of_sight(self, tiles, x1, y1, x2, y2):
        # Bresenham from (x1, y1) to (x2, y2). Any wall on the way — other
        # than the destination tile — blocks the view.
        # Feature 26: a shut door '+' blocks sight too; an open door '/'
        # blocks nothing, exactly like floor.
        dx = abs(x2 - x1)
        dy = abs(y2 - y1)
        sx = 1 if x2 > x1 else -1
        sy = 1 if y2 > y1 else -1
        err = dx - dy
        x, y = x1, y1
        while (x, y) != (x2, y2):
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x += sx
            if e2 < dx:
                err += dx
                y += sy
            if (x, y) == (x2, y2):
                break
            if tiles[y][x] in ('#', '+'):
                return False
        return True

    def _monster_at(self, x, y):
        for m in self._monsters:
            if m['alive'] and (m['x'], m['y']) == (x, y):
                return m
        return None

    def _attack(self, monster):
        # Feature 11: a bump into a living monster is an attack. The player
        # does not move; the monster takes the player's attack as damage.
        self._messages.append(
            f"You hit the {monster['name']}, doing {self._player['attack']} damage.")
        # Feature 12/21: reduced to 0 hp it dies and is worth its max_hp xp.
        self._damage_monster(monster, self._player['attack'])

    def _damage_monster(self, monster, amount: int) -> None:
        # Feature 12/21: shared by melee and throwing. A monster at 0 hp
        # dies, stops blocking, and is worth its full max_hp as xp.
        monster['hp'] -= amount
        if monster['hp'] <= 0:
            monster['alive'] = False
            self._messages.append(f"The {monster['name']} dies.")
            # Feature 21: a kill is worth the monster's full max_hp xp.
            self._gain_xp(monster['max_hp'])

    def _gain_xp(self, amount: int):
        # Feature 21: xp raises; crossing level * 10 raises the level,
        # max_hp and heals, and says so. A big kill can cross several
        # thresholds at once, hence the loop.
        self._player['xp'] += amount
        self._messages.append(
            f"You gain {amount} experience.")
        while self._player['xp'] >= self._player['level'] * 10:
            self._player['level'] += 1
            self._player['max_hp'] += 5
            # The new max is yours to use right away — heal up to it.
            self._player['hp'] = min(
                self._player['max_hp'], self._player['hp'] + 5)
            self._messages.append(
                f"You are now level {self._player['level']}. "
                f"Max hp is {self._player['max_hp']}.")

    def _player_hit(self, monster, damage: int):
        # Feature 12: a monster's blow on the player. Hp never goes below 0;
        # at 0 the player dies and the game freezes.
        self._player['hp'] = max(0, self._player['hp'] - damage)
        self._messages.append(
            f"The {monster['name']} hits you, doing {damage} damage.")
        if self._player['hp'] <= 0 and not self._game_over:
            self._game_over = True
            self._messages.append("You die.")

    # -- status effects -------------------------------------------------------

    def _apply_effect(self, name: str, turns: int):
        # Feature 29: put a status on the player, or extend the one already
        # running if they are afflicted. Every status is {'name', 'turns'} in
        # player['effects']; it counts down in _tick_effects.
        for eff in self._player['effects']:
            if eff['name'] == name:
                eff['turns'] = max(eff['turns'], turns)
                return
        self._player['effects'].append({'name': name, 'turns': turns})
        self._messages.append(f"You are now {name}.")

    def _has_effect(self, name: str) -> bool:
        # Feature 29: is this status currently running?
        return any(eff['name'] == name
                   for eff in self._player['effects'])

    def _tick_effects(self):
        # Feature 29: every player action ages the statuses by one. Poison
        # costs hp on each tick; anything that hits 0 is removed and said
        # so. Runs after the action so a status gained this turn lasts its
        # full count.
        if self._game_over:
            return
        for eff in list(self._player['effects']):
            if eff['name'] == 'poison':
                self._player['hp'] = max(0, self._player['hp'] - 1)
                if self._player['hp'] <= 0 and not self._game_over:
                    self._game_over = True
                    self._messages.append("You die.")
                    return
            eff['turns'] -= 1
            if eff['turns'] <= 0:
                self._player['effects'].remove(eff)
                self._messages.append(f"You are no longer {eff['name']}.")

    def _confused_move(self, direction: str):
        # Feature 29: a confused player's aim is scrambled. The intended
        # direction is dropped from the draw, so the move lands somewhere
        # other than where it was aimed.
        if not self._has_effect('confusion'):
            return direction
        others = tuple(d for d in DIRECTIONS if d != direction)
        return self._rng.choice(others)

    def move(self, direction: str) -> None:
        # Feature 3: movement. All eight directions; only onto a walkable tile.
        # Feature 11: a living monster on the target tile is attacked instead
        # of moved into — the player stays put.
        # Feature 12: once the player is dead, nothing moves anymore.
        if self._game_over:
            return
        # Feature 29: a confused player's aim is scrambled before it moves,
        # so a move may land somewhere other than where it was aimed.
        direction = self._confused_move(direction)
        dx, dy = DIRECTIONS[direction]
        m = self._map()
        x, y = self._player['x'], self._player['y']
        nx, ny = x + dx, y + dy
        in_bounds = 0 <= nx < m['width'] and 0 <= ny < m['height']
        monster = self._monster_at(nx, ny) if in_bounds else None
        if in_bounds and monster is not None:
            # Feature 11: a bump is an attack; the player stays put.
            self._attack(monster)
            self._monsters_turn()
        elif in_bounds and self._walkable(m['tiles'][ny][nx]):
            self._player['x'] = nx
            self._player['y'] = ny
            # The player's eyes moved with them; feature 6.
            self._visible = self._compute_fov()
            # Feature 7: what you have seen, you keep. Merge the new view into
            # the sticky memory — explored tiles never un-explore.
            for y in range(len(self._visible)):
                for x in range(len(self._visible[y])):
                    if self._visible[y][x]:
                        self._explored[y][x] = True
            # Feature 27: a hidden trap on the square the player just stepped
            # on fires as they land — discovered, applied, and announced.
            self._trap_fire()
            self._monsters_turn()
        # Feature 29: movement is a player action, so it ages the statuses too,
        # whatever the outcome. Tick after the monsters so a status gained
        # this turn (a dart, a scroll) lasts its full count.
        self._tick_effects()

    def _trap_fire(self):
        # Feature 27: one hidden trap per tile, built in _build_traps. A
        # discovered trap never fires again. dart damages; teleport flings
        # the player to a random floor tile far away, across the level.
        px, py = self._player['x'], self._player['y']
        for t in self._traps:
            if t['x'] != px or t['y'] != py or t['discovered']:
                continue
            t['discovered'] = True
            if t['kind'] == 'dart':
                self._player['hp'] = max(0, self._player['hp'] - 4)
                self._messages.append(
                    "A dart flies out of the floor, doing 4 damage.")
                if self._player['hp'] <= 0 and not self._game_over:
                    self._game_over = True
                    self._messages.append("You die.")
            else:
                # teleport: pick a floor tile at least 12 away (Manhattan)
                # so the jump is a real cross-level fling, not a nudge.
                tiles = self._map()['tiles']
                floor = [(x, y) for y in range(len(tiles))
                         for x in range(len(tiles[y]))
                         if tiles[y][x] == '.']
                far = [p for p in floor
                       if abs(p[0] - px) + abs(p[1] - py) >= 12]
                if not far:
                    far = [p for p in floor if (p[0], p[1]) != (px, py)]
                if not far:
                    self._messages.append("The floor shifts, but you are "
                                          "nowhere to go.")
                    continue
                tx, ty = self._rng.choice(far)
                self._player['x'], self._player['y'] = tx, ty
                self._visible = self._compute_fov()
                self._messages.append(
                    "The floor lurches — you are flung across the level.")

    # -- monster turns -------------------------------------------------------

    def _monster_sees(self, m):
        # Same rule as the player's own eyes, run from the monster's side.
        tiles = self._map()['tiles']
        px, py = self._player['x'], self._player['y']
        if (px - m['x']) ** 2 + (py - m['y']) ** 2 > FOV_RADIUS ** 2:
            return False
        return self._line_of_sight(tiles, m['x'], m['y'], px, py)

    def _monsters_turn(self):
        # Feature 10: a monster that can see the player closes in by one
        # tile per turn, along a shortest path over floor. It never steps
        # onto the player (that is the bump, feature 11) and never onto
        # another monster's tile.
        tiles = self._map()['tiles']
        height = len(tiles)
        width = len(tiles[0])
        occupied = {(m['x'], m['y']) for m in self._monsters if m['alive']}
        for m in self._monsters:
            if self._game_over:
                break  # feature 12: the rest of the pack does not act on a corpse
            if not m['alive'] or not self._monster_sees(m):
                continue
            path = self._bfs(m['x'], m['y'], self._player['x'], self._player['y'])
            if not path:
                continue
            nx, ny = path[1]
            if (nx, ny) == (self._player['x'], self._player['y']):
                # Feature 12: a monster that reached the player attacks
                # instead of moving. The hit may kill the player.
                self._player_hit(m, m['attack'])
                continue
            if (nx, ny) in occupied:
                continue
            occupied.discard((m['x'], m['y']))
            m['x'], m['y'] = nx, ny
            occupied.add((nx, ny))

    def _bfs(self, x0, y0, x1, y1):
        # Shortest path from (x0, y0) to (x1, y1) over walkable-for-monsters
        # tiles, as a list of (x, y) starting at the origin. None if
        # unreachable. Feature 26: an open door '/' is floor to a monster —
        # a door blocks movement only while it is shut, so a monster can
        # cross an open doorway and reach a player standing on one.
        tiles = self._map()['tiles']
        from collections import deque
        seen = {(x0, y0)}
        queue = deque([(x0, y0)])
        parent = {(x0, y0): None}
        while queue:
            x, y = queue.popleft()
            if (x, y) == (x1, y1):
                break
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                           (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < len(tiles[0]) and 0 <= ny < len(tiles)):
                    continue
                if (nx, ny) in seen or tiles[ny][nx] not in ('.', '/'):
                    continue
                seen.add((nx, ny))
                parent[(nx, ny)] = (x, y)
                queue.append((nx, ny))
        if (x1, y1) not in parent:
            return None
        path = [(x1, y1)]
        node = (x1, y1)
        while parent[node] is not None:
            node = parent[node]
            path.append(node)
        path.reverse()
        return path

    def act(self, action: str, **kwargs) -> None:
        # An impossible action never raises — it does nothing and adds a
        # message. Later features fill in the rest.
        # Feature 12: once the player is dead, nothing acts anymore —
        # no waits, no descents, no monsters.
        if self._game_over:
            return
        if action == 'wait':
            self._messages.append("You wait.")
            self._monsters_turn()
        elif action == 'descend':
            # Feature 8: only works standing on the '>' tile.
            if self._map()['tiles'][self._player['y']][self._player['x']] != '>':
                self._messages.append("There are no stairs here.")
            else:
                self.depth += 1
                self._build_level()
                self._messages.append(f"You descend to level {self.depth}.")
        elif action == 'ascend':
            # Feature 25: the only way out. Must stand on the '<' tile and
            # be carrying the amulet; otherwise nothing happens and a
            # message says why.
            tiles = self._map()['tiles']
            here = tiles[self._player['y']][self._player['x']]
            if here != '<':
                self._messages.append("There is no ladder here.")
            elif not any(i.get('kind') == 'amulet'
                         for i in self._inventory):
                self._messages.append(
                    "You need the amulet to climb out.")
            else:
                self._won = True
                self._messages.append(
                    "You climb the ladder to the surface, amulet in hand. "
                    "You win.")
        elif action == 'pickup':
            self._pickup()
        elif action == 'equip':
            self._equip(kwargs.get('index', 0))
        elif action == 'unequip':
            self._unequip(kwargs.get('slot', 'weapon'))
        elif action == 'use':
            self._use(kwargs.get('index', 0))
        elif action == 'throw':
            self._throw(kwargs.get('index', 0),
                        kwargs.get('x', self._player['x']),
                        kwargs.get('y', self._player['y']))
        elif action in ('open', 'close'):
            self._door(action, kwargs.get('x'), kwargs.get('y'))
        else:
            # Per the API contract an impossible action never raises — it
            # does nothing but leave a note.
            self._messages.append(f"You can't do that.")
        # Feature 29: every act is a player action — the statuses age with
        # it, whatever the outcome, so a poison or confusion lasts its full
        # count. Runs after the action so one gained this turn is not
        # immediately aged off.
        self._tick_effects()

    def _door(self, action: str, x, y) -> None:
        # Feature 26: swing a door the player is standing next to. The target
        # square must be adjacent (eight-way, like movement) and hold a door;
        # a shut door '+' becomes open '/', and an open door shuts only when
        # nothing — not the player, not a monster — is standing on it.
        px, py = self._player['x'], self._player['y']
        if not (isinstance(x, int) and isinstance(y, int)
                and max(abs(x - px), abs(y - py)) == 1):
            self._messages.append("There is no door there.")
            return
        m = self._map()
        if not (0 <= x < m['width'] and 0 <= y < m['height']):
            self._messages.append("There is no door there.")
            return
        tile = m['tiles'][y][x]
        if tile == '+':
            if action != 'open':
                self._messages.append("The door is already shut.")
                return
            m['tiles'][y][x] = '/'
            self._messages.append("You open the door.")
        elif tile == '/':
            if action != 'close':
                self._messages.append("The door is already open.")
                return
            if self._monster_at(x, y) is not None \
                    or (px, py) == (x, y):
                self._messages.append("Something is standing in the way.")
                return
            m['tiles'][y][x] = '+'
            self._messages.append("You close the door.")
        else:
            self._messages.append("There is no door there.")
            return
        # The walls moved; the view changes with them.
        self._visible = self._compute_fov()
        for ty in range(len(self._visible)):
            for tx in range(len(self._visible[ty])):
                if self._visible[ty][tx]:
                    self._explored[ty][tx] = True

    # -- items -------------------------------------------------------------

    def _pickup(self) -> None:
        # Feature 15: standing on an item moves it to the bag; off one it
        # does nothing. Feature 16: the bag holds at most 26 items.
        x, y = self._player['x'], self._player['y']
        found = None
        for item in self._items:
            if item['x'] == x and item['y'] == y:
                found = item
                break
        if found is None:
            return
        if len(self._inventory) >= 26:
            self._messages.append("You can't carry anything else.")
            return
        self._items.remove(found)
        self._inventory.append(dict(found))
        self._messages.append(f"You pick up the {found['name']}.")

    def _equip(self, index: int) -> None:
        # Feature 18: a weapon raises attack, armour raises defense, and
        # the slot holds the item. Anything else in the bag — a potion,
        # a scroll, or an empty slot — is refused and stays in the bag.
        if not isinstance(index, int) or not 0 <= index < len(self._inventory):
            self._messages.append("You don't have that.")
            return
        item = self._inventory[index]
        kind = item.get('kind')
        if kind == 'weapon':
            stat = 'attack'
        elif kind == 'armour':
            stat = 'defense'
        else:
            self._messages.append(f"You can't wear the {item['name']}.")
            return
        if self._equipped[kind] is not None:
            self._messages.append("Your hands are full — unequip first.")
            return
        bonus = item.get('bonus', 1)
        self._equipped[kind] = item
        self._player[stat] += bonus
        self._messages.append(f"You put on the {item['name']} "
                              f"({stat} +{bonus}).")

    def _unequip(self, slot: str) -> None:
        # Feature 18: reverse _equip exactly — the stat falls back to
        # its base and the slot is empty again.
        if slot not in ('weapon', 'armour'):
            self._messages.append("You can't do that.")
            return
        if self._equipped[slot] is None:
            self._messages.append(f"You are not wearing a {slot}.")
            return
        item = self._equipped[slot]
        stat = 'attack' if slot == 'weapon' else 'defense'
        bonus = item.get('bonus', 1)
        self._player[stat] -= bonus
        self._equipped[slot] = None
        self._messages.append(f"You take off the {item['name']}.")

    def _use(self, index: int) -> None:
        # Feature 17: a potion raises hp, never above max_hp, and is
        # consumed. Only potions exist that are usable right now; the
        # others get a refusal message (equipment is feature 18).
        if not isinstance(index, int) or not 0 <= index < len(self._inventory):
            self._messages.append("You don't have that.")
            return
        item = self._inventory[index]
        kind = item.get('kind')
        if kind in ('potion', 'scroll'):
            # Feature 28: using one identifies every item of that kind for
            # the rest of the game, even one that flares uselessly.
            self._identify(item)
        if kind == 'potion':
            self._inventory.pop(index)
            self._player['hp'] = min(self._player['max_hp'],
                                     self._player['hp'] + 10)
            self._messages.append("You drink the potion. It tastes of iron.")
            return
        if kind == 'scroll':
            self._use_scroll(item, index)
            return
        if kind == 'venom':
            # Feature 29: the vial poisons the player (a trap that comes
            # with the loot) and is consumed. Six turns of poison, so the
            # full cost is six hp spread over the following actions.
            self._inventory.pop(index)
            self._apply_effect('poison', 6)
            self._messages.append(
                "You uncork the vial and it shatters. Something stings.")
            return
        self._messages.append(f"You can't use the {item['name']}.")

    def _identify(self, item):
        # Feature 28: the moment a potion or scroll is used, every item of
        # that kind the player owns or sees is revealed for good — the
        # floor items on this level and the whole bag, known names and all.
        kind = item.get('kind')
        real = {'potion': 'healing potion', 'scroll': 'scroll of flame'}[kind]
        if item.get('identified'):
            return
        first = item['name']
        self._messages.append(
            f"It is a {real} — every {first} you hold is one too.")
        for i in self._items:
            if i.get('kind') == kind:
                i['name'] = real
                i['identified'] = True
        for i in self._inventory:
            if i.get('kind') == kind:
                i['name'] = real
                i['identified'] = True
        for slot in ('weapon', 'armour'):
            e = self._equipped.get(slot)
            if e is not None and e.get('kind') == kind:
                e['name'] = real
                e['identified'] = True

    def _use_scroll(self, item, index: int) -> None:
        # Feature 23: a scroll of flame. It strikes the first monster the
        # player can see — not necessarily adjacent — for heavy damage, and
        # is consumed. With nothing in sight it flares uselessly and stays
        # in the bag, so the player is never robbed of it.
        visible = [m for m in self._monsters
                   if m['alive'] and self._visible[m['y']][m['x']]]
        if not visible:
            self._messages.append("The scroll flares and dies in the dark.")
            return
        target = visible[0]
        # 12 covers the deepest monster (max 7 + 12 = 19) in a single strike,
        # so a scroll always ends the fight it starts.
        damage = 12
        target['hp'] -= damage
        self._messages.append(
            f"The scroll flares. The {target['name']} takes {damage} damage.")
        if target['hp'] <= 0:
            target['alive'] = False
            self._messages.append(f"The {target['name']} dies.")
            # Feature 21: a kill is still worth its full max_hp xp.
            self._gain_xp(target['max_hp'])
        self._inventory.pop(index)

    def _throw(self, index: int, tx: int, ty: int) -> None:
        # Feature 24: an item can be thrown at a square. The throw travels
        # any distance — no adjacency needed, which is the whole point of
        # it — and the item is always consumed: a thrown thing is gone. If a
        # living monster stands on the target square it takes the player's
        # attack as damage; a kill still grants its full max_hp xp.
        if not isinstance(index, int) or not 0 <= index < len(self._inventory):
            self._messages.append("You don't have that.")
            return
        item = self._inventory[index]
        self._inventory.pop(index)
        target = None
        if isinstance(tx, int) and isinstance(ty, int) \
                and 0 <= tx < len(self._map()['tiles'][0]) \
                and 0 <= ty < len(self._map()['tiles']):
            for m in self._monsters:
                if m['alive'] and m['x'] == tx and m['y'] == ty:
                    target = m
                    break
        if target is None:
            self._messages.append(f"You throw the {item['name']} into the dark.")
            return
        damage = self._player['attack']
        self._messages.append(
            f"You throw the {item['name']} at the {target['name']}, "
            f"doing {damage} damage.")
        self._damage_monster(target, damage)

    def save(self, path: str) -> None:
        # Feature 22: pickle the whole instance. Every attribute is plain
        # data (no file handles or locks), and pickle reconstructs via
        # __new__ rather than __init__, so the level is not rebuilt on load.
        with open(path, 'wb') as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path: str) -> "Game":
        # Feature 22: inverse of save(). __init__ is skipped, so the game
        # resumes exactly where it was written — same floor, bag, and body.
        with open(path, 'rb') as f:
            return pickle.load(f)
