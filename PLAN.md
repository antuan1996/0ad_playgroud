# Petra TS: engineering plan

How Petra TS goes from a faithful port of Petra to a stronger AI, starting from
the state of branch `bugs_fixing` (2026-10-25). It answers the planning prompt
(goal, constraints, architecture, validation, roadmap); facts about the
project are referenced to the files that hold them.

## 0. Where the project stands

| Asset | Where | State |
|---|---|---|
| The port | `simulation/ai/petra_ts/*.ts` | One file per original `petra/*.js`; strict TypeScript, no `as` casts or `!` (`requireValue` where a value is guaranteed) |
| In-game bot | `simulation/ai/petra_out/` (generated) | `npm run build:petra:out`; bot id `petra_out`, "Petra TS" |
| Engine-facing types | `engine-api.d.ts`, `common-api.d.ts`, `globalscripts.d.ts`, `petra-runtime.d.ts` | `EntityId`, `PlayerId`, `WorldPos`, `MapPos`, `AccessIndex`/`SeaIndex`, `GameMs`/`GameSeconds`, `TemplateName`, `CellIndex<Grid>` are branded (stage 2; conversions in `petra_ts/brands.ts`); commands are a union by `type` |
| Behaviour tests | `petra_ts/tests/`, harness in `tests/harness/` | 1712 tests on the sources and the built bot, importing and typed by the port; 79 pin a bug of the original or a fix of stages 4-6 (the original failed the first 20 when it was last a target, stage 3) |
| Findings | `tests/FINDINGS.md` | Bugs, port/original differences, shared quirks, unreachable code, match findings (§10–12) |
| Matches | `build/petra_ts/match.sh` | Deterministic headless or visual matches; records: statistics, timeline, commands, notices, bot state (`-b`), fingerprint, rerun line |
| Baselines | `build/petra_ts/baselines.ts`, tag `petra-ts-parity` | `petra_parity` (the port at the tag) and `petra_fixed` (original + patch), built as bots; with the 15-fix patch they play the same games (stage 1) |
| Parity tools | `command-diff.ts`, `parity-bisect.ts`, `baselines.ts hybrid` | Where two command logs part; which module makes a difference |
| Batches | `build/petra_ts/batch.ts`, `batch-stats.ts` | Parallel headless games with isolated `XDG_*` folders; `results.tsv`; win-rate with Wilson CI, SPRT, slot advantage, determinism |
| Turn timing | `match.sh -P`, `ai-times.ts`, `CCmpAIManager.cpp` | Each AI's script time per turn, measured by the engine (two clock reads, about 27 ns, kept in memory); the paired budget check `ai-times.ts --compare` |
| Layers | `petra_ts/{adapter,world,decision,execution}/` | Stage 3 done: the folders, unit state parsed (`unitState.ts`), one command exit (`commands.ts`), versioned saves, the read-only base view |
| Smoke test | `npm run test:petra:smoke`, `build/petra_ts/smoke/reference.tsv` | 24 fixed games vs `petra_parity` compared game for game with a recorded reference: a refactor leaves all identical |
| Attack log | `match.sh -b` (`attacks.txt`), `batch.ts --bot-state`, `attack-log.ts` | Every attack plan's life and what it lacked; with the replays' 30 s statistics, the paired games of a batch compared slot against slot |
| Economy log | `match.sh -b` (`economy.txt`), `economy-log.ts` | Every 30 s: the bot's gather-rate estimate and wanted rates against the real income, gatherers and what they do, trip lengths, the start's supply layout |
| Early proxy | `pair-score.ts` | The lead at minute 8 per seed pair, with its worth as a predictor and a pair-by-pair comparison of two batches (§5.3) |
| Integration test | `npm run test:petra:match` | One fixed mirror match, 13 anomaly checks on engine data only (`match-checks.ts`) |
| Upstream notes | `build/petra_ts/upstream/` | A patch of 15 fixes for the original, with which it plays as the port (stage 1); shared quirks; a `Commands.js` bug |

The weaknesses stage 4 started from (`FINDINGS.md` §4, §11, §12) are fixed
or found not to decide games (§16): the withdrawal into a civic centre's
footprint, mercenaries booked as workers, attacks that never ended, plans
churned at the population cap; the first field and the town-phase population
do not lose the games that were blamed on them, and attacks that never fill
belong to a side that already lost. What decides the games is a production
lead of a few units at minutes 7-8, from how fast food and wood come in at
the start, amplified by the first fight (§16): stage 5. Its first measurement
(§18) found the economy's own gauge broken: since an engine change, every read
of a unit's orders failed and the gather-rate estimate was 0. Reading them
again (stage 5's first change) gives 62.9% against `petra_parity` (CI
57.3-68.2%, 150 fresh seed pairs, SPRT accepts 55%).

Stage 5 is closed (2026-11-04, tag `petra-ts-stage5`, §6.1): the economy's
blocks on growth removed one measured change at a time, islands played to a
decision, and the port's types and structure finished (3.1, 3.5): 95.0%
against `petra_parity` at the last checkpoint. What decides a mainland game
now is the first big army and when it fights (`FINDINGS.md` §46): stage 6.

## 1. Constraints that shape every stage

1. **Determinism, always.** The AI runs inside the lockstep simulation
   (`CCmpAIManager`'s `CAIWorker`): every multiplayer client runs it and
   replays re-run it, since AI commands are not recorded. Any divergence
   desyncs a game or breaks a replay. Rules: randomness only from the
   engine-seeded generator; no wall-clock time in decisions; iteration order
   from arrays or insertion-ordered maps, never from anything that differs
   between machines. Parity with Petra may go; determinism may not. Check:
   the same seeds twice give the same fingerprint (already how matches work).
2. **The engine interface.** Each turn the AI receives a structured-clone copy
   of the state `AIProxy`/`AIInterface` publish, and acts only through
   `Engine.PostCommand`. The engine's UnitAI owns unit state and changes it on
   its own (target exhausted, attacked, order refused); an order is a request,
   not a transition. Refusals reach the AI only as GUI notices (seen in
   `notices.txt`), not as results.
3. **The runtime.** SpiderMonkey; modules are loaded by VFS path
   (`prepare-bot.ts` rewrites imports); nothing outside the mod's files at
   runtime, so no npm libraries in the bot. The bot runs synchronously in the
   simulation turn (200 ms); Petra spreads its work by running the HQ update
   one turn in eight per player.
4. **Save games.** Every manager has `Serialize` and a `restore` factory
   (stage 5; the bot itself keeps the engine's `Serialize`/`Deserialize`). A new bot keeps
   them, versions its saved data, and refuses (with a message, then a fresh
   start) data from a version it cannot read.
5. **Two shipped bots.** `petra` (original) stays untouched in this repo;
   changes to it are proposed upstream (`upstream/petra-fixes.patch`).

## 2. Strategy: freeze, then evolve beside the baseline

- **Freeze the port.** Tag the current port (`petra-ts-parity`) and keep a copy
  of it built as its own bot, `petra_parity`, by `prepare-bot.ts` from the
  tag (a build step, not a second source tree). It is the fixed reference of
  every later stage.
- **Evolve `petra_ts` in place.** The 1:1 rule ends with the tag. Changes keep
  the tests green; a test that pins original behaviour the new bot changes on
  purpose is rewritten to the new behaviour with a note, or moved to a
  parity-only suite run against `petra_parity`.
- **Baselines for every measurement:** `petra_parity` (did this stage help?)
  and the original with `petra-fixes.patch` applied, built as `petra_fixed`
  (are we better than a fair Petra?). Since stage 5's checkpoint (§6.1) the
  strength comparisons use `petra_parity` alone: the two play the same games
  command for command (stage 1), and the checkpoint gave both the same 300
  results; `petra_fixed` stays for the parity tools (`parity-bisect.ts`,
  `baselines.ts hybrid`). The unpatched original is no baseline:
  `removeSupply` cripples it in every game (§10: it lost 9 of 10 and never
  reached town phase).

## 3. Type-driven architecture

### 3.1 Typestates for lifecycles the AI owns

Plans are the AI's own objects, so their transitions can be enforced. Today
`attackPlan.state` is a string with three constants
(`unexecuted`, `completing`, `arrived`) and ad-hoc values (`"walking"`,
`"transporting"`, `""`), and `transportPlan.state` is `boarding`/`sailing`.

- Model each plan as a discriminated union of states, each carrying the data
  valid in it:
  ```ts
  type AttackState =
  	| { kind: "preparing"; queues: TrainingQueues; rallyPoint: WorldPos }
  	| { kind: "walking"; path: WorldPos[]; target: TargetRef }
  	| { kind: "transporting"; transport: TransportPlanId; target: TargetRef }
  	| { kind: "arrived"; target: TargetRef }
  	| { kind: "withdrawing"; to: WorldPos }
  	| { kind: "done"; outcome: "won" | "aborted" };
  ```
- Transitions are functions from one state type to the next
  (`launch(p: Preparing): Walking | Transporting`), so an illegal transition
  does not type-check; the plan holds the current state and switches on
  `kind` with an exhaustive `never` default.
- Order: attack plans (most states, most bugs: `Abort` at sea, the withdrawal
  into a civic centre), then transport plans, then construction and training
  plans and queue items.
- Serialization: each state serializes to a tagged record; `Deserialize`
  validates the tag and rebuilds the state, or rejects the save (constraint 4).
- **Done in stage 2, the state kind:** `attackPlan.ts` declares
  `AttackTransitions` (each state and the states it may move to; the values
  are the strings Petra saves, with names now for `"walking"`,
  `"transporting"` and the attacking `""`), `state: AttackPlanState`, and
  `changeState(from, to)`, which only type-checks for a listed move and warns
  if the plan is not where its caller says. `Deserialize` parses the saved
  tag and sends a plan with an unknown one back to preparation.
- **Deferred, the data per state:** in Petra's logic the data spans the
  states (the target is chosen and updated in all of them, the path is
  computed while preparing), so moving it into the states changes the logic,
  not only its types. It goes with stage 4, where the withdrawal and the
  attack's handling are rewritten anyway.
- **Done in stage 5, the data per state that moves no game** (24 of 24 smoke
  games and the island game the same): the attack plan's `stage`
  (`AttackStage`) holds the preparation (its three queues, build orders and
  siege state) in `unexecuted` and `completing` and the path in `walking`;
  the queues go when the plan sets off, and a plan saved after it set off no
  longer looks them up on loading (that threw). The transport plan's `stage`
  (`TransportStage`) holds in `boarding` the boarding points, the tries and the
  units to split off, in `sailing` the landing points, the unloaded and
  recovered units and the cancel. A queue plan's `canStart` returns its start
  (`PlanStart`) holding what the check found, the buildings to train or
  research at (never empty for training), or undefined; the queue manager runs
  it when it pays. A building's spot stays sought at the start: a building
  without room is dropped from its queue all the same, which a check before
  paying would change.
- **Left for stage 6, the target per state** (`TargetRef` in `walking`,
  `transporting`, `arrived`, as sketched above): Petra chooses and updates
  the target in every state, preparation included, so moving it changes the
  play; it goes with the attack's rewrite.

### 3.2 Parsing what the AI only observes

Unit and world state cannot be typestates (constraint 2). Instead, each turn:

- **Parse** the raw state into discriminated unions at one boundary, the
  engine adapter: `unitAIState()` strings like `INDIVIDUAL.GATHER.RETURNINGRESOURCE`
  become `{ kind: "gathering"; phase: "returning"; dropsite: EntityId }` and
  so on, with an `{ kind: "other"; raw: string }` case for states not modelled.
  The port already found that the engine can report no state at all (§2:
  `requireValue` on `unitAIState()` threw every turn), so "unknown" is a case,
  not an exception.
- **Reconcile intent with observation.** The AI keeps what it ordered (an
  intent per unit) and compares it with the parsed state; "ordered but not
  doing it" is a normal case with a handler (re-order, re-plan, give up),
  handled exhaustively. Two known weaknesses are exactly this gap: builders
  re-sent their orders every update while walking home (§4), and an army
  walking for good to an unreachable point (§4, `Abort`).
- **Refusals.** A command whose effect does not appear within a few turns is
  treated as refused; the notices (`notices.txt`) give the reasons while
  debugging, but the AI cannot rely on them.

### 3.3 Branded and phantom types

Brand the primitives that are mixed up today or easily could be:

| Brand | Replaces | Bug class it closes |
|---|---|---|
| `EntityId`, `PlayerId` | both `number` | passing one for the other: the game's `CanPlayerOrAllyControlUnit` does exactly this (`upstream/petra-fixes.md`, Part 3) |
| `TemplateName` (and civ-applied `ResolvedTemplate`) | `string` | using `structures/{civ}/field` where the civ-applied name is needed |
| `TechName` (stage 4, 3.5) | `string` | looking a technology up as an entity template: `getTemplate` returns a `Technology` for it, and `QueuePlan<T>` keeps the two apart |
| `ClassName`, `ClassList` | `string`, `string[]` | the original's `byClass(["Palisade", "Wall"])`, which never matches (§1) |
| `WorldPos` (`[x, z]` in metres) | `number[]` | |
| `CellIndex<Map>` (phantom: which InfoMap/grid) | `number` | indexing one map with another's cell index; cell sizes differ (territory, passability, accessibility) |
| `AccessIndex`, `SeaIndex` | `number` | comparing a land region with a sea index |
| `GameMs`, `GameSeconds` | `number` | `elapsedTime` is seconds, the timer and commands use milliseconds |

Done in stage 2, all of them, in `petra_ts/brands.ts`. Two notes from doing
it: a time loses its brand in arithmetic (`elapsedTime + 20` is a plain
number, marked again with `seconds()`), so the brand guards what a time is
stored as, not every sum; and a record keyed by a `for...in` key keeps
`number` keys, since a branded key cannot index it (a `Map` would, but it
iterates in insertion order where an object lists integer keys in ascending
order: a behaviour change, for stage 3).
Conversions live in one module (`gamePosToMapPos` and friends) and are the
only way to cross between brands. Brands cost nothing at runtime (they are
intersections with a phantom tag, erased by `tsc`).

### 3.4 Module boundaries

```
adapter/    engine state in, commands out: parse (3.2), brands (3.3), the
            command builders (typed by the commands union in engine-api.d.ts)
world/      the AI's model: bases, resources, threats, maps; read-only to the
            layers above (readonly types)
decision/   what to do: economy, build order, military; swappable
execution/  plans with typestates (3.1): turns decisions into commands,
            reconciles intent with observation
```

- Only `adapter/` touches `Engine`, `gameState` and raw entities; `decision/`
  sees `world/` through readonly interfaces, so a decision layer cannot
  mutate the model or issue commands directly.
- **Decision engines that fit the budget:** utility scoring (per-turn,
  bounded work, easy to tune from match data) as the first replacement for
  Petra's hand-written thresholds; behaviour trees or goal-oriented planning
  for multi-step military behaviour. **Search** (MCTS and similar) is not
  feasible as the main engine: there is no forward model of the game in the
  AI context and the turn budget is small. It is feasible in narrow, cheap
  models: a build-order planner over a resource-rate model, or a
  fight-outcome estimator over unit stats, each run rarely and time-boxed.
- The port is reshaped into these layers gradually (stage 3), not rewritten:
  each move keeps the tests and the integration match green.

### 3.5 Type hygiene

The port compiles under `strict`, but strict mode lets some holes through.
A review in stage 4 (`FINDINGS.md` §17) closed most of them: no `as` cast
outside `adapter/brands.ts`, no `!`, no `any` (written or inferred), no reads
of common-api's private fields, typed save data, `TechName` apart from
`TemplateName`. The second round, in this order, is done too (every step
with the integration match's fingerprint unchanged, and a 24-game batch
identical game for game before and after):

1. **Done.** `Template.get(path)` returns `unknown`; the footprint (seven
   copies of the same code), the obstruction shapes and the attack bonuses
   are read by `adapter/templateData.ts`. The bonuses' declared type was
   wrong (an array of numbers; the template holds an object of strings).
2. **Done.** No `any` left in the declarations: `ResourcesManager` is its
   methods intersected with `{ [resource: string]: number }` (a class whose
   methods share its object cannot type its string index), the metadata
   writes are typed by key as the reads were (which found `transporter`
   declared an entity id: it is a transport plan's), `queryInterface` is
   `unknown`.
3. **Done.** `UnitPlan` (`AttackPlanId | -1 | -2 | -3`) for the `plan`
   metadata, `AttackPlanId` a brand; `execution/unitPlan.ts` names the
   three states (out of any plan; lent while it had one; lent while it had
   none) and the lend and release the defense army and the garrison
   manager each wrote out.
4. **Done.** Queue names: `ConfiguredQueueName`, the attack plans'
   `` `plan_${number}` `` (with `_champ`, `_siege`), the collection typed
   by them; the queue manager walks its queues lazily in their own order.
5. **Done** (stage 5, 2026-11-04; the 1703 tests on both targets, the 24
   smoke games and the island game's fingerprint identical): no method over
   150 lines (19 were). Split by what each part does, the parts named:
   the attack plan's update (`updateAttacking`, each attacker's order),
   preparation (`fastenEndGame`, `gatherAtRallyPoint`) and constructor (the
   army each attack type aims at, `attackComposition`, a function: stage 6's
   composition work starts there); the worker's update and `startGathering`
   (own base, reachable bases, a new dropsite, oversea, far away); the
   managers' `checkEvents` by event (`on<Event>`); the transport plan's
   boarding and sailing (`sendToShip`, `checkBoardingShip`,
   `checkBoardingUnit`, `checkRecovered`, `checkUnloaded`, `landShip`);
   building placement (`specialPosition`, `placeInfluence`,
   `restrictPlacement`, `overseaDockScore`); a civic centre's spot
   (`ccSpotNeighbours`, `ccSpotSpread`); builders (`assignToFoundation`,
   `assignToRepair`, sharing a `BuilderCrew`); defense (`onArmyUnitAttacked`,
   `retaliate`); garrisons (`onEntityRenamed`, `updateGarrisonList`,
   `threatsAround`); the attack manager's update (upcoming, started, new
   plans); `moveApart`'s two copies of the idle ship's move one method.
6. **Done.** `===` throughout (531 by the checker's types, where the two
   operators cannot differ; the rest read one by one), the aliases for the
   inline `import()` types, no `for...in` over arrays, the attack records
   keyed by `AttackType`. The records keyed by player or entity id stay
   objects: a `Map` would change their iteration order (stage 5).
7. **Done.** "Nothing found" is `undefined`, not `null`; the plans' saves
   typed in `QueuePlan`; module constants `const` (an importer cannot
   reassign another module's `let`, so the mods' reason did not hold).
8. **Done** (stage 5, 2026-11-04; see `build/petra_ts/STAGE_HISTORY.md` and
   `FINDINGS.md` §32): `declare` fields and two-step `init`/`Deserialize`
   set-up eliminated. Objects are made whole by their constructor or a
   `restore`/`start` factory from explicit inputs (`Geography`, the fleet,
   `canBuildUnits`), never via `gameState.ai.HQ` while being built;
   `gameAnalysis` keeps only first-turn actions (`answerStartingStances`,
   `findCriticalEnts`); `AttackPlan.create` and `TransportPlan.create`
   factories return `undefined` rather than a failed object; the worker's
   per-unit fields became a `UnitWork` per unit. Only one `declare` field
   remains in the port: `PetraBot.player` (set by `BaseAI`). `SAVE_VERSION` 3.

A third round (done, the same checks, the 24 games identical again):
`BaseId`, `ArmyId`, `TransportPlanId` brands (with `NO_BASE`, and `NEW_BASE`
and `NEW_ANCHORLESS_BASE` for the foundations that found a base); plan
metadata typed as the entity metadata it becomes (`PlanMetadata extends
Partial<PetraEntityMetadata>`; `train`/`construct` take it); `WorkerRole`
and `WorkerSubrole` unions for `role`/`subrole`; `plansIn()` for the loop
over every attack plan; no callback restating its types; `debugWarn(config,
level, () => message)` for the single-warning debug guards; and
`noUnusedLocals` on for the port, after removing what it found (unused
imports, a loop the original also left doing nothing, unused test names).

## 4. Performance: measure first

- **Measure** (done, stage 3): the engine times each AI's script call when
  `PYROGENESIS_AI_TIMES` names a file (`match.sh -P`): two `timer_Time()`
  reads around the shared component and each player's `Run`, kept in a
  preallocated vector and written once when the game ends. One timed call
  costs about 27 ns (two clock reads and a store) against a median AI turn of
  about 0.5 ms; nothing is printed during the game, and no bot code changes,
  so the times are the bot's and the game is the same. Wall-clock times
  include garbage collection (as in a real game) and the machine's load:
  measure with few jobs at a time.
- **Baseline** (stage 2's bot, 20 mirror games, mainland, very hard, 4 at a
  time; 193,206 turns): the whole turn (shared component and both AIs) takes
  1.96 ms on average, median 0.60, 99th percentile 12.5, 99.9th 68, at worst
  351 ms; the 99th percentile grows from 7 ms in the first ten minutes to 34
  ms at 30–40 minutes. In the mirror games the two sides' 99.9th percentiles
  differ by a third (41 and 30 ms): the games are not symmetric.
- **Budget**, so a paired test: the new bot plays `petra_parity` from both
  slots (`batch.ts --red petra_parity -- -P`, then `ai-times.ts --compare`);
  while a refactor keeps the fingerprint the two play the same games, and each
  turn is timed for both on the same game at the same moment. The new bot's
  mean and 99th percentile may be at most 5% above `petra_parity`'s, its 99.9th
  at most 10%. Stage 3 so far (20 games, 208,906 turns each): ratios 1.002
  (mean), 0.994 (99th), 1.001 (99.9th), the same games in all 10 seed pairs;
  with the execution layer behind `hqOf` (20 other games, 203,382 turns
  each): 1.010, 1.001, 1.024, again the same games in all 10 pairs. The
  single worst turn varies by run (ratio 0.99 and 1.16), so it is no budget.
  With the world state moved into `world/` behind accessors of the old names,
  the check failed: 1.052 (mean), 1.096 (90th), 1.042 (99th), the accessors
  being read on hot paths (`territoryMap` about 90 times, the supply lists in
  the worker's searches). With the port reading the world objects directly
  (the accessors kept for saves and tests), the same 20 games give 1.007,
  1.011, 0.997 and 0.989 (99.9th). So the check catches a few percent.
  Once the bot plays differently (stage 4 on), the games are no longer the
  same and the comparison needs more games.
- **At stage 5's close** (2026-11-04, `FINDINGS.md` §47; 20 games against
  `petra_parity`, different games now, so absolute figures): each bot's own
  time per turn, mean 1.30 ms against 0.25, 99th 15.8 against 4.0, 99.9th
  150 against 11; the whole turn 2.75 ms mean, 99th 20.8, 99.9th 150 (stage
  2: 1.96, 12.5, 68). The 99.9th comes from four games of 20 where every HQ
  turn costs 50-470 ms for 5-10 minutes: an attack plan holding about 150
  units at its rally point, then HugeAttack plans made and aborted every
  1.5 s with the whole army in them. This is stage 6's reference: its
  planner and estimator are measured against `petra_prev` (the stage 5
  bot) with `ai-times.ts --compare`, and the held army is fixed first.
- **Optimise only what the profile shows.** Likely candidates, from the code:
  `updatingCollection` filters re-evaluated per call, entity scans per turn,
  repeated territory/accessibility lookups. Object pooling is not planned:
  the engine hands the AI a fresh copy of the state each turn anyway, so GC
  pressure from the AI's own temporaries is only worth attacking if measured.
  `readonly` types (3.4) are for correctness, not speed.

## 5. Validation

### 5.1 Parity of the frozen baseline

- Diff the command logs (`match.sh -l`, `commands.txt`) of `petra_parity` and
  `petra_fixed` on fixed seeds, slots swapped too (`-x`); the first differing
  line is the next thing to explain. Already shown once: with only
  `removeSupply` patched into the original, its 10313 commands matched the
  port's for the whole run compared (§10).
- Target: identical command logs on a set of seeds (say 10, mainland, very
  hard), or every difference explained in `FINDINGS.md` §3.
- **Done (stage 1, `FINDINGS.md` §14):** identical logs on 26 seed pairs from
  both slots. Every difference found was a bug of the original the port had
  fixed, now in the patch (15 fixes). Tools: `batch.ts -- -l` with
  `--slots both`, `command-diff.ts <batch>` (each pair's two logs must be
  the same), `parity-bisect.ts` (hybrids of `petra_fixed` with one port module
  find the module that makes a difference). Rerun the batch when the patch or
  the tag changes; a new difference is a stage-1 item again.

### 5.2 Every change

- **Format first.** After editing Petra TypeScript sources, tests, declarations
  or tools, run `npm run format:petra` before every typecheck or test run and
  before committing. `npm run format:petra:check` is the non-mutating check;
  the Petra test/coverage npm scripts and pre-commit run it automatically.
  Formatting is limited to `petra_ts/**/*.ts` and `build/petra_ts/**/*.ts` by
  `dprint.json`, never generated bots or match/batch output.
- `npm run build:petra`, `npm run typecheck:petra:tests`, `npm run test:petra`
  and `npm run test:petra:out`.
- `npm run test:petra:match`: the fixed match and its anomaly checks; the
  fingerprint is printed, not asserted (any behaviour change moves it).
- `npm run test:petra:smoke`: 24 fixed games (12 seed pairs from both slots,
  `petra_out` against `petra_parity`, about 3 minutes) compared game for game
  with the recorded `build/petra_ts/smoke/reference.tsv`. A refactor must
  leave all 24 identical; a change meant to alter play lists the games it
  moved, and is recorded with `--update` in the same commit. It is a check
  that play did (not) change, not a measure of strength (5.3).
- Determinism: the integration match run twice gives the same fingerprint.
- Save/load: the persistence round trips in the tests (`persistence.ts`),
  plus an in-game check once a stage touches serialized data: save at a
  minute, reload, play on (to define: a scripted autosave in a headless run).

### 5.3 Strength

- **Pool:** maps (mainland first; then a few of different kind: a naval map,
  a forest-heavy one, a small one), civilisations (start with athen, then a
  sample), difficulty very hard, both slots. Fixed seed lists per pool, so a
  result is reproducible.
- **Statistic:** win-rate against each baseline, with a Wilson confidence
  interval; for go/no-go decisions, a sequential probability ratio test
  (SPRT) between H0 = 50% and H1 = the gain worth having. Rough sample sizes
  for a fixed one-sided test at α = β = 0.05: about 1080 games to tell 55% from 50%,
  about 270 for 60%; SPRT needs on average roughly half. Time-limited games
  (`-T`) count as draws, or are excluded and reported.
- **Supporting metrics,** from the existing records: time to town and city
  phase; resources gathered and used per minute; units lost per enemy unit
  killed (and in value, `unitsLostValue`); peak and mean map control; idle
  workers (timeline); commands per minute (commands log). They explain a
  result; the win-rate decides.
- **Against the previous version:** `petra_prev` ("Petra TS previous",
  `baselines.ts prev`) is the port at the tag `petra-ts-prev`; each stage-5
  change plays it head to head, on a seed pool it was not tuned on, and the
  tag moves to a change once it is kept.
- **Early proxy** (`pair-score.ts`): blue's lead in resources gathered (and
  units trained) at minute 8, the mean of a seed pair's two games. A bot that
  plays as its opponent until then scores exactly 0, so the score has no
  noise of its own and shows a change to the start after a few dozen pairs
  (`alpha` 0.6: +111 ± 96 over 93 pairs, where the win-rate showed nothing);
  the side ahead in gathering at minute 8 won 79% of stage 4's games. It
  chooses which variants deserve an SPRT; it decides nothing.
- **Throughput:** `batch.ts` runs games in parallel, each job with its own
  `XDG_*` folders: at 12 at a time, 50–60 s of wall time per game, about 100
  games in 8 minutes (1000 games in under 1.5 hours). Results go to one table
  (`results.tsv`: seeds, slot, bots, outcome, decision time, metrics).
- **Same starts:** `random/mainland_mirror` gives both players the same land
  (one half turned onto the other). The start's layout turned out to be a
  small part of the noise: on it half the seed pairs still split, and the
  interval is as wide as on Mainland (`FINDINGS.md` §22). It checks that a
  gain does not depend on unequal starts; Mainland decides.
- **Slots:** player 2 wins more mirror games (42.2% for player 1, CI
  35.6–49.0%, §13). Compare two bots only from both slots (`--slots both`,
  the default for two bots), never from fixed ones.
- **Crashes:** the engine aborts in about 1 game in 150 (a futex error, not
  reproducible); `batch.ts` books it as failed and a resumed batch replays it.
  If it gets more frequent with more jobs, look into the engine.

### 5.4 Property-based tests

On the existing harness (fake worlds, real InfoMaps): generate worlds and
assert invariants rather than examples. A generator library would be a
dev-only dependency (tests run on Node, not in the engine). Candidates:

- a planned building never overlaps an obstruction and lies in own territory;
- every worker ends a turn with a role and a reachable target, or idle;
- a withdrawal or rally point is reachable (would have caught `Abort`);
- serialization round-trips any reachable plan state (3.1);
- resource accounts never go negative, and reserved never exceeds owned.

## 6. Roadmap

Each stage ends on a measurable exit criterion; strength claims use 5.3.
Full details of completed Stages 0–5 live in `build/petra_ts/STAGE_HISTORY.md`.

| Stage | Work | Exit criterion |
|---|---|---|
| 0. Baselines (**done** 2026-10-25, `FINDINGS.md` §13) | Tag `petra-ts-parity`; build `petra_parity` and `petra_fixed`; parallel headless batches (`batch.ts`) | Met: 315 mirror games at 12 jobs without clash, 15/15 repeats deterministic, 51.0% vs `petra_fixed` (CI 41.5–60.4%) |
| 1. Parity proof (**done** 2026-10-25, `FINDINGS.md` §14) | Command-log diffs on fixed seed sets (5.1) | Met: identical logs across 26/26 seed pairs (52 games) with 15 original bugs in `upstream/petra-fixes.patch` |
| 2. Types in place (**done** 2026-10-25) | Branded types (3.3) and `AttackPlanState` typestate transitions (3.1) | Met: typecheck clean, 1,533 tests pass, integration match fingerprint `2164cc14d7c5e28f` unchanged |
| 3. Layers (**done** 2026-10-26, `FINDINGS.md` §15) | Reshape into `adapter/`, `world/`, `decision/`, `execution/`; `unitState.ts`, `commands.ts`, `hqOf`, `SAVE_VERSION` | Met: fingerprint unchanged; paired turn times within 5% mean/99th and 10% 99.9th budget (4) |
| 4. Fix the known weaknesses (**done** 2026-10-27, `FINDINGS.md` §16) | Fix withdrawal footprint, mercenary workers, garrisoned units holding attacks, pop-cap attack churn, and 6 original bugs; type hygiene (3.5) | Met for tests (every fix pinned); win-rate 50.3–50.5% vs `petra_parity` (+12% gathered), carried to stage 5 |
| 5. Utility decisions (**done** 2026-11-04, `FINDINGS.md` §§18–46, tag `petra-ts-stage5`) | Fix order reading, early fields/houses/queue funding/women share, research payback, barracks scaling, island/naval play, data-carrying stages (3.1), and constructor-only setup (3.5) | **Met** (§6.1): checkpoints 78.7%, 92.3%, and **95.0%** vs `petra_parity` (285/300, CI 91.9–96.9%) |
| 6. Narrow search | First the attacks' and the ships' handling (§6.2: the army held at its rally point, the HugeAttack churn, a started attack's per-unit work, stuck ships); then the build-order planner and fight estimator (3.4), time-boxed | Gain vs stage 5 (SPRT); turn budget kept |

Running throughout: determinism and save/load checks (5.2), `FINDINGS.md`
for what each stage finds, and upstream reports for bugs that are the
original's or the game's (`build/petra_ts/upstream/`).

### 6.1 Stage 5: what it did, and what it leaves

**Closed** (2026-11-04, tag `petra-ts-stage5`, which `petra-ts-prev` names
as stage 6 begins; full step-by-step history in
`build/petra_ts/STAGE_HISTORY.md`). Kept, each measured against the version
before it on fresh seed pairs: the units' orders read again (§18), the first
field by what berries bring in (§20), the house before the training queues
(§22), the best plan paid from the split accounts, the women before the
soldiers and their share 0.5 (§24-26), research by payback and one more
barracks while the barracks are busy (§28-29), then the islands: naval
attacks, routes and landings, dry towns, towers over the enemy's sea
passages, a hunting fleet (§34-45). Checkpoints against `petra_parity`:
78.7%, 92.3%, **95.0%** (pool seed 43, CI 91.9-96.9%). The economy scoring
module covers research (`decision/economyScore.ts`), and pure economy rules
live in `decision/housing.ts`, `fields.ts`, `dropsites.ts`, and
`workforce.ts` over `world/census.ts` (§31). The workers' target by payback
was tried and reverted (§46: 50.2%), and the same 300 games show why the
rest waits: the two sides are equal at minute 9, the winner has some 20
soldiers more at 13 and the loser has collapsed by 17, so the lever is the
first big army and when it fights (stage 6's fight estimator). The port's
structure was finished alongside (3.1's data per state where it moves no
game, 3.5's long methods and two-step set-up). The turn time at the close is
in §4.

### 6.2 Stage 6: where it starts

Stage 5's last measurements (`FINDINGS.md` §47-49) and the user's watch of
visual games ("ship management and attack planning still looks funny") put
four items before the planner and the estimator. Each is measured as any
change (against `petra_prev`, now the stage 5 bot, on fresh pairs; islands
for the ships), with the turn times of `match.sh -P` (`turntimes.txt`, §4)
beside the win-rate:

1. **The army held at its rally point** (§47, §49): a plan that may start
   and does not, drafting far past its maximum. Find why it waits (the
   targets reading 0 once it is over its maximum, `mustStart`, the
   population rules), cap what it drafts, and start it when it can.
2. **The HugeAttack churn** (§6.1's table, §47, §49): plans made and aborted
   within seconds, the whole army drafted and released each time. A plan
   that cannot find a target or start should not be made again at once,
   nor take the army with it.
3. **A started attack's per-unit work** (§48, §49): 50-85 ms on the turn an
   army reaches its target. Spread the target choice over turns or cap it
   per turn, so no turn of the attack goes past the budget.
4. **Stuck ships** (§45, §49): a ship judged stuck only when it neither
   moves nor turns for 5 s; one that circles or shuttles without getting
   anywhere is not caught, and the same garrison and unload orders are sent
   thousands of times. A stuck test by progress toward the ship's goal over
   time, and an escalation when it fails (another route or boarding point,
   another ship, the plan released), measured by the orders sent per
   transport and the island games' draws.

Progress (2026-11-07): items 1 and 2 were one bug, the garrison loop that
emptied every plan for a tower it could not fill (`FINDINGS.md` §50; fixed;
a draft cap and an earlier start were tried first and lost). Item 3: the
arrival turn's sort made cheap with no play change, the worst AI turn of
§48's long games from 97 to 40 ms (§51). Item 4: the ships' garrison and
unload totals are mostly ordinary transport work; the repeats were towers
letting workers in and out as enemies passed (§52): fixed for unarmed
targets; a threat memory for armed ones was measured and dropped (47.5%
mainland, 47.4% islands). Ships: a 5 s position log (`ships.txt`,
`ship-log.ts`) found transports stalled for up to an hour; a headway test,
a nudge for wedged ships and failed landing points avoided end the sailing
stalls (§53: 53.1% on islands, no loss); the same nudge at the boarding
stage (§54: 48.5%, no loss, boarding stalls about halved). `petra-ts-prev`
names b06a06459e.

Then the build-order planner and the fight estimator (3.4), where the
attack timing of §46 is decided.

## 7. Open questions

- Answered in stage 3: the AI context offers no clock; the engine times the
  AI's calls instead (`match.sh -P`, 4).
- Answered in stage 0: `XDG_*` per run is enough to isolate parallel engines
  (config, cache, replays and logs all follow it); `-writableRoot` is not
  needed (5.3, `FINDINGS.md` §13).
- Why player 2 wins more mirror games (5.3).
- Which civilisations and maps make the pool, given the time per game.
- Answered in stage 3: the original is no test target once the port is in
  layers; the frozen port's parity is shown in games (stage 1).
