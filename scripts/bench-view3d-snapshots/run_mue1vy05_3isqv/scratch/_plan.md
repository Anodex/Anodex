Feature 26 (Doors) — implementation plan

State found on disk:

- 1-25 ticked + all tests + check.py pass.
- _build_level already places '+' doors at corridor->room entrances.
- act('open'/'close') falls through (not wired).
- _line_of_sight only blocks '#', so '+' does NOT block sight yet.
- _walkable = ('.','>','<') so '/' open doors would block movement too.

Changes (engine.py):

1. _walkable: add '/' (open doors walkable; shut '+' still blocks).
2. _line_of_sight: block on '#' and shut '+' (not on '/').
3. act(): wire 'open' and 'close' to _open_door / _close_door.
4. _open_door(x,y): adjacency + is '+' -> '/', message.
5. _close_door(x,y): adjacency + is '/' -> '+', refuse if occupied.
6. tests.py: add feature_26() checks + call.
7. Run tests.py and check.py; fix any regressions.
8. Tick 26 in FEATURES.md.
