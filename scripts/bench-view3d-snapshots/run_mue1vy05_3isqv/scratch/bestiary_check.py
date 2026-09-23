"""Does feature 19 (bestiary) hold across seeds, as currently built?"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine

for seed in range(1, 15):
    names = set()
    hp_by_name = {}
    for d in range(1, 6):
        gd = engine.Game(seed, start_depth=d)
        for m in gd.state()['monsters']:
            names.add(m['name'])
            hp_by_name.setdefault(m['name'], set()).add(m['max_hp'])
    ok = len(names) >= 3
    if ok:
        # "different max_hp between them": the species must not all share one hp
        allsets = [hp_by_name[n] for n in names]
        ok = len(set(frozenset(s) for s in allsets)) >= 2
    print(f"seed {seed:2d}: names={sorted(names)} ok={ok} "
          f"hp={ {n: sorted(hp_by_name[n]) for n in sorted(names)} }")
