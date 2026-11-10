# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Repository

0 A.D. (engine "Pyrogenesis"): a C++ engine in `source/` and the game itself as
JavaScript/XML/JSON mod data in `binaries/data/mods/` (`mod` = engine-level
GUI/global scripts, `public` = the game). Upstream docs live on the Gitea wiki
(BuildInstructions, GettingStartedProgrammers).

The work here is a **TypeScript port of the Petra AI** and its behaviour-test
suite, under `binaries/data/mods/public/simulation/ai/`, and its evolution into
a stronger AI.

- **`PLAN.md` is the project's goal and plan**: constraints (`§1`), baseline
  strategy (`§2`), type-driven architecture (`§3`), performance budget (`§4`),
  validation (`§5`), and Stage 6 roadmap (`§6.2`). Read only the sections
  relevant to your task. Completed Stage 0–5 history lives in
  `build/petra_ts/STAGE_HISTORY.md`.
- **`build/petra_ts/README.md`** documents `match.sh`, `batch.ts`, baselines,
  parity tools, state/economy/attack logs, and `quality.ts` / `structure.ts`
  details. Read it only when running matches, batches, or baselines.
- **`petra_ts/tests/FINDINGS.md`** (2,100+ lines) records bugs, differences, and
  match measurements. Search it with `grep` and read specific sections with
  `offset`/`limit` rather than reading the entire file.

## Commands

### Engine (C++)

```sh
libraries/build-source-libs.sh            # bundled third-party libs (once)
build/workspaces/update-workspaces.sh     # premake -> build/workspaces/gcc/
make -C build/workspaces/gcc -j$(nproc)   # binaries land in binaries/system/
binaries/system/test                      # cxxtest runner (also runs JS component tests)
binaries/system/test --suite <Suite> [--test <name>]   # one suite / one test; --list
```

### Linting and formatting

- `npm run lint` / `npm run lint:fix` — ESLint for the game's **JS** (tabs, see
  `.editorconfig`). It does not lint `.ts` files.
- `npm run format:petra` / `npm run format:petra:check` — dprint for the Petra
  port, tests, declarations and TypeScript tools (`dprint.json`; generated bots
  and match/batch outputs are excluded).
- `pre-commit run --all-files` — CI hooks (ruff, shellcheck/shfmt, markdownlint,
  yamllint, eslint, dprint, non-breaking space in "0 A.D." under `binaries/`).

### Petra TS port

**Mandatory for coding agents:** after editing Petra TypeScript sources, tests,
declarations or tools, run `npm run format:petra` before every typecheck or test
run and before committing. Format again after any later edits. See `AGENTS.md`.

```sh
npm run format:petra                 # apply required formatting first
npm run format:petra:check           # verify without modifying files
npm run typecheck:petra:tests       # typecheck tests + harness + port; clean
npm run build:petra                 # strict typecheck of the port alone (noEmit)
npm run build:petra:out             # build "Petra TS" bot into simulation/ai/petra_out/
# one file / one test while iterating (tests/run.ts preloads harness/setup.ts):
npm run test:petra -- <name>.test.ts --test-name-pattern="<regex>"
npm run test:petra:out -- <name>.test.ts
# full suite (use --test-reporter=dot to avoid 1700+ lines of stdout):
npm run test:petra -- --test-reporter=dot
npm run test:petra:out -- --test-reporter=dot
# real coverage, complexity/duplication, and layer/structure checks (scope with --file / --top):
npm run coverage:petra -- [src|out] [--file <module>]
npm run quality:petra -- [--file <module>] [--top 5] [--tests] [--renamed] [--json F]
npm run structure:petra -- --check [--top 0] [--update-baseline] [--json F]
# matches, smoke tests, baselines, and batches (see build/petra_ts/README.md for flags):
npm run test:petra:match            # fixed headless mirror match checked for anomalies (~80s)
npm run test:petra:smoke            # 24 fixed games vs petra_parity compared to reference (~3m)
npm run build:petra:baselines       # build petra_parity and petra_fixed (gitignored)
npm run match:petra -- [options]    # headless or visual match (build/petra_ts/match.sh -h)
npm run batch:petra -- [options]    # parallel headless matches + SPRT/Wilson stats
npm run test:petra:tools            # unit tests for batch-stats, quality, and structure
```

- Use `coverage:petra` (`tests/coverage.ts`), not `test:petra:coverage`: Node's
  built-in line figure counts never-run branches as covered.
- `quality:petra` enforces max per-function thresholds: **96 lines, cyclomatic
  15, cognitive 25, nesting depth 4, 5 parameters**, and **0 duplicated code
  clones** (>= 60 tokens over >= 6 lines). Split long functions by
  extract-method keeping smoke games identical.
- `structure:petra -- --check` enforces: no `as` cast outside `adapter/brands.ts`
  (`as const` apart), no `!`, `Engine.PostCommand` only in `adapter/commands.ts`,
  no code below the root reading `gameState.ai.HQ`, no `execution/` code
  importing `decision/headquarters.ts`, and holds baseline
  counts in `build/petra_ts/structure-baseline.json` at **0** (layer violations
  across `adapter < world < execution < decision < root` including type-only
  imports, value-import cycles, `Engine` outside `adapter/`, unmarked dead
  exports/methods, stale `TODO never called` markers). No module may export what
  only it uses. Also at **0**, type-checked: `layer-access` (a higher layer's
  members reached without an import, however reached: `gameState.ai.HQ` from
  `adapter/` or `world/`, a decision manager's method from `execution/`).
  `view-only` (rule): no decision module imports `AttackPlan` (decision sees
  `AttackPlanView`; `VIEW_ONLY` in `structure.ts`). `whole-hq` (at **0**):
  values typed as the whole `Headquarters` outside it and the root. Cohesion
  is ratcheted in `build/petra_ts/cohesion-baseline.json`: each class's core
  LCOM4 (forwarders apart, only collaborators as hubs) and each
  class-with-parts' LCOM4 may not rise; a new class may have 4. Lower the
  baselines with `--update-baseline` when a class improves.
  It also reports, untracked (`build/petra_ts/coupling.ts`): each class with its
  parts (functions taking it) as one LCOM4 graph plus the fields only one module
  uses, and the types other modules read narrowly (≤ a quarter of their members).
- TypeScript configs are in `build/petra_ts/` (`tsconfig.json`,
  `tsconfig.build.json`, `tsconfig.tests.json`). **Never put a `.json` file
  under `simulation/ai/`** other than a bot's `data.json` (`ICmpAIManager.cpp`
  lists every `*.json` there as a bot).
- For full details on `match:petra`, `batch:petra`, `test:petra:match`,
  `test:petra:smoke`, baselines (`petra_parity`, `petra_prev`, `petra_fixed`),
  state logs (`-b`, `-l`, `-t`, `-P`), and parity tools, read
  `build/petra_ts/README.md`.

## Petra architecture (`simulation/ai/`)

- `common-api/` — shared, engine-facing JS (not part of the port):
  `SharedScript` (entities, templates, terrain/accessibility, resource maps),
  `GameState`, `Entity`/`Template`, `EntityCollection`, `filters`, `BaseAI`.
- `petra/` — the original JS bot (reference only; untouched).
- `petra_ts/` — the port, in layers (`PLAN.md` §3.4):
  - Root: `_petrabot.ts` and `.d.ts` declarations (`engine-api.d.ts`,
    `common-api.d.ts`, `globalscripts.d.ts`, `petra-runtime.d.ts`).
  - `adapter/` (engine boundary): `brands.ts`, `entityExtend.ts`, `chatHelper.ts`,
    `unitState.ts` (parses what a unit is doing), `orders.ts` (reads what it was
    ordered to do), `commands.ts` (sole exit for bot commands), `pathfinder.ts`,
    `templateData.ts`, `placed.ts`, `debug.ts`. It reads no AI state
    (`gameState.ai.*`).
  - `world/` (AI's model): `config.ts`, `difficultyLevel.ts`, `mapModule.ts`,
    `mapMask.ts`, `geography.ts` (territory/border maps, land/sea regions and
    landing zones, owned by HQ), `gatherEconomy.ts` (measured gather rates including walk,
    owned by HQ), `production.ts` (measured trainer busyness, owned by HQ, not
    saved), `census.ts` (population vs room), `economyPlan.ts` (what the town saves for and where its
    food comes from, `HQ.economy`), `seaRoute.ts` (ship routing round
    enemy shooters), `shipTraffic.ts` (fading enemy ship heatmap on naval maps,
    places towers), `baseResources.ts` (dropsite supplies per base), `bases.ts`
    (read-only `BaseView`), `baseTerritory.ts` (which base each territory
    cell belongs to, owned by the bases manager, read as
    `gameState.ai.bases.territory`), `gatherTally.ts` (the turn's gatherers
    booked and the gather rates, owned by the bases manager, read as
    `gameState.ai.bases.tally`), `builders.ts` (which structures our units
    can build, owned and saved by the build manager, `buildManager.builders`),
    `captureTally.ts` (our units' capture strength per
    target, owned by HQ, exposed as `gameState.ai.captures`), `enemyLands.ts`
    (the enemies on each land, counted once a turn, owned by HQ, exposed as
    `gameState.ai.enemyLands`), `fishing.ts` (a shoal's sea and whether it
    is safe), `capture.ts`
    (`allowCapture`), `territory.ts` (territory helpers over
    `gameState.ai.geography`, the HQ's geography). World code reaches AI
    state only through such exposed world objects, never `gameState.ai.HQ`.
  - `decision/`: `headquarters.ts` (the HQ: its update, saves, and the queries
    other managers and execution use), the HQ's parts as functions taking a
    view of it built on `TownState` (`hqEvents.ts`, `phasing.ts`,
    `workforceTraining.ts`, `houseBuilding.ts`, `townBuildings.ts`,
    `militaryBuildings.ts`, `expansion.ts`),
    `recruitChoice.ts` (`HQ.recruits`: which unit to train of those asked),
    `emergencyTraining.ts` (`HQ.emergencyTraining`: defenders trained at once
    when an army comes), `startingStrategy.ts`, managers (`attack`, `base`,
    `bases`, `build`,
    `defense`, `diplomacy`, `emergency`, `naval`, `research`,
    `trade`, `victory`), `enemySelection.ts`, and pure/utility
    modules (`foodSource.ts`, `economyScore.ts`, `housing.ts`, `fields.ts`,
    `dropsites.ts`, `workforce.ts`, `gatherSplit.ts`).
  - `execution/`: `attackPlan.ts` (the `AttackPlan` class: its state, saves,
    and the members others call) and its parts as functions taking the plan
    (`attackPreparation.ts` training and setting off, `attackDraft.ts`
    enlisting units, `attackTargeting.ts`, `attackMarch.ts` walking and
    transport, `attackFight.ts` arrival and target loss), `attackConstants.ts`
    (states, types, `plansIn`), `transportPlan.ts`, `defenseArmy.ts`,
    `queue.ts`, `queueManager.ts`, `queueplan.ts`, `queueplanBuilding.ts`,
    `queueplanTraining.ts`, `queueplanResearch.ts`, `worker.ts`, `unitPlan.ts`,
    `treasure.ts`, `captureOrders.ts` (capture or destroy, every 3 s),
    `town.ts` (`Town`, `HQ.town`: the execution layer's one door to the
    decision layer, with the turn's cache, gather needs and danger queries)
    and its desks `siteDesk.ts` (`town.sites`: builders, unbuildables, a
    market's worth), `placementSearches.ts` (`town.placement`: where to build,
    over the scoring of `placement.ts`; civic centre orders followed),
    and the core managers' desks, each made by its manager (`manager.desk`)
    and holding it through a view of what it asks: `attackDesk.ts`
    (`town.attacks`, the attack manager's, `AttackDecisions`: owns the attack
    plans, runs them, local fights, defense armies turned to attacks) with
    `bombardment.ts` (`town.bombing`, also the attack manager's: idle siege
    sent to bomb what is in range), `transportDesk.ts` (`town.transports`, the naval manager's,
    `NavalFleet`: owns the transport plans; ships) with `fishingDesk.ts`
    (`town.fishing`, also the naval manager's: a shoal's sea and safety, the
    report of a sea fished out), `defenseDesk.ts`
    (`town.defense`, the defense manager's, `DefenseDecisions`: raids, armies,
    shelter), `victoryDesk.ts` (`town.victory`, the victory manager's:
    critical units, relics) and `garrisonManager.ts` (`town.garrisons`, made
    by the defense manager, `GarrisonDefense`: garrison orders carried out and
    released). The town's own parts read the HQ through `TownHQ`, `SiteHQ`,
    `PlacementSearchHQ`. The town's plans are saved with the HQ (`town`).
- `petra_out/` — generated, gitignored ("Petra TS" bot, VFS imports rewritten by
  `build/petra_ts/prepare-bot.ts`).

Control flow: `_petrabot.ts` (`PetraBot extends BaseAI`) → on the first turn
`startingStrategy.analyseMap` creates `Geography`, `new Headquarters(config,
gameState, geography)` constructs all managers whole (no two-step `init`),
then the town from their desks, and
`gameAnalysis` runs first-turn actions; on load `Headquarters.restore` (and each
manager's/plan's `restore` factory) rebuilds from save data. Then one turn in
eight (offset by player id) `Headquarters.update` drives the managers and
`QueueManager` funds `queues` of plans by priority. `worker.ts` steers workers
via entity metadata (`role`, `subrole`, `base`, `plan`, `transport`, …) with a
`UnitWork` per unit.

## Petra tests (`petra_ts/tests/`)

Read `petra_ts/tests/README.md` before writing tests. Use `grep` + sliced `read`
(`offset`/`limit`) when inspecting large `.test.ts` files or `tests/FINDINGS.md`.

- The harness (`tests/harness/`) recreates the engine. `setup.ts` is preloaded
  (`--import`, via `tests/run.ts`): `hooks.ts` resolves VFS specifiers and swaps
  in `petra_out/` when `PETRA_TARGET=out`; `engine.ts` evaluates real
  `globalscripts` and records `Engine.PostCommand`/warnings (`commands`,
  `sent(type)`, `logs`).
- Tests import the port directly (`../execution/queue.ts`) and are typed by it:
  no local copies of port classes or types (export a type from the port when
  needed), branded values via `adapter/brands.ts`.
- Fakes: `fakes.ts` (`makeEntity`, `makeTemplate`, `emptyEvents`/`eventsWith`,
  `stubGlobal`/`restoreEngine`, `fake<T>()`, `override(target, { method })`),
  `world.ts` (`makeWorld`), `hqWorld.ts` (`makeHqWorld`/`seatHQ` with
  `doorStub`/`doorManagers`), `navalWorld.ts`, the suites' shared seats
  (`hqSeat.ts`, `navalSeat.ts`, `attackSeat.ts`), `bareState.ts`
  (`makeFakeGameState`), `diplomacy.ts` (`setPlayers`), `persistence.ts`
  (save/reload round trips).
- Fake entities and stubs **throw on any undeclared method**: declare only what
  the code under test asks for in the test itself.
- Every test fails if an attack plan moved from a state its caller did not
  expect (`changeState`'s warning in `harness/engine.ts`): set the realistic
  game state or call `allowMisplacedMoves()` in that test.
- Harness answers must match real `common-api` shapes (e.g. parsed template
  leaves are strings; `resistanceStrengths()` is `{ Damage: {...} }`).

### Conventions for this work

- Tests assert behaviour in realistic game situations, not implementation.
  Verify new tests reach the branch they name (`npm run coverage:petra -- src --file <module>`).
- Tests run on both `src` and `out`. Tests marked `// only the port passes: ...`
  pin original bugs and Stage 4–7 fixes (83 in all; see `tests/FINDINGS.md` §1).
- Port code must not silence the compiler with `as X` casts or `!`; use
  `requireValue` / `requireTemplate` / `requireMetadata` (`entityExtend.ts`)
  where the context guarantees a value, and remove guards that cannot fire.
- IDs, positions, regions, times, template/tech names, plan/base/army IDs, and
  grid cells are branded (`EntityId`, `PlayerId`, `WorldPos`, `MapPos`,
  `AccessIndex`, `SeaIndex`, `RegionIndex`, `GameMs`, `GameSeconds`,
  `TemplateName`, `TechName`, `AttackPlanId`, `BaseId`, `ArmyId`,
  `TransportPlanId`, `CellIndex<Grid>` in `engine-api.d.ts`).
  `adapter/brands.ts` holds the port's only sanctioned casts (`entityId`,
  `playerId`, `worldPos`, `landRegion`, `seaRegion`, `seconds`, `secondsOf`,
  `templateName`, `techName`, `attackPlanId`, `baseId`, `armyId`,
  `transportPlanId`, `cellIndex`, and sentinel constants `GAIA`,
  `INVALID_PLAYER`, `INVALID_ENTITY`, `NO_LAND`, `NO_REGION`, `NO_TEMPLATE`,
  `NO_BASE`, `NEW_BASE`, `NEW_ANCHORLESS_BASE`). Brand loop indices once (`const
  j = cellIndex(map, jIndex)`, `const i = playerId(iIndex)`); records keyed by
  `for...in` keep `number` keys.
- Fixed sets are union types: queue names (`PetraRuntime.QueueName`), attack
  types (`AttackType`, `ATTACK_TYPES`), unit `plan` metadata (`UnitPlan` in
  `execution/unitPlan.ts`), worker roles (`WorkerRole`, `WorkerSubrole`).
  Metadata reads/writes are typed by key (`PetraEntityMetadata`, `PlanMetadata`).
  Template data is read through `adapter/templateData.ts`.
- Debug warnings use `debugWarn(config, level, () => message)`
  (`adapter/debug.ts`). The port compiles with `noUnusedLocals`.
- Attack plan state changes only through `changeState(from, to)`
  (`AttackTransitions` in `attackPlan.ts`).
- Unit orders are read through `adapter/orders.ts` (`ordersOf`, `gatherRate`);
  fakes supply orders with `orders(...)` (`harness/fakes.ts`).
- Unit states are read through `adapter/unitState.ts` (`isInState`,
  `hasActivity`, `stateIs`, …), never by comparing raw `unitAIState()` strings.
- Bot commands go through `adapter/commands.ts` (`postCommand`, `debugShade`);
  only that module calls `Engine.PostCommand`.
- Saved data carries `SAVE_VERSION` (`_petrabot.ts`): increment it whenever a
  manager's saved shape changes.
- World state lives in `world/` objects owned by managers (`HQ.geography`,
  `base.resources`) and hot paths read them directly
  (`HQ.geography.territoryMap`, `base.resources.dropsiteSupplies`), while owners
  keep get/set accessors for saves and tests. Below `decision/` they are read
  through `gameState.ai` (`PetraRuntime.AIState`, getters on the bot and in
  the harnesses): `geography`, `bases` (`world/bases.ts` `BasesView`),
  `treasures`, `captures` (`world/captureTally.ts`), `enemyLands`
  (`world/enemyLands.ts`).
- Execution code (`execution/`) never reaches `Headquarters` or a decision
  manager's class: it uses the decision layer only through
  `gameState.ai.town` (`execution/town.ts`) and its desks, which hold their
  manager (or, for the town's own parts, the HQ) privately through a view.
  It reads bases through `gameState.ai.bases` and `world/bases.ts`
  (`BaseView`), and mutates them only through capability
  interfaces (`SupplyBooking`, `SupplyUpkeep`, `IdleWorkers`). A member
  execution needs is added to the town or a desk and its view, never reached
  through the HQ.
- Decision managers never read `gameState.ai.HQ` either: each takes, when
  built (and in its `restore`), a view of the HQ typed as what it uses
  (`AttackSiblings`, `ResearchHQ`, `NavalHQ`, `TradeHQ`,
  `DiplomacyHQ`, `DefenseHQ`, `VictoryHQ`, `BasesHQ`/`BaseHQ`: `Pick`s of
  `Headquarters` and of its other managers); the HQ passes itself. Its module
  functions take the one manager they ask. The HQ's part modules (and
  `startingStrategy.ts`'s first-turn functions) take a view too:
  `TownState` (`Config`, `canBuild`, `economy`, `currentPhase`, `phasing`)
  and the few members they add (`EventsHQ`, `PhasingHQ`, `ExpansionHQ`,
  `HousingHQ`, `TownBuildingsHQ`, `MilitaryHQ`, `WorkforceHQ`,
  `FirstBaseHQ`, `FirstBaseConfigHQ`, `FirstTurnHQ`). A member a manager
  needs is added to its view; an HQ part function it needs gets an HQ method (`onNewBase`,
  `expandFor`). A core manager talks to its own desk directly (`this.desk`,
  and the defense's `this.garrisons`); another manager's desk it reaches
  through `town` in its view. Decision code sees an attack plan only as
  `AttackPlanView` (`execution/attackPlan.ts`: name, type, state, target
  player, units, sea, rally point, `requested`, `forceStart`, `Abort`,
  `removeUnit`), handed out by `AttackPlanRegistry` (`attackDesk.ts`), and
  takes plan states and types from `execution/attackConstants.ts`, never
  from the class. The HQ builds its town after its managers,
  gathering their desks (a test that replaces a manager puts its desk in the
  town; `seatHQ` does so for the doors).
- Methods never called (in port and original) are marked
  `/** TODO never called ... */`.
- Port fixes go in a commit separate from tests. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
