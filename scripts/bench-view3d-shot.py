#!/usr/bin/env python3
"""Photograph the first-person view without a display.

The point of a graphical phase is that somebody looks at it, and the rubric
deliberately cannot: it checks that a frame has structure, not that it looks
like anything. This renders real frames to PNG so a person can judge the half
no test can.

Runs against SDL's dummy driver, so it needs no window and does not disturb a
benchmark run in progress — it only reads the workspace.

Usage:
  python scripts/bench-view3d-shot.py [workspace] [--out DIR] [--seed N]
"""
import argparse
import os
import sys

os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')
os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')

DEFAULT_WORKSPACE = 'C:/Users/Owner/Desktop/Sandbox/Roguelike'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('workspace', nargs='?', default=DEFAULT_WORKSPACE)
    parser.add_argument('--out', default=None, help='where to write the PNGs')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--width', type=int, default=640)
    parser.add_argument('--height', type=int, default=400)
    args = parser.parse_args()

    sys.path.insert(0, args.workspace)
    out = args.out or os.path.join(args.workspace, 'scratch', 'shots')

    try:
        import engine
    except Exception as error:
        print(f"engine.py does not import: {error}")
        return 1
    try:
        import view3d
    except ModuleNotFoundError:
        print('view3d.py does not exist yet — the window feature has not been built.')
        return 2
    except Exception as error:
        print(f"view3d.py does not import: {type(error).__name__}: {error}")
        return 1

    import pygame

    os.makedirs(out, exist_ok=True)
    game = engine.Game(args.seed)
    try:
        view = view3d.View(game, width=args.width, height=args.height)
    except Exception as error:
        print(f"View would not build: {type(error).__name__}: {error}")
        return 1

    # A short tour: look around from where you start, then walk on a little.
    # Turning first, because the opening square is often facing a wall and a
    # wall fills the frame with one flat colour.
    shots = []
    plan = [
        ('start', []),
        ('turned-left', ['left'] * 4),
        ('turned-back', ['left'] * 8),
        ('stepped', ['w', 'w']),
        ('stepped-again', ['w', 'w', 'w'])
    ]
    for name, keys in plan:
        for key in keys:
            try:
                view.key(key)
            except Exception as error:
                print(f"key({key!r}) failed: {type(error).__name__}: {error}")
                return 1
        try:
            surface = view.frame()
        except Exception as error:
            print(f"frame() failed: {type(error).__name__}: {error}")
            return 1
        path = os.path.join(out, f'{args.seed}-{name}.png')
        pygame.image.save(surface, path)
        shots.append(path)

    state = game.state()
    print(f"depth {state['depth']}, hp {state['player']['hp']}/{state['player']['max_hp']}")
    for path in shots:
        print(path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
