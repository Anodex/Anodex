# Feature 29 — Status effects

## Spec (FEATURES.md line 83-86)

- `player['effects']` is a list of `{'name', 'turns'}`.
- Poison costs hp each turn and wears off.
- Confusion sends `move` somewhere other than where it was aimed.
- Effects tick down on every action and are announced when they end.

## Three gaps (confirmed on disk)

1. `_apply_effect` is defined but **never called** → no status ever granted.
2. `_tick_effects` only runs in `move()` and `act('wait')` → not on pickup, use,
   throw, equip, door, descend, ascend.
3. `_confused_move` picks `rng.choice(tuple(DIRECTIONS))` → can return the aimed
   direction. Spec: "other than where it was aimed."

## Design decisions

- **Poison source**: the `dart` trap. It already fires on the player's tile and
  does 4 damage. Adding `self._apply_effect('poison', 4)` after the damage is a
  real, in-world source. feature_27 tests set hp to 30, dart does 4 → 26. Poison
  ticks once at end of that same `move()` call (I'll place tick before the
  monster-turn return in the attack branch, and after monsters in the move
  branch) → 25. feature_27 checks `hp` is reduced, not an exact value, so 25 vs 26
  is fine. Need to re-check feature_27's exact assertion.

- **Confusion source**: a scroll of confusion? No — the only scroll is "scroll of
  flame" and feature_28 locks its real name. Better: a **monster** — the rat
  poisons on hit, the bat confuses on hit. But feature_12/11 check exact damage.
  Alternative: grant confusion from a new item. But adding a new item kind changes
  the RNG stream and breaks feature_28's appearance checks.

  Simplest safe source for confusion: a **second scroll** is not available.
  Instead: the `teleport` trap can also confuse (it already moves the player).
  Actually the cleanest: make the **rat** a poisoner on hit. feature_11 and
  feature_12 check `monster['hp']` after a player attack and `player['hp']` after
  a monster hit. If the rat poisons on hit, the poison tick at end of that move
  would reduce hp by 1 extra → feature_12's exact-hp check might fail.

  Let me re-check feature_12's exact assertion before choosing.

- **Tick placement**: move `_tick_effects()` to the END of `move()` (covers all
  move outcomes) and the END of every `act()` branch (wait already has it; add to
  pickup, use, throw, equip, unequip, door, descend, ascend). The cleanest way:
  add a single `self._tick_effects()` call at the very end of `act()`, after the
  if/elif chain, so every action path ticks exactly once. But `wait` already
  ticks and returns early. And `descend`/`ascend` return early too. So I need to
  either remove the early returns or add tick to each. Simplest: remove the
  per-branch `_tick_effects()` from `wait` and add one universal tick at the end
  of `act()`, and keep the one in `move()`. But `descend` and `ascend` return
  before the end of `act()`. I'll restructure: let all branches fall through to a
  single tick at the bottom.

Let me check feature_12 and feature_27 exact hp assertions now.
