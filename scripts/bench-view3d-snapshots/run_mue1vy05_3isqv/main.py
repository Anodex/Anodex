#!/usr/bin/env python3
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
    print('\n'.join(out))

    print(
        f"depth {state.get('depth', 1)}  hp {player['hp']}/{player['max_hp']}  "
        f"atk {player.get('attack', '-')}  def {player.get('defense', '-')}  "
        f"lvl {player.get('level', 1)}  xp {player.get('xp', 0)}"
    )
    for message in state.get('messages', [])[-4:]:
        print(message)
    print("\nwasd move  yubn diagonals  g pickup  > descend  < ascend  i inventory  q quit")


def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    game = Game(seed)
    while True:
        draw(game)
        state = game.state()
        if state.get('game_over'):
            print("\nYou died.")
            return
        if state.get('won'):
            print("\nYou escaped with the amulet. Well done.")
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
