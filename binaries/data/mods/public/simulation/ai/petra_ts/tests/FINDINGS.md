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

Each is pinned by a test that only the port passes (26 tests in all; the
original failed exactly the first 20 when last run, the six stage-4 rows
were fixed after the original stopped being a test target). Each row says
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
- **Left** (`PLAN.md` 3.5): `Template.get()` returning `any` (55 uses),
  three more `any` declarations, the `plan` metadata's magic numbers (31
  uses), queue names as `string`, 19 functions over 150 lines, 571 `==`, 84
  inline `import()` types, 99 `for...in`, and the `declare` fields. The 117
  other `any` hits are evolving declarations (`let x;`, `const a = []`) that
  the compiler types from their assignments: not holes.
- **The `declare` fields (202)** fall in three groups. 133 are assigned in
  their own class's constructor: removing `declare` makes the compiler check
  that, and with the ES2022 target defines each field before the
  constructor body (own-property order can change, which matters where a
  class iterates its own fields, as `Config.Serialize` does): planned for
  stage 4. 12 are in subclasses, where a plain field would overwrite the
  value `super()` set (`ResearchPlan`'s `category`, ...). 57 are set only in
  `init()`, `Deserialize` or later: the managers' and plans' two-step
  set-up, so no small change removes them. Both groups go with stage 5, as
  each class is rewritten.
