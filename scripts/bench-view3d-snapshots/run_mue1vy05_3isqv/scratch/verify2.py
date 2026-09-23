# -*- coding: utf-8 -*-
"""Remaining state checks: item builder, SPEC schema, tests.py tail."""
import io

lines = io.open('engine.py', encoding='utf-8').read().splitlines()
for i, line in enumerate(lines):
    if line.startswith('    def _build_items('):
        for j in range(i, min(i + 22, len(lines))):
            print(f"ENG {j+1:4d} {lines[j]}")
        break

print()
sl = io.open('SPEC.md', encoding='utf-8').read().splitlines()
for i, line in enumerate(sl):
    if 'inventory' in line or 'equipped' in line:
        print(f"SPEC {i+1:4d} {line}")

print()
tl = io.open('tests.py', encoding='utf-8').read().splitlines()
for i in range(len(tl) - 12, len(tl)):
    print(f"TST {i+1:4d} {tl[i]}")
