# -*- coding: utf-8 -*-
"""Verify on-disk state before implementing features 15-19.

Prints: FEATURES.md lines 38-50, engine.py act() and _build_items,
SPEC.md inventory/equipped lines, and the test registration tail of
tests.py.
"""
import io
import re


def show(path, start, end=None, label=None):
    if end is None:
        end = start
    lines = io.open(path, encoding='utf-8').read().splitlines()
    print(f"=== {path} lines {start}-{end} ===")
    for i in range(start - 1, min(end, len(lines))):
        print(f"{i+1:4d} {lines[i]}")


def grep(path, pattern, label=None):
    print(f"=== {path}: {re.escape(pattern)[:60]} ===")
    for i, line in enumerate(
            io.open(path, encoding='utf-8').read().splitlines()):
        if re.search(pattern, line):
            print(f"{i+1:4d} {line}")


# Which feature boxes are still open?
grep('FEATURES.md', r'- \[ \] \d+\.')

# Exact wording of features 15-19.
show('FEATURES.md', 38, 50)

# Current act() implementation.
for i, line in enumerate(
        io.open('engine.py', encoding='utf-8').read().splitlines()):
    if line.startswith('    def act('):
        show('engine.py', i + 1, i + 30)
        break

# Item builder (name/kind values).
for i, line in enumerate(
        io.open('engine.py', encoding='utf-8').read().splitlines()):
    if line.startswith('    def _build_items('):
        show('engine.py', i + 1, i + 22)
        break

# SPEC state schema for inventory/equipped.
grep('SPEC.md', r'inventory|equipped')

# Test registration tail.
lines = io.open('tests.py', encoding='utf-8').read().splitlines()
print(f"=== tests.py lines {len(lines)-12}-{len(lines)} ===")
for i in range(len(lines) - 12, len(lines)):
    print(f"{i+1:4d} {lines[i]}")
