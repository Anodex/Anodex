#!/usr/bin/env python3
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
