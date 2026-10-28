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
| Tests | 1548, all pass | no target since stage 3; when last run, 1537, 20 fail (all listed below) |
| Real line coverage | 95.6% | ≈95% |

---

## 1. Bugs in the original that the port fixes

Each is pinned by a test that only the port passes (36 tests in all; the
original failed exactly the first 20 when last run, the seven stage-4 rows
and the stage-5 ones were fixed after the original stopped being a test
target). Each row says
whether a game can reach it.

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
| `basesManager.createBase` reusing a ground | calls `newbase.reset(type)` for the signature `reset(gameState, state)`, so the state is always undefined: a ground that lost its centre and gets a new one is never `constructing` (no builders called to a rebuilt centre) and its `neededDefenders` is 0 (no guard for a captured centre; 7 at very hard). Reached in games with a centre lost and replaced (§14) | passes the state | basesManager: "a town that lost its centre guards a centre it captures…" |
| `defenseArmy` foe ledger | `removeFoe` and a foe's rename leave the foe's `assignedAgainst` row as `undefined`; a merge then appends that `undefined` to the other army's row for the same foe (`concat(undefined)`), so the foe looks fought by one defender more and `assignUnit` passes him over (§14) | deletes the row | defenseArmy: "counts only real defenders against a raider the merged army had let go" |
| `attackPlan.Deserialize` (stage 2) | restores any saved string as the state: a started plan in a state `update()` does not know does nothing more | parses the tag; an unknown one sends the plan back to preparation, with a warning | attackPlan: "prepares again when its save names no state it knows" |
| `queueManager.changePriority` | sorts `queueArrays` in place, while `startNextItems` walks it: a started plan resetting its queue's priority (`queueToReset`) reorders the array mid-loop, so a queue is skipped that turn and another visited twice. Reached in most games, from minute 3 on (§14) | sorts into a new array | queueManager: "visits every queue once in a turn…" |
| `attackPlan.checkTargetObstruction` (stage 4) | `if (!angle) continue` reads a rotation of exactly 0 as "no angle": a wall or gate set square to the map never blocks | skips only an undefined angle | attackPlan: "a wall or a gate standing square to the map (rotation 0) blocks too" |
| `attackPlan.reassignFastUnit` (stage 4) | the class list `["FastMoving", "CitizenSoldier"]` is an any-of: any citizen soldier, fast or not, or a fast champion, is handed to a raid | `"FastMoving+CitizenSoldier"` | attackPlan: "a unit boarding a ship, a foot soldier and a fast champion stay…" |
| `baseManager.pickBuilders` (stage 4) | every worker without a plan scores −20, overriding its idle (−50) and builder (100) scores: idle hands are not lent first, and the town's own builders can be | one score: builder, idle, no plan, plan | baseManager: "a neighbour borrows idle hands first, never a builder" |
| `worker` builders (stage 4) | a builder carrying resources is sent "return resources, then repair (queued)", and while it walks home it is sent the pair again at every update: 37 times in two minutes for one worker in a mirror match | leaves it alone while it returns resources with the building in its queue | worker: "a builder walking its load home with the building queued…" |
| `researchManager` (stage 4) | the filter of techs for units the AI does not use matches the class list exactly, so `cost_healer` (`"Healer !Champion !Hero"`) is researched | reads the list's first class | researchManager: "from the third phase, any other tech may be researched…" |
| `victoryManager.tryAssignMilitaryGuard` (stage 4) | refuses any unit with a plan, so the units out of any plan (−1) it is offered from the attack manager's `outOfPlan` are never taken | takes a unit of plan −1 | victoryManager: "guards are drawn from the champions first, then units out of any plan…" |
| `attackPlan.updatePreparation` at the population cap (stage 4) | aborts a plan that cannot start yet "so that its units serve other plans"; the attack manager creates the next one at once, which takes the same reserve back and is aborted in turn: 124 plans aborted within 30 s of creation in 200 games, 81 in one (§16) | the plan waits, gathering units as below the cap | attackPlan: "waits when the population is full…", "waits with its few units…" |
| every read of a unit's orders (stage 5) | reads `order.target` off `Entity.unitAIOrderData()`, which since the engine's commit 4b516b336e returns UnitAI's orders (`{type, data}`), not their data: every check of what a unit targets fails (the workers' hunting and supply checks, the defense and attack target checks, garrisons, captures), and `Entity.currentGatherRate()` gives 0, so the town's gather-rate estimate is empty and the gatherer split follows the queues alone (§18). Every game | `adapter/orders.ts`: `ordersOf` reads the data, `gatherRate` replaces `currentGatherRate`; the declared shape is the engine's | baseManager: "a gatherer on the wood adds its rate, ..."; orders.test.ts |
| `baseManager.checkResourceLevels` first field (stage 5) | queues the first field only once the berries within reach fall below 600 food, however far its gatherers walk for them: by minutes 6-8 they gather 45% of the time on trips of 128, about 0.4 food a second against a field's 0.54 (§20) | also as soon as a gatherer brings in less at the berries than at a field, measured (`decision/foodSource.ts`); one more field at a time while that lasts | baseManager: "a town whose berries bring in less than a field plants one, ..." |
| `headquarters.buildMoreHouses` (stage 5) | short of 5 places, doubles the house queue's priority to 500, still below the citizen soldiers' 600, which keep the wood: half the games stand at the population limit at minute 3 (§22) | the house queue goes before the training queues | headquarters: "a tight census with room to build puts the house queue before the training queues" |
| `queueManager` funding (stage 5) | splits each resource between every queue that wants it, so that often none can start: 424 food in stock and three queues holding 105, 117 and 182 of the 150, 150 and 200 they need; its compaction (`switchResource`) runs only when not a unit is left unbooked (§24) | each turn, the first plan of the highest-priority queue that the free resources and the lower queues' accounts can pay in full is paid and starts (`completeBestPlan`) | queueManager: "starts the best plan its stock can pay for when every queue holds a part of it" |
| `config.priorities` (stage 5) | the women's queue at 300, below the citizen soldiers' 600 "to not get all the food": with the best plan paid first (§24) the soldiers took the food and the civic centre stood idle 43% of minutes 3-6 (§25) | the women's queue at 650, above the soldiers' | queueManager: "pays the women before the soldiers when the food covers one of them" |
| `config.Economy.supportRatio` (stage 5) | 0.3 at the hard difficulties: at most 45 women of a 150-worker target, about 21 at 40 workers, and from minute 6 no woman queued while the civic centre waited on the soldiers' food (§26) | 0.5: at most 75 | headquarters: "a fresh town: sixteen supports stand below the peaceful share" |
| `researchManager.update` economy techs (stage 5) | queued the economy techs at the research queue's priority (250), below the women's, the soldiers', the houses' and the fields', one at a time: a capacity tech waited unpaid from minute 5 to 15 and the plough came at minute 11.6 with 26-40 women on the fields since minute 4 (§28) | a tech that pays back within 240 s from the income it adds, measured, goes just above the women's queue and takes the place of a plan waiting there (`decision/economyScore.ts`) | researchManager: "twenty-six farmers: the plough goes before the women" |
| `headquarters.constructTrainingBuildings` (stage 5) | builds the barracks, ranges and stables by population thresholds, about three in all, while from minute 10 the barracks train 90% of the time and 2000-3000 resources lie in stock (§29) | one more barracks (or range) while those it has train 85% of the time, measured (`world/production.ts`), and the unbooked stock covers two of them, up to five | headquarters: "barracks always training and the stock unbooked: one more barracks" |

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

- **`queueplanBuilding.findDockPosition`**: `if (angle == false) continue` also rejects an angle of exactly 0, which `getDockAngle` returns when the water's centre lies in the first direction it samples: a dock square to the map there is not placed. Kept, spelled `angle === false || angle === 0`, by the `===` pass (`PLAN.md` 3.5).
- **`_petrabot`**: `gameFinished` is never set anywhere, so its check is dead. A bot that cannot play (`canPlay` false) never clears its saved events, and its turn counter stops advancing.
- **`entityExtend.getMaxStrength`**: a template with no attack returns 0 before its armour is counted.
- **`baseManager.assignToFoundations`**: `if (target.hasClass("Field")) continue` cannot fire (fields are filtered out of the foundations before the loop).
- **`baseManager`**: a worker already mending one building but still marked as a gatherer can be taken by the next repair (only `builder` subroles are kept).
- **`defenseManager.checkEvents`**: a structure it gives up (capture ratio between 0.5 and 0.7 where it cannot be defended) is destroyed once per `Attacked` event on it that turn: 69 `delete-entities` for one tower in one turn in a mirror match. Harmless, the engine deletes it once.
- **`attackPlan.Abort` withdrawal**: fixed in stage 4, §16.
- **`baseManager.checkResourceLevels`**: the first field is queued only once the base's fruit within reach (nearby, and medium before town phase; animals not counted) falls below 600, whatever the food income. The code's own TODO names the gap ("add a check on time used/lost"). The game once blamed on it was lost to an early fight (§16).

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

## 12. Mirror matches with the bot's state (2026-10-25)

Ten headless mirror matches with `match.sh -n -t -l -b -T` (random seeds,
mainland, very hard, Athenians), commit 81cd87039a, checked with
`match-checks.ts`:

- Each slot won 5; decided at 21:00–54:29; no script error or warning; no
  order refused beyond a handful.
- Three checks fired, none on a port bug, and were refined: a beaten side
  with 2 units and no resources issues no command (silence now needs 5
  units); 6 idle women in one snapshot between tasks (now two snapshots in a
  row); a base whose surroundings were gathered out after 45 minutes (its
  wood fell 18295 → 3022 → 288 → 0; that check, on the bot's state, was then
  dropped: the checks read only what the engine records, as the bot's
  internal structure changes with its code).
- The longest game shows the `Abort` withdrawal in §4: about 140 of the
  winner's units walked for the last 12 minutes, booked as idle workers.
- On the losing side an attack plan often keeps 0 units for 18–38 minutes
  while its queue trains for it: under attack, the trained units go to the
  defence (inferred, not traced). The winners' attacks fill to 89–104 units
  and leave within about 8 minutes.

## 13. Baseline batches, stage 0 (2026-10-25)

Three batches of `build/petra_ts/batch.ts` (mainland, very hard, Athenians,
conquest, `-T`; 12 games at a time; each 100 games plus 5 played twice),
with the baselines built from the tag `petra-ts-parity` (bfa183db2c):
`petra_parity` against itself (pool seed 101), `petra_fixed` against itself
(202), and the two against each other from both slots (50 seed pairs, 303).

- **Parallel runs are isolated.** 315 games, no replay outside its job's
  folder, no script error or warning, and all 15 games played twice gave the
  same fingerprint as their first run. A job's own `XDG_*` folders are enough
  (the engine writes only its data, config, cache and log paths,
  `source/ps/GameSetup/Paths.cpp`); `-writableRoot` is not needed. About 50–60 s
  of wall time per game at 12 at a time, so roughly 100 games in 8 minutes.
- **The engine crashes now and then.** Two runs (parity mirror game 13 at 14
  game minutes; parity vs fixed game 54 at 0:44) aborted with glibc's "The
  futex facility returned an unexpected error code" (exit status 134).
  Replayed, both played to a normal end, so this is not the seeds or the bots.
  It looks like a race in the engine's threads. `batch.ts` now books such a
  run as failed (a non-zero exit, or no decision under `-T`) and plays it
  again when the batch is resumed. Not investigated in the engine.
- **`petra_parity` against `petra_fixed`: no difference.** 53 wins to 51 and
  1 time-limit draw: 51.0% (95% CI 41.5–60.4%); the SPRT is undecided either
  way. In 44 of the 50 seed pairs the two games have the same fingerprint:
  with the slots swapped it is the same game, so the two bots played
  identically. The 6 other pairs (seeds 314615891/911175050,
  591600344/948856854, 647912326/610466440, 760686401/577555306,
  583398897/647901068, 65374167/823491457) differ, though player 1 still
  won or held out in each. They are where stage 1 (the parity proof, a diff
  of the command logs) starts. All six come from three bugs of the original
  the port fixes (§14).
- **Player 2 wins more mirror games.** Player 1 won 42 of 103 decided parity
  mirrors and 44 of 101 fixed ones: 86 of 204, 42.2% (95% CI 35.6–49.0%).
  The batch with slots swapped balances this out; a batch with one slot per
  seed must not compare two bots from fixed slots. The cause is unknown
  (candidates: the map's player placement; Petra's HQ update, which runs one
  turn in eight with an offset by player id).
- Games last 15:29–88:22 (median about 28 minutes). 7 of 315 reached the
  90-minute limit.

## 14. Parity proof, stage 1 (2026-10-25)

Tools: `command-diff.ts` (where two command logs part; for a batch with both
slots, each seed pair: with two bots that play alike the swapped game is the
same game, so the logs must match line for line) and `parity-bisect.ts`
(hybrid bots, `baselines.ts hybrid`: `petra_fixed` with one module taken from
the port, each played on the seeds; the module whose hybrid plays on as
`petra_parity` does holds the difference).

- The six diverging pairs of §13, replayed with `-l`, parted at 3:43, 8:39,
  20:34, 21:48, 23:51 and 32:45. Three causes, each a bug of the original that
  the port fixed when it was written, without a note until now (§1):
  - `queueManager` (3:43, 8:39, 20:34): `changePriority` re-sorts the array
    `startNextItems` is walking. At 3:43 the original skipped a funded field
    plan; the port started it.
  - `defenseArmy` (21:48): a merge appends `undefined` to a foe's defender
    list, and a defender attacked a different raider.
  - `basesManager` (23:51, 32:45, and 30:29 behind the `queueManager` one):
    `reset(type)` for `reset(gameState, state)`, so a captured or rebuilt
    centre got no defenders and no builders; the port stopped a batch of
    workers to guard its captured centre.
- With the three fixes added to `upstream/petra-fixes.patch` (now 15 fixes),
  `petra_fixed` and `petra_parity` gave the same command log, line for line,
  in all 26 seed pairs played: the six above and 20 fresh ones (pool seed
  606), 52 games, about 290,000 commands
  (`batches/stage1-parity-proof`). On these seeds the port plays exactly as
  the patched original.
- Bisecting is cheaper with `match.sh -L MIN` (the time limit at minute MIN,
  `-autostart-timelimit`): the hybrids stop two game minutes past the
  divergence (about 1.5 minutes per bisect instead of 4).

## 15. Layers, stage 3 so far (2026-10-25)

- **Unit state.** `adapter/unitState.ts` holds the 76 states of UnitAI's state
  machine, read from `UnitAI.js` itself (every key of `FSM.states` for
  `UnitFsmSpec`); the 24 string comparisons of `unitAIState()` became
  `isInState`, `hasActivity`, `stateIs`, each name checked by the compiler.
  The five sites that relied on a unit having a state (`requireValue(...).split`)
  keep their throw (`requiredActivityIs`, `requiredStateWithin`,
  `requireStateName`). The first run of the new module's tests found it
  throwing at load (a table built before the one it reads), which neither the
  typecheck nor a build would have shown: the bot's first turn would have
  failed.
- **The worker maintains the world model as it reads it.** Typed against a
  read-only view of its bases (`world/bases.ts`), the worker compiled except in
  one place: `findSupply` drops a supply whose entity is gone from the base's
  list, mid-search, as it walks it. That is now the base's own
  `forgetSupplyAt`, called at the same point; the worker otherwise only reads
  the lists, books supplies and hands back idle workers.
- **The attack plan wrote into the victory manager.** It set its relic raid in
  `victoryManager.targetedGaiaRelics` itself; the map is now private to the
  victory manager, changed through `planRelicRaid` and read through
  `isRelicRaided`.
- **The execution layer set the HQ's state in four places**: a phase research
  plan reset `HQ.phasing` before calling `OnPhaseUp`, a construction plan set
  `turnCache.buildingBuilt`, a worker recorded `lastFailedGather` and filled
  the per-turn `allowDistantFood` cache itself (the last one surfaced only
  under the read-only view). They are the HQ's methods now
  (`phaseResearched`, `markBuildingStarted`, `noteNothingToGather`,
  `allowsDistantFood`), and execution code reaches the HQ only through
  `hqOf` (`execution/hq.ts`), a read-only view of the 39 members it uses.
  Beyond the worker's capabilities, execution code only reads bases.
- **World state moved out of the managers.** The territory and border maps
  and the land/sea regions are `world/geography.ts`, owned by the HQ; the
  supplies within reach of each base's dropsites, and their upkeep
  (`addDropsite`, `removeDropsite`, `getResourceLevel`, `forgetSupplyAt`), are
  `world/baseResources.ts`, owned by each base. The owners keep accessors
  with the old names. Two details kept the game the same: a dropsite listed
  already still returns before `getLandAccess` (which caches the land in the
  entity's metadata), so the model is told whether the base is the baseless
  pool rather than asking first; and a base read back from a save without
  `init` (only in tests) now has empty lists rather than none.
- **Turn time.** Measured by the engine (`match.sh -P`). Stage 2's bot over 20
  mirror games: the whole turn 1.96 ms on average, 12.5 ms at the 99th
  percentile, 68 at the 99.9th, 351 at worst, growing with the game. Stage 3's
  bot against `petra_parity` (20 games, the same games from both slots): ratios
  1.002, 0.994 and 1.001 for the mean and the 99th and 99.9th percentiles.
  The budget check caught one regression: with the moved world state read
  through accessors of the old names, the mean rose 5.2% and the 90th
  percentile 9.6% (`territoryMap` is read about 90 times, often per unit);
  reading the world objects directly brought them to 1.007 and 1.011.

## 16. Stage 4: the known weaknesses (2026-10-26)

First ranked by what each costs in games and how often it fires: the
withdrawal (every finished attack), the first field, idle workers in a
gathered-out base, the town-phase population, attacks that never fill. The
replays below moved the first field down and the idle workers and the
attacks up (`PLAN.md` §6).

- **The withdrawal into the anchor's footprint** (was §4). A finished attack
  sent every unit to within 15 of its rally point, or of a nearer base's
  anchor, whose position is the centre of its building: a civic centre
  reaches 21 from its centre, so the whole ring lay inside the building. In
  the mirror match of §12 (seeds 981901659/728914300), replayed with `-t -b`:
  138-156 of the winner's units in UnitAI `WALKING` from minute 43 to the end
  (54:29). Now an anchor's ring reaches 15 past its obstruction radius, as the
  hero's retreat in `victoryManager` already did: on the same seeds the
  walkers fall to 13 at minute 43 and the army stands at its base. The match
  check "no march goes on for good" (50 units walking in three snapshots in a
  row; never more than one snapshot in the 35 recorded games) fails on the
  old game and passes on the new.
- What that shows next: the 140-150 withdrawn units then stand idle for good
  in their base (base 2), whose supplies are all gathered out, while base 3
  still has 2762 wood and 1927 stone within reach: the idle-worker weakness.
  And the next HugeAttack is created and dropped about 37 times a minute
  (its number climbs from 52 to 415 in ten minutes, 0 units each time): the
  attack-filling one. With the walkers home the game went to the 90-minute
  limit instead of ending at 54:29; one game decides nothing.
- **The first field was not what lost §11's early game.** Replayed (seeds
  579602995/974380524, savanna) with `-b`: by minute 7 the two sides had
  fought near their bases, player 1 losing 38 units (20 women) and player 2
  21 (the statistics' `unitsLost` and `enemyUnitsKilled` agree), with no
  attack plan on either side; player 1's food stock was 300+ until minute 9.
  It never built a field, keeping 1155-3184 fruit within reach, but by then it
  was 14 units against 61. The rule may still cost games where food income is
  the limit; that needs a game showing it before the rule changes.
- **Mercenaries booked as workers** (the idle workers of the first point).
  The 140-150 idle "workers" were Athens' Cretan archers
  (`infantry_archer_a`): mercenaries keep the `Worker` and `CitizenSoldier`
  classes, but `mixins/mercenary.xml` disables their `ResourceGatherer`, so
  `reassignIdleWorkers` never finds them a resource and they stand idle for
  good (seen in the dump: `isGatherer` false, no `gather-type`, UnitAI IDLE).
  They got the role in four places that decide by class: `trainMoreWorkers`
  hired the strongest ranged citizen soldier as a worker, paying metal for
  it; `assignRolelessUnits`; a unit leaving an attack (`removeUnit`); a unit
  taken over (`OwnershipChanged`); and an attack trained a citizen-soldier
  template as a worker. The bot already meant workers to gather: a promoted
  worker that can no longer gather loses its role (`basesManager`
  `EntityRenamed`), only for `assignRolelessUnits` to give it back. Now each
  of those requires the unit (or template) to gather, and `trainMoreWorkers`
  asks `findBestTrainableUnit` for gatherers only; a mercenary is left
  roleless, for the armies. On §12's seeds: no idle worker until minute 29
  (2-3 after), against 140-175 from minute 43 before, and the game decided
  at 36:31 (54:29 before the fixes, 90:00 with the withdrawal fixed alone).
- **Attacks that never end, holding up every later one.** In the integration
  match (seeds 287591089/941505347) with the mercenaries fixed, two started
  attacks kept 2 and 18 units for 20-35 minutes, units inside our own
  defense tower and fortress, with their plan still on them and the garrison
  manager keeping them in as "protection" (its default for a unit it finds
  in a holder with no `garrisonType`). An attack plan waits while its army
  has no position (meant for an army aboard ships), and the attack manager
  plans no new default or huge attack while two are started, so the side
  that had won the field (red down to 3-50 units) stopped attacking and
  training soldiers, banked 171k food and ran to the time limit. One way in:
  the HQ sets a building's rally point to garrison from the first batch in
  its queue (`TrainingStarted`), so an attack's batch queued behind an
  emergency one walks into the building. Now a started attack lets go of
  every unit inside one of our buildings on land that is not transporting
  (`plan` -1, free for the next attack once it comes out), and a plan left
  with nobody on the map ends. The integration match is decided again, at
  44:01, every check passing.
- **Measured: 51.0% against `petra_parity`** with the withdrawal, the
  mercenaries and the stuck attacks fixed (batch `stage4-a`: 100 seed pairs
  from both slots, mainland, athen, very hard; 194 decided, 2 draws, 3
  engine aborts, 1 unplayed; 95% CI 44.0-58.0%, SPRT undecided). The economy
  is clearly better (14.5% more resources gathered, peak map control 50%
  against 44%), the fights a little worse (value lost 30849 against 28300).
  92 of the 96 seed pairs played from both slots are split: the same slot
  won both games, whichever bot sat in it.
- **What the batch says decides games: the first big fight.** In 139 of the
  196 decided games the loser never reached town phase; every winner did
  (median minute 17). Those losers peaked at a median 69 units (never above
  135) around minute 11 and were down to a median 15 when the winner phased
  up: they lost a fight at minutes 10-15, not the race to `popPhase2` (150).
  The 53 sides short of food (under 100 for three snapshots between minutes 5
  and 20) all lost, but most had 6-12 fields by minute 15: starving after the
  fight, not for want of a field. So the town-phase population and the first
  field are not what loses these games; the early fight is, and it is
  decided by the start rather than by the bot.
- **The first fight is a border skirmish, and the same code fights it on
  both sides.** Replayed (game 5 of `stage4-a`): from 0:44 two of player 1's
  units attack one of player 2's near the border, the defense managers feed
  the fight, and by minute 11 player 2 has lost 55 units to player 1's 28
  (no attack plan launched by either). Both bots play the same opening
  (games of a seed pair with the slots swapped have the same trajectories
  until minute 11 or so), so the start position decides, which is why the
  pairs split. With all four fixes (batch `stage4-b-control`, the same pool):
  50.3% against `petra_parity` (CI 43.2-57.3%), 90 of 93 pairs split.
- **An earlier army is a small lever at most.** Training citizen soldiers
  sooner (the support share's `alpha` 0.85 to 0.6, 0.7 to 0.5 with a rush
  planned; batch `stage4-c-alpha06`, 500 pairs from both slots): 52.2% (CI
  49.1-55.3%), 95 pairs won from both slots against 74, the SPRT undecided
  (its first 200 games read 53.8%, the first 500 53.6%). Reverted: a gain of
  2 points is not shown, and tuning is stage 5's.
- **Two game errors in 1000 games, neither in Petra TS:** "too much
  recursion" in `MatchesClassList` (globalscripts/Templates.js) from
  `petra_parity`'s `defenseManager.checkEnemyUnits`, and `cmpResourceGatherer
  is null` in UnitAI's gather state (UnitAI.js 2920), a unit without a
  gatherer entering it, as a gatherer promoted into a champion would.

- **Calling back workers that chase a fight into enemy land does not help.**
  In control game 9 (seeds 524146979/819546117) player 1 stayed at 120 of
  300 population for 40 minutes, losing 1282 units by minute 65, a few
  gatherers in each snapshot chasing foes into the enemy's towers
  (`COMBAT.APPROACHING` in enemy territory). A rule in `worker.update`
  sending them back to work (as a hunter drawn into enemy land already is)
  won that game with 292 lost, but the batch (`stage4-d-recall`, the same
  pool) read 47.7% (CI 40.7-54.7%) against the control's 50.3%, and the
  opponent gathered 11% more (75.7k against 68.1k): the chases cost the
  enemy's economy more than they cost ours. Reverted, as was the defensive
  stance for workers tried before it (it lost game 9 at 26:24).
- **The six small fixes of §1 (stage 4) change nothing measurable.** With
  them (batch `stage4-e-small`, the same pool): 50.5% (CI 43.5-57.5%), no
  game error or warning, 93 of 96 pairs split. The economy lead is smaller
  than the control's (72.8k gathered against 69.5k, +5%, against +12%);
  one batch does not tell that from noise. They are kept as bug fixes, not
  as strength.

- **The attack plans' lives, measured** (bot-state.js logs each plan's
  creation, start, abort and end, with a snapshot every minute; attack-log.ts
  reads a batch; batch `stage4-f-attacklog`, the pool above, which played the
  same 196 games as `stage4-e-small` game for game: the log changes nothing).
  789 plans in 200 sides. Two things the plan named are not what they looked
  like:
  - **Churn at the population cap.** 124 plans, nearly all huge attacks, were
    aborted within 30 s of creation, in 25 sides, every one a game Petra TS
    won, from a median minute 30: a winner at 300 population whose reserve was
    under the 16 units a plan needs there. The cap rule aborted the plan to free
    its units; the next plan took them back (§1). Fixed (the plan waits):
    churn 124 to 29, huge attacks started 62 to 74, the same 200 games
    otherwise; 22 games moved, all wins: 21 still won, ending 13.6 minutes
    sooner in all (game 27: 48 to 43, game 52: 45 to 42), one won at 86.8
    reached the time limit (batch `stage4-h-capwait`: 50.3%, as before).
    The rest is another loop, also of winners near the end: a huge attack
    takes the reserve (about 110 units), finds no target to start on, aborts,
    and the next does the same every attack-manager turn until a target turns
    up (10 sides; game 72 had 20). Left for stage 5 (target choice).
  - **Attacks that never fill** (78 plans prepared over 10 minutes without
    starting) are a side that already lost: at their last snapshot a median
    1 worker, 299 free population, queues paused (99%) because workers are
    short. A symptom, nothing to fix in the plan.
- **What decides the games, from the logs and the replays' statistics** (the
  95 seed pairs Petra TS won from one slot and lost from the other, the same
  map, the slots swapped):
  - The two games are the same until minute 6. The side that will win is
    ahead in units trained from minute 7 (50 against 46; 59 against 55 at 8),
    before anyone fights.
  - Wood leads: ahead in 58 of 95 pairs at minute 2, 65 at minute 7 (4363
    against 3664). Not a slower woodcutter (wood per woodcutter is the same)
    but fewer of them (18 against 16 at minute 7): the losing slot puts more
    on food (17 against 14 gatherers at minute 5) because its food comes
    slower (27.5 against 31.1 per gatherer-minute). The bases' supply lists
    (counts and amounts per distance class) do not tell the two starts apart:
    the layout does (where the berries, the hunt and the farmstead are).
  - The first losses come at minutes 8.5-9, about even (22 against 25 units
    by minute 10); the side behind then trains less (77 against 87 at 10),
    loses its civilians (20 against 2 by minute 14) and never launches an
    attack in half the losses (50 of 95): its rush, the same 20 units as the
    winner's at minute 8, falls to 4 by minute 11 and waits until the end.
  - So the game is decided by a production lead of a few units at minutes 7-8,
    from where the food and wood are, amplified by the first fight: the
    economy of minutes 2-8 and the first fight (when to fight, when to stay
    under the town's arrows) are where stage 5 can win games.
- **The engine can deadlock**, rarely and not reproducibly: one game of 200
  stopped at turn 4030 with every thread waiting on a lock (main and task
  workers); played again it ran to the end with the same fingerprint as in an
  earlier batch. batch.ts now kills a game after 15 minutes of wall time
  (`--game-timeout`), so a resumed batch, and the smoke test, play it again.
  Stage 5 met it three times in about 1500 games, in two forms: every thread
  waiting, no CPU used (the deadlock, twice), and once the main thread
  spinning a core for 15 minutes while holding the process's memory lock, so
  that reading its `/proc/<pid>/cmdline` (and `ps`) blocked; the timeout's
  SIGKILL then left it in state D for a while before it went. Look for a hung
  game in `/proc/<pid>/stat` (the engine's main thread is named `main`; field
  14+15 is its CPU time), never with `ps` while one may hold its lock.
  `match.sh` now does that itself, for every match: its watchdog kills an
  engine whose CPU time has not moved for 60 s, or that has run past its
  wall-time limit (10 minutes headless), and goes on to its report (tested by
  freezing the engine with SIGSTOP: killed 14 s after its CPU time stopped).
- **A quirk of the game's statistics**: the replays' `sequences` record
  `total` as 0 for units lost and killed; the `Unit` class holds all units.

## 17. Type review (2026-10-26)

A scan of the port's syntax trees and, for inferred types, its type checker
(`as`, `!`, `any`, private common-api fields, untyped saves), during stage
4. Every change below kept the integration match's fingerprint
(`f11c19c0cbb8ab10`) and both test targets green.

- **Done.**
  - **Casts and `!`.** The three `!` became `requireValue`. The diplomacy
    events were cast to local copies of their types: the engine's events
    are typed now (`TributeExchanged` from `Player.js`; `TributeRequest`
    and `DiplomacyRequest` are the other AI's command). A diplomacy request
    for a stance other than ally or neutral is ignored (the one behaviour
    change, with a test).
  - **Saves.** Six managers and `DefenseArmy` loaded saves with
    `this[key as keyof this] = ...`: each has a `Serialized*` type
    (`Pick` of its fields) and assigns field by field; `Config` saves as
    `SerializedConfig`.
  - **`requireValue`** throws on `null` as well as `undefined`; seven
    lookups that cannot miss use it or `requireTemplate` (a foundation's
    built template, a batch in training, `findBestTrainableUnit`'s pick).
    The lists of what a building trains are not among them: the AI splits
    the raw template string with its own civ, so a captured building lists
    units its civ lacks (the engine's own list, `Trainer.js`, filters them).
  - **`TerritoryMap`** is a subclass of `InfoMap`, no longer a cast object
    with functions attached; the grid's data is typed per kind (territory
    `Uint8Array`, passability `Uint16Array`, as `CCmpAIManager` has them).
  - **Private fields.** `researchManager` read `_template` because
    `findAvailableTech` was declared to return entity templates; it returns
    technologies, whose accessors it uses now. The HQ's `_entity.trainingQueue`
    is `trainingQueue()`.
  - **`TechName`.** `getTemplate` has an overload per name brand;
    `QueuePlan<T>` holds a `CommonTemplate` (training, building) or a
    `CommonTechnology` (research), each subclass looking its template up.
    `ResearchPlan`'s `researchTime === undefined` guard could never fire (both
    wrappers have the method; its test passed on a fake without it) and is
    gone. The queue's class counts skip technology plans, which have no
    `hasClass`.
  - **Implicit `any`.** `buildManager.builders`/`unbuildables` and
    `attackManager.bombingAttacks` were `new Map()` without type arguments,
    hence `Map<any, any>`, invisible to a search for `any`. Typing them
    found a test that keyed `bombingAttacks` by a string.
- **The second round** (`PLAN.md` 3.5, items 1-4 and 6-8), with the
  fingerprint unchanged at every step and a 24-game batch identical game for
  game before and after. What the stricter types found on the way:
  - **Wrong declarations.** The attack bonuses were declared an array with
    numeric multipliers (the template holds an object of strings); the ship
    metadata `transporter` an entity id (it is a transport plan's id).
  - **Implicit `any`.** `Object.values()` on a plain `object`, and three
    `new Map()` without type arguments (above): a search for the word misses
    them; the type checker's scan does not.
  - **Tests on impossible data.** A queue test named `plan_siege` and
    `plan_champ` (attack queues are `plan_<n>_siege`); one plan with no
    template; the queue manager's tests ran on made-up queue names and
    without the configured queues; an attack manager round trip restored
    plans whose queues the save never had. Each now sets up what a game
    has.
  - **Guards that could not fire**, gone with the types that made that
    plain: `addPlan` of no plan, `ResearchPlan`'s `researchTime` check.
  - **A quirk kept** (§4): a dock whose best angle is exactly 0 is not
    placed (`angle == false`).
- **The third round** (`PLAN.md` 3.5): base, army and transport-plan ids
  branded; plan metadata typed as entity metadata; roles as unions; one
  helper for the plans of every attack type; `debugWarn`; `noUnusedLocals`.
  The fingerprint and the 24-game batch did not move. On the way:
  - **More sentinels named.** A `base` of -1 or -2 on a foundation means "found
    a new base" (civic centre) or "a new base without an anchor" (dock), 0
    "no base" or "the trainer's base" in a training plan; the market search's
    own -1 is neither ("no base of its own, the standard placement").
  - **An unused parameter**: `changePriority`'s `metadata`, passed as
    `{ "phaseUp": true }` and never read (as in the original).
  - **Dead code**: `basesManager.init` walked our dropsites, looked their base
    up and did nothing with it (the original too); an unused variable in
    `emergencyManager`; imports nobody used, which the compiler did not check
    for until `noUnusedLocals`.
  - **Tests on made-up values**: roles `"keep"` and `"expansion"` on
    construction plans (the bot gives a construction plan no role).
- **Left** (`PLAN.md` 3.5): 19 functions over 150 lines, the records keyed
  by player or entity id (a `Map` reorders them), and 105 `declare` fields
  (below). The 117 other `any` hits of the first scan are evolving
  declarations (`let x;`, `const a = []`) that the compiler types from their
  assignments: not holes.
- **The `declare` fields (202)** fall in three groups. 133 are assigned in
  their own class's constructor: removing `declare` makes the compiler check
  that, and with the ES2022 target defines each field before the
  constructor body (own-property order can change, which matters where a
  class iterates its own fields, as `Config.Serialize` does). Done for 115;
  the compiler showed the other 18 assigned only on some paths (the attack
  and transport plans' constructors return early), which join stage 5. 12 are in subclasses, where a plain field would overwrite the
  value `super()` set (`ResearchPlan`'s `category`, ...). 57 are set only in
  `init()`, `Deserialize` or later: the managers' and plans' two-step
  set-up, so no small change removes them. Both groups go with stage 5, as
  each class is rewritten.

## 18. Stage 5: the economy, measured (2026-10-27)

Batch `stage5-a-economy`: stage 4's 100 seed pairs (pool seed 4, both slots,
`petra_out` vs `petra_parity`) played with `--bot-state`, the economy log on
(`economy.txt`, `bot-state.js`; `economy-log.ts`). All 200 games have stage
4's fingerprints (`stage4-h-capwait`): the log only reads. 50.3%.

- **The gather-rate estimate is always 0** (an engine change, shared by both
  bots and by the original): since commit 4b516b336e ("Get the UnitAI order
  data directly", April 2026) `Entity.unitAIOrderData()` returns UnitAI's
  orders, `{type, data}`, not their data; every caller still reads
  `order.target`. So:
  - `Entity.currentGatherRate()` finds no target and returns 0: the
    estimate (`GetCurrentGatherRates`) is 0.5 per gatherer assigned this turn
    and nothing else (0.04-0.17 against a real income of 6-15 per second).
    `pickMostNeededResources` then sorts by the wanted rate alone, and puts a
    resource that got a worker this turn behind those that did not: the split
    of minutes 2-8 follows the queues' wishes and ignores the income. Food
    heads the order 72-75% of the time from minute 4.
  - `basesManager` (the gatherers carrying back to a supply, counted for it
    in the turn cache) and `garrisonManager` (a unit already ordered into its
    holder) never match; in the original also the attack plan's and defense
    army's checks of what a unit targets (`attackPlan.js`, `defenseArmy.js`,
    `attackManager.js`). The port's `common-api.d.ts` declares the old shape.
  - The sum of the gathering units' rates, read from the order's `data`
    (the log's `rawRate`), follows the real income closely (food 6.3 against
    6.6, wood 9.3 against 8.8 at minutes 2-4; 13.2 against 11.7 for food at
    8-10): with the reader fixed, the estimate means what it was made to.
- **Food is the slow resource.** (The trips below are read from the
  workers' `supply` metadata, which the worker's supply check, itself broken
  by the order shape, keeps current: before the fix they are partly stale;
  see the fix's figures at the end.) Per gatherer-minute: food 52 at minutes 0-2
  (berries by the CC), then 36, 23, 21, 24 to minute 10, 31 at 10-12; wood a
  steady 50-54. Food gatherers gather 37-45% of the time at minutes 4-8 (wood
  61-64%), with trips of 100-120 from supply to dropsite (wood 70-90, falling
  to 40 as storehouses follow). Food takes 16-30 gatherers to bring 6-12 a
  second.
- **The split pairs** (93 seed pairs won from one slot, lost from the other):
  the start differs in the food trip. At minutes 4-6 the lost game's food
  trip is 23 longer (shorter in the won game in 65 of 92 pairs), its food
  per gatherer-minute 2.4 lower (61 of 93) and its gatherers gather 6% less;
  it puts 1.4 more gatherers on food and 2.1 fewer on wood (60 of 93), and
  gathers 1.8 less wood a second. From minute 6 the won game is ahead in
  both. Stage 4's reading holds (§16): the layout makes food slow, the bot
  answers with more food gatherers and falls behind in wood and production.
- **The early proxy** (`pair-score.ts`): over the 197 decided games, the side
  that had gathered more by minute 8 won 79% (correlation 0.60; units trained
  66%, 0.43); at minute 6, 71%; at 10, 86%. The pair score of this batch is
  exactly 0: both bots play the same until then. On stage 4's earlier army
  (`alpha` 0.6) against its control it reads +111 ± 96 gathered at minute 8
  over 93 pairs (excludes 0), where the win difference did not show.
- So stage 5's first change: read the order's `data` in the port (a reader in
  `adapter/unitState.ts`, the declared shape fixed), which revives the rate
  estimate and the other checks; then the split by the measured income per
  gatherer, the food trip included.

### The fix: the orders' data read again (2026-10-27)

`adapter/orders.ts` (`ordersOf`, each order's data as UnitAI.GetOrderData
gave it; `gatherRate`, in place of `Entity.currentGatherRate`), all 34 reads
of a unit's orders in the port through it, the declared shape the engine's
(§1, stage-5 row). Same code paths as before the engine change, so the bot
plays as Petra was written to.

- `stage5-b-orders` (stage 4's 100 pairs, pool seed 4): **58.1%** (115 to 83,
  CI 51.1-64.7%); against `stage5-a-economy` on the same pairs +0.2 ± 0.1
  wins per pair, +213 ± 110 gathered at minute 8 (`pair-score.ts`).
- `stage5-c-orders-seed5` (150 fresh pairs, pool seed 5): **62.9%** (185 to
  109, CI 57.3-68.2%); SPRT 50% against 55% accepts 55% (LLR 6.15). Both
  slots alike (64.2%, 61.6%); 46 pairs won from both slots against 10.
  Gathered 81 400 against 63 600 a game; 0 errors.
- The estimate now follows the income (food 4.4 against 5.9 a second at
  minutes 0-2, 8.8 against 7.3 at 4-6; wood 9.1 against 11.6), so
  `pickMostNeededResources` weighs both again: food heads it 27-61% of the
  time at minutes 0-8 (before: 7-75%, by the queues alone). Wood trips read
  20-26 (before 70-90: stale metadata, or woodcutters chasing far trees
  while the supply check could not see their target); food per gatherer-
  minute is still about 22-25 at minutes 4-10: the slow food remains.
- The smoke reference was recorded anew with it.


## 19. Stage 5: the gatherer split by measured rates (2026-10-27)

Branch `stage5`. The first utility decision: `world/gatherEconomy.ts` measures
each resource's rate per gatherer, the walk included (what the units
gathering bring in over all its gatherers, smoothed over a minute), and
`decision/gatherSplit.ts` gives each resource a target share of the gatherers;
`pickMostNeededResources` orders by the gatherers each lacks, and a gatherer is
moved when two resources' deficits differ by 2. Measured against
`petra_prev` (the port at `main`, `e308f613d2`; `baselines.ts prev`), each
variant on seed pool 6 (100 pairs, both slots):

| Variant | vs `petra_prev` | What went wrong |
|---|---|---|
| shares by wanted rate / measured rate | 42.4% (CI 35.7-49.4%), SPRT rejects 55% | `wantedGatherRates` starts each resource's short horizon at the config's reserve (`Config.queues.short`: 200 food and wood, 100 stone and metal): divided by metal's slow rate, a reserve took gatherers off wood (metal 128 against 5 gathered by minute 8, wood 200 less) |
| queued costs / rate, reserves as their rate (`QueueManager.gatherDemand`) | 52.5% (CI 45.6-59.3%) | ranked by deficit alone, an unwanted resource (0) came before an over-staffed wanted one (-1): an idle worker food turned away went to metal |
| and unwanted resources last (`byDeficit`) | 56.1% (CI 49.1-62.9%) on pool 6; **48.6%** (CI 43.0-54.3%) on 150 fresh pairs, pool 7 | the integration match: with only food queued and every stock over its reserve, the share sent 82 women to 14 fields (5 each), ten idle for minutes; the share rewards saturation (idle gatherers lower the measured rate, a lower rate asks for more) |
| and a resource with idle gatherers capped at those at work, its share to the others (`capAtSaturation`) | **43.6%** (CI 38.1-49.3%) on 150 fresh pairs, pool 8; SPRT rejects 55% | 11% less gathered (69 000 against 77 900), 2.2 units behind at minute 8: a woman idle for a moment between tasks caps food early |

- **Dropped.** Over pools 6 and 7 the third variant made 257 of 494, 52.0%:
  no gain shown (pool 6's 56% was the pairs the order was fixed on), and it
  idles women on full fields where Petra's order does not; the cap that
  stops that loses. `pickMostNeededResources` keeps Petra's order (with the
  order data read, its estimate works, §18); the smoke test shows the branch
  plays as `main` again (24 of 24). Kept for later decisions: the measured
  rates (`world/gatherEconomy.ts`, updated and saved, read by no decision),
  `QueueManager.gatherDemand` (queued costs and reserves apart) and
  `decision/gatherSplit.ts` with its property tests, not wired.
- What it changes: about 150-200 more food (2-3%) by minutes 8-15, the same
  wood, stone and metal, four more units by minute 15; even by minute 20. The
  early proxy sees it (+125 ± 68 gathered at minute 8 on pool 7, excludes 0),
  but a 2-3% food gain does not decide games.
- So the split is not where food is lost: its gatherers gather 40% of the
  time at minutes 4-8, on trips of 90-113 from their supply to the dropsite
  (wood: 65%, 26). Where the food is gathered (far berries and hunt against
  fields by a farmstead) is the next domain.
- The early proxy's lesson: a lead at minute 8 that comes from the economy
  alone predicts less than the same lead in stage 4's games, where it came
  from the start's layout and compounded; it ranks variants of one decision,
  the SPRT on fresh pairs still decides.

## 20. Stage 5: where food comes from (2026-10-27)

Branch `stage5`. The economy log by food source (`economy.txt`'s
`foodSources`: the supply each food gatherer's orders name, the trip from it
to our nearest food dropsite), 100 games of `main` against itself (pool 9):

| Minutes 6-8 | Gatherers | Gathering | Per gatherer, the walk included | Trip |
|---|---|---|---|---|
| fields (grain) | 7.9 | 91% | 0.54 | 33 |
| berries (fruit) | 10.0 | 45% | 0.57 | 128 |
| hunt (meat) | 1.3 | 23% | 1.46 | 164 |
| no supply in their orders | 8.5 | 0% | 0 | - |

- A field keeps its women gathering 90-95% of the time at any minute (0.54
  a second at minutes 4-8, 0.72 at 10-15 with the farming techs). Berries
  bring in 0.70-0.75 a second by the civic centre at minutes 0-4, then their
  bushes are ever further away: trips of 40-50, 128 by minutes 6-8, 150 by
  8-10, gathering 38-45% of the time.
- The gatherers with no supply in their orders, 30% of the food gatherers at
  minutes 4-10: carrying food back from a supply that is gone, mostly bushes
  picked clean (54%), building fields (30%), idle hunters (8%). The berries'
  real rate counts the first: about 0.4 a second at minutes 6-10, a field's
  0.54-0.66. Petra queued its first field once the berries within reach fell
  below 600 food (§4), at a time the berries already paid less.
- **The rule** (`decision/foodSource.ts`, `baseManager.checkResourceLevels`):
  a field is wanted as soon as a gatherer brings in less at the berries than
  at a field, measured (`world/gatherEconomy.ts`: per food source, the rate
  of those gathering over all its gatherers, smoothed over a minute; one
  carrying back from a supply gone counts on the berries' side) on 3 berry
  gatherers or more. The first field comes then, or below 600 berries as
  before; while the berries are slower, one more field is laid out at a time.
- Against `petra_prev` (`main`): tuned on pool 10, 55.3% (CI 48.3-62.0%,
  fields 16 gatherers at minutes 6-8 against 8, berries 5 against 10);
  decided on 150 fresh pairs, pool 11: **56.3%** (169 to 131, CI 50.7-61.8%;
  42 pairs won from both slots against 23), 81 400 gathered a game against
  72 300; SPRT 50% against 55% undecided (LLR 2.31), 55% for `petra_prev`
  rejected. Kept: 279 of 499 over both pools, 55.9%.
- The early proxy saw it (+141 ± 88 gathered at minute 8), and this time the
  win-rate followed, where the gatherer split's +125 did not (§19): the split
  moved 2-3% of the food, the fields 13% of all resources.

## 21. Stage 5: the first fights, and a rush that drafts less (2026-10-27)

Branch `stage5`, against `petra_prev` at the field rule (`0fc9b921c8`).

- **What decides games now** (the field rule's tuning batch, pool 10, 199
  decided games): in the seed pairs won from one slot and lost from the
  other, a gatherer brings in the same in both (within 1-3 per minute, trips
  within 2), but the won game has more of them (+2.8 on wood at minutes 6-8,
  +7.3 on food at 8-10). The gap opens in the fights: units lost by the winner
  and the loser 5 and 7 by minute 8, 12 and 16 by minute 10, 41 and 58 by
  minute 12 (killed the reverse). Dropsites (wood gatherers gather 64% of the
  time on trips of 26) would gain less than the first fights decide.
- **Petra's rush is all in**: its infantry target is 16-24 (`rushSize`), but
  while it prepares it drafts every citizen-soldier worker but eight
  (`assignUnits`, `keep = 8` for a rush), and starts with a median 53 units.
  A first attack started at minutes 8-10 won 45% of games, at 12-16 74% (a
  correlation: a side that starts late may have just beaten an attack off).
- **Capping the rush's draft at its target size** (a median 31 units at the
  start): **40.6%** (80 to 117, CI 34.0-47.6%, pool 12; SPRT rejects 55%), and
  *less* gathered over the game (78 900 against 90 900): the all-in rush pays
  for the soldier-gatherers it takes, by what it kills of the enemy's army
  and economy. Reverted. Its early proxy read exactly 0: the rush leaves
  after minute 8, so the proxy cannot see a change to the fights.
- The engine hung in 3 of these 200 games (killed by the 15-minute timeout).
- **Where the losses are** (the fronts log, `economy.txt`'s `fronts`: our
  soldiers at home, in no one's land and in an enemy's, and the enemy units we
  see in our land, every 30 s; 99 games of `petra_prev` against itself, pool
  13, joined with the replay's losses per 30 s, minutes 0-20): attacking
  pays, 1.3-1.8 kills per loss (12.9 killed against 7.3 lost per sample on the
  winner's side); defending at home with 5+ enemies in our land does not, 0.6
  to 0.8 (the losing side 9.6 lost against 5.7 killed). While defending, the
  side that lost the game lost 25 women a game, the winner 2.5; attacking
  winners killed 1166 women in all. The rush pays by the gatherers it kills.
- **Sheltering a woman as soon as a fighter attacks her** (Petra waits for
  half her health, then takes her to a healing building), in the nearest of
  our buildings with room within 60: **49.2%** (96 to 99, CI 42.3-56.2%, pool
  14), the women lost while defending unchanged (25.8 a game against 25.4).
  Only houses (3 places), civic centres (20) and towers (3) take a garrison,
  and women work at fields, bushes and woodlines out of reach of one with
  room: the rule seldom fires, and three places do not save a work party.
  Reverted. What would protect them is at the scale of the town: soldiers
  between the raid and the gatherers, or the gatherers pulled back to the
  civic centre while an army is in our land.
- The engine hung in 4 of these 200 games (killed by a 6-minute timeout).
- **The town bell** (the game's alert, AlertRaiser: a civic centre calls the
  civilians within 120 into any building of ours with room, a storehouse or
  farmstead within 50; Petra never rings it), rung where enemy soldiers are
  within a bell's range, ended 15 s after they left:
  - at 3 enemy soldiers: **41.2%** (82 to 117, CI 34.6-48.1%, pool 15), 14%
    less gathered, and warnings in 178 of 199 games: the women it sent in
    carry no garrison type, so the garrison manager booked them as
    protection and kept them in while any enemy was around the building;
  - with those women left to the bell (in while an alert is up), rung only
    for 5+ enemy soldiers outnumbering ours there: **47.5%** (95 to 105, CI
    40.7-54.4%, the same pool), no warnings, 2% less gathered; the women the
    losing side lost while defending fell from 25.4 to 15.1 a game, and the
    games went the same way.
  - Reverted, never committed (`decision/townBell.ts` and its tests). The
    women are not what decides these games: the losing side also loses about
    68 soldiers a game while defending, for 61-65 killed, the winner about 30
    for 26-38. The soldiers' fight at home is the gap, which is the defense
    armies' (`defenseManager`, `defenseArmy`) and the fight estimator's
    (stage 6) ground.
- **The defense armies** (the defense log, `defense.txt` with `match.sh -b`:
  each army's creation, a snapshot every 30 s, and its end with the defenders
  it ever had that died and the foes it fought that are gone; 100 games of
  `petra_prev` against itself, pool 16; 2226 armies against 3+ foes before
  minute 25). "Killed" counts foes that walked out of sight too, so the
  ratios below are high; they compare armies, not fights.
  - How far its defenders were from the foes 30 s in matters little: a
    median of 0-40, 40-80 or 80-150 gives 1.3-1.6 kills per loss; only the
    few armies whose defenders were 150 or more away do worse (0.96, 34).
    Picking the nearest defenders first (the code's own TODO) would change
    little.
  - What separates the games is how many defenders there are at all: in
    games won, a median 10 defenders against 6 foes; in games lost, 2 against
    8 (1555 of the 2226 armies). The losing side does not fight its home
    battles badly; it has no soldiers at home to fight them, dead or away.
    The fights are lost before the defense: in the army a side has when the
    raid comes, which the economy and the rush decide.

## 22. Stage 5: the houses (2026-10-28)

Branch `stage5`, against `petra_prev` at the field rule (`0fc9b921c8`).

- **Growth stops at minute 3** (the timeline's `pop` and `popLimit`, 100
  games of `petra_prev` against itself, pool 16): half the games stand at
  the population limit at minute 3 (29 of 30), 8% at minute 5, none from
  minute 11. Petra's rule to start a house is sound (below 30 population a
  house goes with 10 places left), but the house queue has the lowest
  priority of all (250; women 300, military buildings 330, fields 480,
  citizen soldiers 600): at minute 3 it holds a median 24 of a house's 150
  wood. Short of 5 places it doubles to 500, still below the soldiers, who
  keep the wood.
- **The rule** (`headquarters.buildMoreHouses`): short of 5 places, the house
  queue goes before the training queues (one above the citizen soldiers),
  never below Petra's doubling.
- Tuned on pool 17: 50.0% (99 to 99), the games at the limit at minute 3 from
  56% to 32%, two more units at minutes 5-9, 5.5% more gathered; decided on
  150 fresh pairs, pool 18: **56.0%** (167 to 131, CI 50.4-61.6%; 41 pairs won
  from both slots against 23), 88 100 gathered a game against 81 300; SPRT
  50% against 55% undecided (LLR 2.11), 55% for `petra_prev` rejected. Kept:
  266 of 496 over both pools, 53.6%.
- The early proxy read its largest lead yet on both pools (+252 ± 57
  gathered and +2.4 ± 0.5 units at minute 8 on pool 18), and the tuning
  pool's 50% shows how far a few units at minute 8 are from deciding a game:
  the proxy tells a change's direction, 150 fresh pairs its worth.
- **A map with the same start for both** (`random/mainland_mirror`: Mainland
  with player 1's half turned by 180° onto player 2's, heights, textures,
  trees and every entity; two players of one civilisation on a circle; the
  two starts' supply lists identical in a test game). The game has none: of
  its 42 two-player skirmish maps, no transform that swaps the civic centres
  matches more than 14 of 95 berry bushes, and none of the mines. The house
  fix against the field rule on the same 150 seed pairs (pool 18):

  | | `mainland` | `mainland_mirror` |
  |---|---|---|
  | win-rate | 56.0% (CI 50.4-61.6%) | 50.5% (CI 44.8-56.1%) |
  | interval width | 11.2 | 11.3 |
  | player 1's games won | 54.4% | 51.5% |
  | pairs won by one bot from both slots | 43% | 50% |
  | median game length | 30 min | 36 min |

  The start's layout is a small part of the noise: on identical starts half
  the pairs still split, and the interval is as wide; most of a game's
  outcome is made in the game (the AI seed, small differences the first
  fights amplify). The mirror takes the slot's advantage down to what the
  engine's order of the players leaves (51.5%). The house fix shows no gain
  on it (its value may lie in the poorer of two unequal starts, or partly in
  pool 18's luck; 53.6% over the 496 mainland games). Mainland stays the
  pool that decides; the mirrored map is a check on fair starts.

## 23. Stage 5: an audit of the engine interface (2026-10-28)

The order data's change of shape (§18) was worth more than every tuned rule
since, and nothing had flagged it: a common-API accessor that reads what the
engine no longer provides returns undefined, NaN or 0 without an error. So
the whole interface was checked against the engine as it is now.

- **Static checks**, all clean: every template path the common API and the
  port read, against every template (`_string` leaves aside); the 56 class
  names the port filters by, against the templates' `Classes` and
  `VisibleClasses`; the 21 AI events and the fields the port reads off them;
  every `_entity` field the common API reads, against what `AIProxy.js`
  sends; every `playerData` field, against `GuiInterface`'s player state; the
  34 command types the bot sends (`helpers/Commands.js` has each), and the
  fields each carries in a real command log against those its handler reads;
  the hard-coded template names for each of the 15 civilisations and the
  hard-coded technology names; the modification paths the research manager
  matches (each is still in use); the commits since mid-2025 to the
  components the AI reads (gatherer, supply, trainer, researcher, garrisons,
  dropsites, player, technologies, commands). The two renames among them,
  gendered civilians (`support_civilian`) and Persians to Achaemenids, appear
  in no port code; some tests keep `support_female_citizen` and `pers` as
  fake names, which is harmless.
- **A runtime probe** (`APIPROBE`, `apiprobe.txt` with `match.sh -b`,
  `build/petra_ts/bot-state.js`): at game minutes 6 and 20, every read-only
  method of `Entity` and `Template`, with each argument it takes, on up to
  three entities of each template (own, gaia, enemy) and on our trainable and
  buildable templates, counting what came back (undefined, null, NaN, 0,
  false, empty, thrown). Most NaN and undefined values are an entity without
  the component (a tree's `walkSpeed`, a house's `attackTypes`). The game is
  the same with the probe (fingerprint c52844322fe0c989 with and without it).
  One line per call: the engine's `print` drops a line of 59 KB whole.
- **`obstructionRadius()` is NaN for a unit**: it reads
  `Obstruction/Unit/@radius`, and units' obstructions are now `<Unit/>`, their
  size the clearance of their passability class. The port calls it on
  structures, and once on a relic's holder (`victoryManager.ts`, Capture the
  Relic), which is normally a structure. Minor, not fixed.
- **`unitAIOrderData()` throws for an entity without UnitAI** (a structure,
  a tree): since 4b516b336e it queries `IID_UnitAI` directly. Every port call
  is behind a unit state or class, and no game has logged it. It returns the
  simulation's own order objects (`GetOrders` is a shallow copy of the queue):
  the port must never write to them; it only reads them. The proxy's cached
  `unitAIOrderData` (`GetOrderData`) is no longer read.
- **Not a fault, a lead for the research step**: two technologies change
  `ResourceGatherer/BaseSpeed` and two `ResourceGatherer/Rates/food.meat`,
  paths the research manager's early checks never match, so they wait for
  the generic research later.
- `currentGatherRate` is still 0 for every gatherer (§18; the port reads
  `gatherRate`, `adapter/orders.ts`).

Nothing else of the order data's kind: the interface the port reads is the
one the engine gives. Run the probe again after an engine or common-API
update.

## 24. Stage 5: idle production and the queues' accounts (2026-10-28)

Step 3 of `PLAN.md` §6.1 began with a measurement: the economy log
(`economy.txt`, `match.sh -b`) now has each 30 s window's seconds per trainer
by what it did (`production`: training, waiting for housing, idle with a unit
plan queued but not funded, idle with none queued, researching), and each
queue's account against its first plan's cost (`accounts`), sampled every
turn from the engine's production queues. On 50 seed pairs of pool 18
(petra_out against petra_prev, the same code):

| minutes | CC training | CC idle, unfunded | CC housing | barracks training | stock |
|---|---|---|---|---|---|
| 0-3 | 91% | 6% | 0% | - | 880 |
| 3-6 | 60% | 31% | 8% | 50% | 1010 |
| 6-9 | 50% | 48% | 2% | 70% | 1110 |
| 9-12 | 70% | 27% | 3% | 84% | 1080 |

The won and lost sides alike (the same code): a cost both pay. The civic
centre stood idle a third to a half of minutes 3-9 with 8-15 women and 36-44
soldiers queued and about 1000 resources in stock. Not one queue hoarding
it: in minutes 3-9 the soldiers' queue held 245 on average, the minor
techs' 164, the attack plans' 141, the military buildings' 98, the women's
60, the houses' 37, and 281 were booked by none (mostly stone and metal no
plan wanted yet). The queue manager splits each resource between every
queue that wants it by priority (`distributeResources`), so that none can
pay: in game 1 at 7:00, 424 food, the women's queue holding 105 of its 150,
the soldiers' 117 of 150, an attack's 182 of 200, nothing started. Its own
header says as much ("if all queues have 70% of their needs, nothing gets
done"). Its compaction, `switchResource`, runs only when not a unit of the
resource is left unbooked, and the split's rounding nearly always leaves a
few.

**The change** (`QueueManager.completeBestPlan`, kept): after the split,
each turn, the first plan of the highest-priority queue that can be paid in
full from the unbooked resources and the accounts of the queues below it is
paid (unbooked first, then the lowest queue up) and starts the same turn; a
queue above is never taken from, a paused queue or a plan not ready to go is
passed over, and nothing moves while the first queue can pay on its own.

- Tuning pool (pool 18, 50 pairs): 57.0%; against the same pairs without
  it, +7.2 ± 1.1 units and +245 ± 134 gathered at minute 8. Stock in
  minutes 3-9 fell from about 1050 to 680; the barracks trained 78% of
  minutes 3-6 (54% before). The civic centre stood idle more in minutes 3-6
  (43% against 31%): the soldiers' queue (600) goes before the women's
  (300), and now gets paid first.
- Decided on 150 fresh pairs (pool seed 32): **61.0%** against petra_prev
  (183/300, CI 55.4-66.3%, SPRT accepts 55%, LLR 5.1); 52 pairs won from
  both slots, 19 lost from both; 11% more gathered (83k against 75k),
  buildings lost 13 against 21.

Next in the same step: the women's priority below the soldiers' (the civic
centre idle while soldiers are paid, §25), and the worker targets.

## 25. Stage 5: the women before the soldiers (2026-10-28)

Petra set the women's queue at 300, below the citizen soldiers' 600, "to
not get all the food". With the split accounts (§24) the order hardly
mattered: no queue could pay. With the best plan paid first it does: the
soldiers' queue took the food, the barracks trained more and the civic
centre stood idle 43% of minutes 3-6 (31% before §24). The change: the
women's queue at 650, above the soldiers' (`config.ts`). Which units the
bot wants is unchanged (`trainMoreWorkers`' share of support units); only
which is paid first.

- Tuning pool (pool 18, 50 pairs, against petra_prev with §24): 71.0%; at
  minute 8, +11.3 ± 1.0 units and +1522 ± 130 gathered, the proxy's largest
  lead yet. The civic centre idle 25% of minutes 3-6 (43%), the women queued
  down from 18 to 3 and the soldiers up from 31 to 50 in minutes 3-6; stock
  in minutes 3-9 about 780.
- Decided on 150 fresh pairs (pool seed 33): **74.2%** against petra_prev
  (221/298, CI 68.9-78.8%, SPRT accepts 55%, LLR 13.0); 84 pairs won from
  both slots, 13 lost from both; 54% more gathered (94k against 61k),
  buildings lost 11 against 30, peak map control 61% against 36%.

Women are the cheap gatherers (50 food, no wood): paid first, they bring in
the resources the soldiers then cost. That the soldiers' raids decide the
first fights (§21) did not make soldiers the better buy at minutes 3-9.

## 26. Stage 5: the women's share (2026-10-28)

With the women paid first (§25) the civic centre still stood idle 25-31% of
minutes 3-9, now with food the short resource (113 in stock at minutes 3-6,
nearly all booked) and from minute 6 hardly a woman queued (0.1 on average):
`trainMoreWorkers` books a woman only while the support units are below
`supportMax · (1 − e^(−α · total / supportMax))`, `supportMax` being
`supportRatio` times the worker target, and Petra's `supportRatio` at the
hard difficulties is 0.3 (the easy ones have 0.4-0.5): at difficulty 5 at
most 45 women of 150 workers, 21 at 40 workers, the rest citizen soldiers,
who cost wood too and gather slower.

- `supportRatio` 0.5 (tuning pool 18, 50 pairs, against petra_prev with
  §25): 61.6%; at minute 8 +4.9 ± 1.2 units, +212 ± 127 gathered; the civic
  centre trained 88% of minutes 3-6 (74%). 0.7: 59.0%, and against 0.5 pair
  by pair -69 ± 136 gathered: past 0.5 more women bring in no more.
- 0.5 decided on 150 fresh pairs (pool seed 34): **61.3%** against
  petra_prev (184/300, CI 55.7-66.7%, SPRT accepts 55%, LLR 5.3); 50 pairs
  won from both slots, 16 lost from both; 22% more gathered (96k against
  79k), buildings lost 17 against 26. Kept.

The start of the share (α, 0.7 while a rush is planned, 0.85 otherwise) is
unchanged; the cap moved. The four changes of §24-26 are all the same
lesson as §20 and §22: the early economy had blocks, not a wrong balance.

## 27. Stage 5: the rush and the town phase, after the economy fixes (2026-10-28)

A second checkpoint after §24-26, 150 fresh seed pairs (pool seed 35) from
both slots: **92.3% against petra_parity** (277/300, CI 88.8-94.8%; 131
pairs won from both slots, 4 lost from both; 88k gathered against 37k,
buildings lost 3 against 26). The first checkpoint (§6.1 of PLAN.md) gave
78.7%.

**The rush.** Since §24-26 the first rush starts at minute 16 (median; it
was 10.6 before §24): a rush leaves only when every category reaches its
target size (`mustStart`: 20 infantry and 4 riders), and its queue (priority
250) is paid after the women's, the soldiers', the fields' and the houses'.
By then it is the army, not a rush. Variants against petra_prev, tuning pool
18, 50 pairs each, all dropped:

| variant | win-rate | first rush leaves | at minute 8 (units, gathered) |
|---|---|---|---|
| no minimum of riders (`minSize` 0) | 49.5% | 15.5 | 0, 0 (`mustStart` reads the target) |
| infantry only (no riders' category) | 30.0% | 7.8 | -0.8, -330 |
| no rush at all (`setRushes(0)`) | 47.0% | - | +3.2, +63 |

A rush that leaves at minute 8 costs the economy more than it takes from the
enemy; the late one is a reserve that does no harm.

**The town phase.** The bot asks for it at `popPhase2` 150 (at difficulty
5, the cap: half the population limit) and gets it at minute 10, population
147, city phase at 13. `popPhase2` 100: 30.3% (tuning pool), at minute 12
-22.7 ± 2.8 units and -1852 ± 496 gathered: the phase's 500 food and 500
wood are better spent on growth. Dropped.

## 28. Stage 5: research by payback, the first of the economy scoring module (2026-10-28)

Measured first, on the logs of the current code (pool 18, 50 pairs, with
the state dump; and 20 pairs with the command log):

- **Hunting** is small: under two hunters at any time, so its 19-26% of
  time gathering on trips of 140-170 costs little. **The food gatherers
  without a supply** (4.6-10 of them) are mostly carrying back from a supply
  picked clean (about 3) or building fields (about 3.6); under one idle.
  The fields gather 92% of the time, wood 51-65% on trips of 18-33. Nothing
  large left in how the gatherers spend their time.
- **Research** (blue's first command per tech, 80 sides): the iron axes at
  minute 2.7, then the fruit tech at 9.7 (the berries done by then), the
  first capacity tech at 10.0 and the plough at 11.6, with 25-40 women on
  the fields since minute 4. The research queue (`minorTech`, 250) is paid
  after the women's, the soldiers', the fields' and the houses', and the
  research manager queues nothing while it holds a plan: in a game the
  capacity tech (200 food, 200 wood) waited there unpaid from minute 5 to 15.

**The change**: `decision/economyScore.ts`, the first part of the scoring
module (PLAN.md §6.1): an option's payback, the seconds until the income it
adds has repaid its cost (`paybackSeconds`: its delay plus its cost over its
gain), the gain read off the measured rates (`incomeGain`: for each gather
rate a tech multiplies, what our gatherers of that supply type bring in now
times the gain; `incomeOf`). The research manager queues the economy tech
that pays back soonest, if within `PAYBACK_HORIZON` (240 s), with the
research queue just above the women's (reset when it starts), in place of a
plan of Petra's rules waiting there. The plough on 26 farmers: +3.4 food a
second, 127 s.

| variant (tuning pool 18, against petra_prev) | win-rate | at minute 8 / 12, gathered | the plough |
|---|---|---|---|
| a tech that pays back sooner than a new woman (67 s) | 52.0% | +61 / +147 | minute 11.5 |
| within 240 s | 49.0% | +246 / +545 | 9.9 |
| within 240 s, taking the waiting plan's place | 54.5% | +700 / +1839 | 5.1 (fruit tech 2.0) |

A woman pays back sooner than any tech, but the civic centre trains one at
a time, within the housing and the share (§26): she is not the
alternative a tech competes with.

Decided on fresh pairs (pool seed 36): 150 pairs gave 55.4% (CI
49.7-60.9%, SPRT undecided); 300 pairs, **54.4%** (325/597, CI 50.4-58.4%,
SPRT 50% against 55% undecided, LLR 2.3), 10% more gathered (102k against
92k). Kept, on the interval as §22: a gain, smaller than the 55% the SPRT
asks about.

Tried next and dropped: **capacity techs scored** by the trips they save. A
gatherer's cycle is its load over its gathering rate `r` and a trip of `w`
seconds, `c / (c/r + w)`, the trip from the share gathering (`g` of `n`:
`w = (c/r)(n/g - 1)`); a bigger load makes the same trip less often. The
fields walk little (92% of the time gathering), so it counts mostly the
woodcutters. The first capacity tech came at minute 5.5 (10.9), and nothing
else moved: 53.0% on the tuning pool, at minute 8 +50 ± 103 gathered, at 12
-155 ± 608, -1.6 ± 1.0 units. Its 400 resources at minute 5 buy about what
they cost.

## 29. Stage 5: a town that cannot spend what it gathers (2026-10-28)

After §24-28 the early economy has no block left that the logs show, and the
stock grows from minute 10 (current code, pool 18, 50 pairs): 2200 at
minutes 10-15, 2500 at 15-20, 3000 at 20-25, while the trainers train
88-94% of the time and the population stays at 155-165 of the 300 limit.
Petra builds its military buildings by population thresholds, about three
(1-2 barracks or ranges, 1-2 stables; the stables seldom train, the army
asks for few riders).

**The change**: `world/production.ts`, how busy the infantry trainers
(barracks and ranges) are, the share of them with a batch in their queue
smoothed over about a minute, owned by the headquarters and not saved (it
measures again within a minute after a load); and after Petra's rules in
`constructTrainingBuildings`, one more barracks (or range) while those it
has train 85% of the time and the unbooked stock covers two of them, up to
five.

- Counting the stables in the share (first try): they idle, the share
  stays near 0.6 and the rule hardly fires: 50.0%, the games as before.
- Barracks and ranges only (tuning pool 18): 62.0%; at minute 16 +23.7 ±
  6.5 units; the barracks 5.7 at minutes 15-20 (2.0), the population 176-183
  (156-164).
- Decided on 150 fresh pairs (pool seed 37): **66.4%** against petra_prev
  (198/298, CI 60.9-71.6%, SPRT accepts 55%, LLR 8.3); 57 pairs won from
  both slots, 8 lost from both; 31% more gathered (111k against 84k),
  buildings lost 15 against 29. Kept.

One game of the 300 (and two of stage 4's, before any of these changes)
logged the game's own `UnitAI.js` error in `FINDINGNEWTARGET`
("cmpResourceGatherer is null", line 2920): a unit in a gather order
without a ResourceGatherer, a fault of the game's, not the bot's.

## 30. Stage 5: expansion, and what the stock is for (2026-10-28)

With five barracks (§29) the stock still holds 2000-3800 after minute 15,
the civic centre trains alone. Petra plans a new civic centre once it has
more than about 70 units a base and is past the village phase (minute 10),
in a queue of priority 1, paid from what the others leave: the second is
ordered at minute 16 (median; 14 of 46 lost sides never order one, on the
command logs of 50 pairs). It costs 850 (300 wood, 300 stone, 250 metal)
and takes 500 s to build.

| variant (tuning pool 18, against petra_prev with §29) | win-rate | at minute 16 / 20 |
|---|---|---|
| the civic centre queue at 500, not 1 (the second ordered at minute 13) | 43.4% | -5.4 / -11.4 units, -221 / -2781 gathered |
| up to eight barracks, not five | 49.0% | -0.7 / -2.4 units |

Both dropped. An earlier civic centre is 850 resources and eight minutes
of building away from paying anything back; the army a fifth barracks can
train is as much as the town feeds. The stock after minute 15 is the
surplus of a won economy, not a block.
