# Petra TS port — findings from the behaviour-test campaigns

What the test campaigns found while covering `petra_ts/*.ts` and comparing it
with the original `petra/*.js`: bugs, differences between port and original,
behaviour both share that looks unintended, code that cannot run, and the
branches no test reaches yet.

State: branch `petra_behaviour_tests`, 2026-10-24, after the review of the
port-only tests (§9). Line numbers refer to the port's files at that point
unless marked `petra/…js`.
Coverage is the real figure from `npm run coverage:petra` (see README).

| | Port | Original |
|---|---|---|
| Tests | 1529, all pass | 1528, 16 fail (all listed below) |
| Real line coverage | 95.6% | ≈95% |

---

## 1. Bugs in the original that the port fixes

Each is pinned by a test that only the port passes (16 tests in all; the
original fails exactly these). Each row says whether a game can reach it.

| Where | Original behaviour | Port | Test |
|---|---|---|---|
| `diplomacyManager` last-man-standing | uses `filters` without importing it: **ReferenceError** in every wonder or relic game; even with the import, reads a collection's `[0]`, which an EntityCollection never answers | imports and reads correctly | diplomacyManager: wonder game, relic game |
| `victoryManager.captureGaiaRelic` | adds `captureStrength() × bonus` for every unit; a unit that cannot capture gives `undefined` → total **NaN** → every comparison false → the "already enough" exit never fires and the AI sends every nearby capturer each time | skips units with no capture strength | victoryManager: "a ram in a raid strong enough does not make it look weak" |
| `navalManager` waiting passages | sorts with a one-argument comparator, which orders nothing | joins the passage with the fewest units | navalManager: "joins the emptier of two passages" |
| `transportPlan` reloading failed | destroys the unit wherever it stands, though its comment says it keeps it on a land we use | keeps it there and cancels the garrison order | transportPlan: "a unit that could not be taken back aboard…" |
| `baseManager.removeSupply` | guarded by `supply[i].ent`, a field nothing writes: removing one dropsite wipes **every** dropsite's supply book. Reached in **every game**: `basesManager` calls `removeDropsite` for any destroyed entity with `base` metadata, units included, so the first unit lost wipes the base's resource lists; it decides the games against the port (§10) | removes only that dropsite's entries | baseManager: "a storehouse destroyed leaves the other dropsites' books untouched" |
| `garrisonManager` cancel | reads the booking after releasing it, so the ledger strike is dead; the cancelled marcher stays on the holder's list until the next garrison update drops it (one turn of over-counting, plus a debug warning) | reads first, strikes it | garrisonManager: "strikes the cancelled marcher…" |
| `attackPlan` walls | `filters.byClass(["Palisade","Wall"])` never matches an array: walls are never found | `byClasses` | attackPlan: wall-breaking crew (4 tests) |
| `worker` supply check | treats the dropsite UnitAI walks to as an unbooked supply; a woodcutter carrying its load home is idled when every booked tree is crowded | leaves the order alone while UnitAI targets a dropsite | worker: "a woodcutter carrying its load home…" |
| `basesManager` TrainingFinished | dereferences a missing base for a worker whose plan has no ground yet. Practically unreachable: only construction plans use base -1 and bases are never removed | leaves it for next turn | basesManager |
| `queueplanBuilding.buildOverseaDock` | with the last dock builder dead, calls construct on no builder and throws, the plan keeping the dock template | restores the civic-centre plan | queueplanBuilding |
| `worker` gatherer plan lookup | reads `.state` off a missing transport plan. Unreachable: the naval manager clears `transport` before dropping a plan; kept as a guard matching the builder's | guarded as the builder's lookup already is | worker: "a gatherer whose boat is gone…" |
| `attackManager` defenders | reads the unit before its own `if (unit && …)` check | checks first | attackManager: "enlists only joinable defenders" |

## 2. Bugs in the port, fixed (separate commits)

| Where | Port bug | Fix |
|---|---|---|
| `tradeManager.updateTrader` | lost a `!`: merchant ships looked for treasure only while *already* collecting one | `!…startsWith("INDIVIDUAL.COLLECTTREASURE")` |
| `headquarters.getAccountedPopulation`, `queueplanTraining` | used the template's `Cost/Population` string unconverted: units in training did not count | `Number(…)` |
| `researchManager.CostSum` | a tech with no cost got no priority (original: cost 0, cheap) | aligned with the original |
| `mapModule.createObstructionMap` | a template without BuildRestrictions fell back to own/ally/neutral (original: no territory) | aligned with the original (`=== true`) |
| `attackPlan.Abort` | returned at once when the army had no position, i.e. when all its units are aboard ships: an attack aborted at sea (target player defeated, relic raid called off) left its units with `role: attack`/`plan: N` for good, its collections registered and its queues alive | no early return; only the withdrawal rally point needs a position |
| `attackPlan.Deserialize` | threw on a saved target that is not a number (the original restores no target and re-targets) | aligned with the original |
| `attackPlan.update` | aborted the whole attack (and skipped `Engine.ProfileStop`) if `UpdateTarget` left no target or position, which it cannot | `requireValue` |
| `defenseManager.checkEnemyUnits`, `defenseManager.checkEvents`, `headquarters.updateCaptureStrength`, `garrisonManager.update` | turned the original's `!state ||` guards on `unitAIState()` into `requireValue`, but the engine can report no state (AIProxy passes on `UnitAI.GetCurrentState()`). Found by the first in-game match: the throw stopped the HQ update every turn | the original's guards back; `worker.update` now fails at the original's unguarded `.split`, not earlier |

## 3. Remaining differences between port and original

All are harmless or never reached in a game; kept on purpose.

- `tradeManager.updateTrader`: the port only asks a passage when `route.land !== undefined`. A land trader only ever gets routes with a land (`checkRoutes(gs, access)`), so equivalent; the check is needed for the types.
- `_petrabot`: the port keeps the 21 event buckets fixed, so a save also carries `AIMetadata: []`. Loading ignores it.
- `garrisonManager.keepGarrisoned`: answers `false` where the original answers `0` (the holder's heal rate). Callers only test truthiness.
- `attackPlan`: a ranged hunter approaching gets an explicit empty avoid list; the original leaves it undefined. UnitAI checks `targetClasses.avoid &&` first, so both behave alike.
- `queue.check`: the port reads the head before shifting it, the original reads the shift result. Same in a game: no `isInvalid` has side effects.
- `attackPlan.reassignFastUnit`: the port returns when no raid is in preparation; the original would crash, but its only caller requires a raid, so unreachable.
- Many port-added `=== undefined` checks needed by the types (listed under §5).

## 4. Quirks shared by port and original (left as is)

Behaviour that looks unintended but is identical in both; tests pin it where
noted. Worth raising upstream rather than changing in the port alone.

- **`attackPlan.checkTargetObstruction`**: `if (!angle) continue` treats a rotation of exactly 0 as "no angle", so a wall or gate placed square to the map is never seen as blocking. *(pinned)*
- **`attackPlan.reassignFastUnit`**: the class list `["FastMoving", "CitizenSoldier"]` is an any-of, so any infantry citizen soldier is handed to a raid, not only fast units. *(pinned)*
- **`baseManager.pickBuilders`**: any worker without a plan scores −20, which overrides its idle (−50) score: idle villagers are not preferred over busy gatherers when builders are lent. *(pinned)*
- **`_petrabot`**: `gameFinished` is never set anywhere, so its check is dead. A bot that cannot play (`canPlay` false) never clears its saved events, and its turn counter stops advancing.
- **`researchManager`**: the healer tech's affects string is `"Healer !Champion !Hero"`; the exact-match filter misses it.
- **`victoryManager`**: a guard request from `outOfPlan` (plan −1) is always refused by `tryAssignMilitaryGuard`.
- **`entityExtend.getMaxStrength`**: a template with no attack returns 0 before its armour is counted.
- **`baseManager.assignToFoundations`**: `if (target.hasClass("Field")) continue` cannot fire (fields are filtered out of the foundations before the loop).
- **`baseManager`**: a worker already mending one building but still marked as a gatherer can be taken by the next repair (only `builder` subroles are kept).
- **`baseManager.checkResourceLevels`**: the first field is queued only once the base's fruit within reach (nearby, and medium before town phase; animals not counted) falls below 600, whatever the food income. On a fruit-rich map a bot under pressure starves with wood to spare: in a mirror match (§11, seeds 579602995/974380524, savanna) one side kept 1150–3850 fruit in reach all game, so never built a field, while 6–13 units, then none, gathered food; food stayed under 350 from minute 3 and the side was destroyed at 16:39. The code's own TODO names the gap ("add a check on time used/lost").

## 5. Unreachable code

### Methods never called (port and original), marked `TODO never called`
`attackManager`: `pausePlan`, `unpausePlan`, `pauseAllPlans`, `unpauseAllPlans` ·
`queue`: `queueCost` · `queueManager`: `getTotalAccountedResources`, `clear`,
`pauseQueue`, `unpauseQueue`, `pauseAll`, `unpauseAll` · `headquarters`:
`numPotentialBases` · `navalManager`: `addPlan` · `transportPlan`:
`countFreeSlots`, `cancelTransport` (its only caller, in `petra/defenseArmy.js`,
is commented out; so is the `canceled` block in `onSailing`, lines 701–711) ·
`mapModule`: `debugMap`.

### Branches that cannot run
| Module | Lines | Why |
|---|---|---|
| `_petrabot` | 220, 312, 317 | missing `data`/`HQ` guards; the engine always initialises before saving (kept for the types) |
| `startingStrategy` | 178 | `seaIndex` is always set when there is no `landIndex` (kept for the types) |
| `startingStrategy` | 435 | `configFirstBase` is only called with a potential base |
| `startingStrategy` | 367, 388 | a unit already "allied" in the first passes of `dispatchUnits` |
| `entityExtend` | 63–64 | `attackTimes` only ever has `prepare` and `repeat` |
| `entityExtend` | 269 (`: 0`) | a capturable target always has capture points |
| `mapModule` | 112 | a structure without a position |
| `defenseManager` | 996 | `switchToAttack` is never called without an army |
| `garrisonManager` | 54, 208 | lookups right after `has()` / after the list was cleaned |
| `transportPlan` | 84–85 | a transport from a garrisoned ship is always created with the ship |
| `transportPlan` | 227–228, 588 | no plan unit with a position while boarding; an empty landing zone |
| `tradeManager` | 288 | no barterable resource codes |
| `attackPlan` | 134, 137, 155, 176, 179, 189, 712, 972, 977, 1003, 1047, 1090, 1174, 1197, 1211, 1219, 1269, 1453, 1456, 1460, 1478, 1563, 1729, 2005 | positions/accesses that always exist (anchors, structures, targets), and a resigned target already dropped by `UpdateTarget` |
| `attackPlan` | 940 | no raid in `reassignFastUnit` (caller requires one) |

## 6. Debug-only lines (not tested on purpose)

Messages behind `Config.debug > 0/1/2` make up most of what remains in
`transportPlan` (101–103, 118–119, 183–186, 436, 462–463, 608, 614, 622, 661,
673, 757), `startingStrategy` (50, 199–207, 353–354, 455, 495–496),
`tradeManager` (153–154, 181–191, 273, 354–358, 392–394, 588–602, 707–715),
`attackPlan` (579, 798, 805, 815–819, 1433, 2019, 2021, 2120, 2271–2272),
`defenseManager` (407), `basesManager` (127–131), `baseManager` (164–165,
205–207, 225, 451), `garrisonManager` (138–142, 269–271).

## 7. Reachable branches no test reaches yet

Classified where a second pass looked at them; the rest are listed as the tool
reports them and were not reviewed line by line.

### Reviewed (second passes)
- `attackPlan` (95.6%): a field as target in a normal attack (1094); relic games skipping non-relics (1084); swarmed prey deprioritised (1905, 1907); the build-order sort for a full category (742); the siege queue for siege orders (781); the completing step failing to choose a target (664); a unit out of the plan's reach on the exile list (876); a gate preferred in the second sort operand (1957, 1959); helpers that cannot attack the foe (1991); enemy units filtered as animals / on another land (1868–1877); a removeUnit with update (2344).
- `defenseManager` (97.3%): fewer than 8 loose raiders of one enemy in an ally's land (79); the rest is unreachable (§5) or debug (§6).
- `baseManager` (93.8%): parts of `update` when the centre falls (1130–1171: a dropsite handed to another base, units of an empty base re-assigned, 1198–1240 worker updates); a territory cell with no room for a dropsite (413); gatherer switching and idle-worker filters (731, 755, 775–780).
- `tradeManager` (92.2%): markets without positions (519, 527); a farther pair for a water access index (554, 575); a trader that is garrisoned or has no access when its route is checked (650–651).
- `garrisonManager` (95.4%): only unreachable and debug lines remain.
- `transportPlan` (89.4%): only unreachable and debug lines remain.
- `mapModule` (87.9%): only unreachable and debug lines remain.

### Not reviewed line by line
| Module | Coverage | Lines never run |
|---|---|---|
| `headquarters` | 93.7% | 204–206 241 244 359 374 404 460 478 507 606 622 652–653 672 688–689 691 745 747 753 846 848 896 917 935 948 1028 1044 1086 1092 1176 1187–1189 1195 1211 1220 1226 1233 1347 1350 1368 1387 1409 1432 1458 1460 1462 1505 1525 1530 1533 1538 1583 1590 1635 1663 1678–1679 1708 1714 1773 1865 1883 1895 1922 1964 1968 1981 2018 2041 2244 2272 2282 2292 2298 2303 2340 2404–2406 2430 2443 2469 2532–2544. Note: `OnPhaseUp` and `bulkPickWorkers` are called in game (from `queueplanResearch` and `victoryManager`) but every suite stubs them |
| `victoryManager` | 92.4% | 114 198 204 228 253 295 306 311 315 355 390 430 433 443 449 461 472–477 479 486 498 505 520 589 722 724 746 762 772–774 776 780 791 |
| `basesManager` | 93.1% | 86 111–112 118 167 179 183 202 213 260 279 282 285 296 308 361 370 373 395 578 604 692 695 725 730 |
| `worker` | 96.8% | 75 84 87 158 174 413 416–418 420–422 527 786 838 846 908 933 950 1015 1060 1063 1091 |
| `queueplanBuilding` | 96.4% | 119–121 270 433 435–437 513 533 625 672 679 708 726 731 738 742 758 761 768 850 915 |
| `navalManager` | 97.0% | 313–314 369 371 389–390 421 433 437–439 479 598 638 662 698 744 894 |
| `diplomacyManager` | 95.6% | 161 172 181 198 207–208 267 310 313–314 344–345 412 522 590 |
| `defenseArmy` | 97.4% | 129 256 258 309 322 464 495 554 586 632 |
| `queueplanTraining` | 95.3% | 77 103 110 125 146 148 |
| `attackManager` | 98.9% | 189 227 261 570 602 745 |
| `startingStrategy` | 94.7% | 297 (a worker garrisoned in a holder without position); the rest is §5/§6 |
| `buildManager`, `chatHelper`, `queueManager`, `queueplanResearch`, `researchManager` | ≥98.8% | 81 · 220 · 352 · 70 · 238 |

## 8. Test and harness defects found and fixed

Tests that passed without exercising what they named:
- defenseManager "extends the watch radius for an archer…": the archer had only a melee attack and stood close enough for anyone.
- defenseManager "keeps the army one of our oversea docks watches": the raid was inside the civil centre's own watch, so the dock was never consulted.
- garrisonManager "keeps every soldier lodged while a raider stands at the gate": the grazing animal came after the raider, where the patrol had already stopped.
- attackPlan "picks up role-free attackers and exiled units": the exile had no role, so the role-free pass took it and the exile list was never reached.

Harness answers that differed from the common-api:
- `makeTemplate.resistanceStrengths` returned a flat map instead of `{ Damage: {…} }`: armour was never weighed for test templates.
- the attack world's `getEnemyStructures()` without an owner returned our own buildings too.
- the HQ world's `getEnemyStructures(owner)` ignored `owner`; `getOwnEntities`/`getOwnEntitiesByClass` left out units.
- the attack world's `getOwnUnits()`/`getOwnStructures()` had no class filter, so `.filter(byMetadata(…))` collections let a dock into a base's `units`. The original then threw in the baseless pool's units loop ("a dock built outside any town…"), which a game cannot do. With the filters that test passes on both.

## 9. Review of the port-only tests (2026-10-24)

Of the 24 tests the original used to fail, eight pinned port guards a game
cannot reach, or a port bug:

- removed, the port's guard replaced by `requireValue`: `getPathToTarget` with no target, `update` with no target position, the launch chat with no target player (`StartAttack` succeeding guarantees one), the baseless pool's units loop;
- removed: `queue.check` on a queue that empties itself (equivalent, see §3), `Deserialize` refusing a bogus target (now aligned with the original);
- rewritten: "keeps the queues if the plan has never moved" pinned the `Abort` regression (§2); it is now "releases an army aboard ships, with no place to withdraw to". `getAttackAccess` with no position returns 0 like the original, tested with an army all aboard;
- made target-neutral: the ranged hunter's avoid list (§3); the dock outside any town (§8).

One test was added: the `captureGaiaRelic` NaN (§1), which had none.

## 10. In-game matches (2026-10-25)

Ten headless conquest matches of Petra TS against the original (`match.sh -n
-t`, random seeds, slots swapped every other match, mainland, very hard,
Athenians), commit 70827cf769:

- The port won 9 of 10; no script error or warning in any. The port reached
  town phase at minutes 13–31 and mined metal; units idle 2–17% on average.
- In each of the 9 losses the original never reached town phase and gathered
  no metal: workers stay idle for good (21–35% on average), wood stops, food
  piles up. A mirror match of the original against itself on the same seed was
  still in village phase at game minute 1899, both sides with millions of food.
- Cause: the `removeSupply` bug (§1). A mirror of the port against itself
  played the same game as the original's mirror until 5:08 (the first units
  killed); with only the port's `removeSupply` put into the original, the
  original's commands were identical to the port's for the whole run compared
  (10313 commands, logged by wrapping `g_Commands` in a trigger script).
- The port's one loss was an ordinary defeat: its army and citizen-soldier
  workers died in the fight of minutes 9–13, leaving 16 food, too little to
  train a unit, and pop 0 until the end.

So a match against the original does not show whether the port plays like it:
a fair comparison needs an opponent with that one fix.

## 11. Mirror matches of the port (2026-10-25)

Ten headless conquest matches of Petra TS against itself (`match.sh -n -t`,
random seeds, mainland, very hard, Athenians), commit 783f74f194:

- Each slot won 5; no script error or warning in any. Games were decided at
  16:39–46:20. Winners reached town phase at minutes 13–19 and city phase at
  19–29; six reached the 300 population cap.
- A side that falls behind early often never reaches town phase: the bot
  phases up only at `popPhase2` (150 here) accounted population, so losses
  keep it in village phase, with food and wood piling up. Same rule in the
  original.
- Neither side gathers metal before town phase: nothing an Athenian trains in
  village phase costs metal, and gatherers follow the queued costs.
- The one early loss (16:39) is the field rule in §4.
- Idle units peak at 38–54% of a side's units, just before its population
  drops: counted by class (`timeline.txt` "idle"), they are soldiers (up to
  110 idle soldiers, at most 3 idle women), an army waiting to set off, not
  workers without a task.
- Winners at the population cap bank resources (one held 9.3k food and 18k
  wood at pop 299) while their metal stays near 100.
