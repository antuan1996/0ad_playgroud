# Petra AI: bugs worth reporting upstream

Found while porting Petra (`simulation/ai/petra/`) to TypeScript and covering
it with behaviour tests (`simulation/ai/petra_ts/tests/`, see `FINDINGS.md`
there), then confirmed in matches played in the game.

- **Part 1**: twelve bugs with a fix each, in `petra-fixes.patch` (11 files,
  +36 −19). Apply from the repository root with `git apply petra-fixes.patch`.
- **Part 2**: behaviour that looks unintended, reported without a patch: the
  right fix is a design choice.

The patch is made against this repository's `petra/*.js` (restored from
upstream in commit 4cf8a9bba9; the upstream revision is not recorded). Check it
with `git apply --check` against upstream's current `main` before filing.

## How the patch was checked

- **Tests.** The behaviour-test suite runs against both the port and the
  original. Unpatched, the original fails 16 of 1528 tests, each pinning one of
  the bugs below; patched, it passes all 1528. ESLint is clean.
- **In game.** Unpatched, the original never reaches town phase in a real game
  (bug 1): it lost 9 of 10 headless conquest matches against the port, and a
  match against itself was still in village phase at game minute 1899.
  Patched, it played the port (seeds 1/1, mainland, very hard, Athenians)
  through town and city phase to 259 population and held out until 54:23, with
  no script error or warning.

## Part 1: bugs, fixed in the patch

Ordered by how much they matter in a game.

### 1. `baseManager.removeDropsite` wipes every resource list (every game)

```js
if (!supply[i].ent || !gameState.getEntityById(supply[i].id))
	supply.splice(i--, 1);
```

Nothing ever writes a supply's `ent` field, so the first clause is always true
and the loop empties every list of every dropsite, not only the entries of the
removed one. `basesManager` calls `removeDropsite` for **any** destroyed entity
with `base` metadata, units included, so the first unit a player loses wipes
its base's resource lists.

Effect in a game: the base keeps no supplies, so gatherers go idle, wood stops,
no metal is ever mined and the bot never reaches town phase; food piles up into
the millions over a long game.

Fix: drop the `!supply[i].ent ||` clause. The second branch already removes
the removed dropsite's own entries.

### 2. `diplomacyManager` last-man-standing check throws in every wonder or relic game

`lastManStandingCheck` uses `filters` without importing it: a `ReferenceError`
in every game with the wonder or capture-the-relic victory condition. With the
import, `getEnemyStructures(i).filter(...)[0]` still reads index 0 of an
`EntityCollection`, which is always `undefined`.

Fix: import `filters`; read `.toEntityArray()[0]`.

### 3. `victoryManager` relic raids add `NaN`

Both relic-capture loops add `ent.captureStrength() * getAttackBonus(...)` for
every unit. A unit that cannot capture (a ram, a ship) returns `undefined`, so
the total becomes `NaN` and every comparison with it is false: the "already
enough units" exit never fires, and every nearby capturer is sent each time.

Fix: skip units with no capture strength (the first loop also needed braces).

### 4. `attackPlan` never finds walls

```js
gameState.getEnemyStructures().filter(filters.byClass(["Palisade", "Wall"]))
```

`byClass` takes one class name; an array never matches, so an attack never
sees the walls blocking it.

Fix: `filters.byClasses(["Palisade", "Wall"])`.

### 5. `worker` idles a woodcutter on its way home

While a gatherer carries its load back, its UnitAI order targets the dropsite.
The "is there a better supply" check treats that dropsite as an unbooked
supply; when every booked tree is crowded, the worker loses its gatherer role
and is made idle instead of finishing the trip.

Fix: only run the check when the target is a resource supply
(`supply.resourceSupplyType()`).

### 6. `navalManager` sorts with a one-argument comparator

```js
plans.sort(plan => plan.units.length);
```

A comparator with one parameter does not order anything: a unit does not join
the passage with the fewest units.

Fix: `plans.sort((a, b) => a.units.length - b.units.length)`.

### 7. `transportPlan` destroys a unit it means to keep

When reloading a unit fails, the branch commented "leave it there" for a unit
on a land we use still calls `ent.destroy()` (with a TODO saying it should
not).

Fix: keep the unit and cancel its garrison order (`ent.stopMoving()`), so it is
not reloaded without a plan on the next turn.

### 8. `garrisonManager.cancelGarrison` reads the booking after releasing it

`leaveGarrison` clears the unit's `garrisonHolder` metadata, and only then is it
read, so the holder's list is never updated: the cancelled unit is counted as
still on its way until the next garrison update drops it (and a debug warning).

Fix: read the holder before `leaveGarrison`.

### 9. `queueplanBuilding.buildOverseaDock` throws with no builder left

With a dock position found but the last unit of the builder's type dead this
turn, `findBuilder` returns nothing and `builder.construct` throws, leaving the
plan with the dock template swapped in.

Fix: only build when there is a builder; the template is restored either way.

### 10. `attackManager` reads a unit before checking it exists

When an army's units are handed to an attack, `unit.getMetadata(...)` runs
before the `if (unit && ...)` check, and throws for a unit that died.

Fix: `if (!unit) continue;` first.

### 11. `basesManager` TrainingFinished with no base

A trained worker whose `base` metadata names no base (a plan with no ground
yet) dereferences `undefined`. Rare: only construction plans use base −1.

Fix: skip it this turn; it is assigned once the base exists.

### 12. `worker` transport lookup for gatherers

A gatherer waiting for a transport reads `plan.state` without checking the plan
exists, which the builder's lookup just above does check. Not reached today
(the naval manager clears `transport` before dropping a plan), but the two
lookups should match.

Fix: `if (plan && ...)`, as for builders.

## Part 2: unintended-looking behaviour, no patch

The same in the port, which keeps them to stay faithful; some are pinned by
tests as they are.

- **First field only when fruit runs low** (`baseManager.checkResourceLevels`).
  The first field is queued only once the base's fruit within reach (nearby,
  and medium before town phase; animals not counted) falls below 600, whatever
  the food income. On a fruit-rich map a bot under pressure starves with wood
  to spare: in one match (savanna) a side kept 1150–3850 fruit in reach all
  game, never built a field while 6–13 units (then none) gathered food, held
  under 350 food from minute 3 and was destroyed at 16:39. The code's own TODO
  names the gap ("add a check on time used/lost").
- **`attackPlan.checkTargetObstruction`**: `if (!angle) continue` treats a
  rotation of exactly 0 as no angle, so a wall placed square to the map is
  never seen as blocking.
- **`attackPlan.reassignFastUnit`**: the class list `["FastMoving",
  "CitizenSoldier"]` is an any-of, so any infantry citizen soldier is handed to
  a raid, not only fast units.
- **`baseManager.pickBuilders`**: any worker without a plan scores −20, which
  overrides its idle (−50) score: idle workers are not preferred over busy
  gatherers when builders are lent.
- **`baseManager`**: a worker already repairing one building but still marked
  as a gatherer can be taken by the next repair (only `builder` subroles are
  kept).
- **`researchManager`**: the healer tech's affects string is
  `"Healer !Champion !Hero"`; the exact-match filter never matches it.
- **`victoryManager`**: a guard request from `outOfPlan` (plan −1) is always
  refused by `tryAssignMilitaryGuard`.
- **`entityExtend.getMaxStrength`**: a template with no attack returns 0 before
  its armour is counted.
- **`_petrabot`**: `gameFinished` is never set, so its check is dead; a bot
  that cannot play (`canPlay` false) never clears its saved events, and its
  turn counter stops.
- **`baseManager.assignToFoundations`**: `if (target.hasClass("Field"))
  continue` cannot fire (fields are filtered out of the foundations first).
