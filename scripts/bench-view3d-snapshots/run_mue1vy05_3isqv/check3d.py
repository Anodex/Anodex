#!/usr/bin/env python3
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
