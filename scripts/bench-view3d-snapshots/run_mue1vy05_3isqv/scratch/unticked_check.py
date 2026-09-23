"""Cheap pass over unticked features 18-34: what does the engine actually do?"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine

g = engine.Game(42)

# 18: equipment
inv = g.state()['inventory']
idx = None
for i, it in enumerate(inv):
    if it['kind'] in ('weapon', 'armour'):
        idx = i
        break
print("18 equip: act('equip') in act()? ", end="")
try:
    if idx is not None:
        g.act('equip', index=idx)
    print("no exception; equipped=", g.state()['equipped'],
          "attack=", g.state()['player']['attack'])
except Exception as e:
    print("raised", type(e).__name__, e)

# 19/20: bestiary across depths 1-5
names, hp_by_name = set(), {}
for d in range(1, 6):
    gd = engine.Game(42, start_depth=d)
    for m in gd.state()['monsters']:
        names.add(m['name'])
        hp_by_name.setdefault(m['name'], set()).add(m['max_hp'])
print("19 names 1-5:", sorted(names), "max_hp per name:", hp_by_name)

# 21: xp on kill
g2 = engine.Game(7)
print("21 xp starts:", g2.state()['player']['xp'])

# 22: save/load
try:
    g2.save('scratch/save.bin')
    print("22 save: no exception")
except Exception as e:
    print("22 save:", type(e).__name__, e)

# 23: scroll use
gs = engine.Game(11)
sidx = None
for i, it in enumerate(gs.state()['inventory']):
    if it['kind'] == 'scroll':
        sidx = i
print("23 scroll in fresh inv (before pickup):", sidx)

# 25: amulet on depth 5
g5 = engine.Game(42, start_depth=5)
print("25 kinds on depth 5:", sorted({i['kind'] for i in g5.state()['items']}),
      "won key:", g5.state().get('won'))

# 26-34: keys in state?
st = g.state()
print("27 traps key present:", 'traps' in st)
print("28 identified key on items:", any('identified' in i for i in st['items']))
print("29 player effects key:", 'effects' in st['player'])
print("30 trait key:", any('trait' in m for m in st['monsters']))
print("32 nutrition key:", 'nutrition' in st['player'])
print("34 score/epitaph keys:", 'score' in st, 'epitaph' in st)
