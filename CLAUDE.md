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
  `execution/` reaching the HQ only via `execution/hq.ts`, and holds baseline
  counts in `build/petra_ts/structure-baseline.json` at **0** (layer violations
  across `adapter < world < execution < decision < root` including type-only
  imports, value-import cycles, `Engine` outside `adapter/`, unmarked dead
  exports/methods, stale `TODO never called` markers). No module may export what
  only it uses. Two type-checked run-time counts: `layer-access` at **0** (a
  higher layer's members reached without an import, e.g. `gameState.ai.HQ`
  from `adapter/` or `world/`) and `hq-manager-access` (52, may only fall:
  execution using members of the managers `hqOf` hands out).
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
    `mapMask.ts`, `geography.ts` (territory/border maps and land/sea regions,
    owned by HQ), `gatherEconomy.ts` (measured gather rates including walk,
    owned by HQ), `production.ts` (measured trainer busyness, owned by HQ, not
    saved), `census.ts` (population vs room), `seaRoute.ts` (ship routing round
    enemy shooters), `shipTraffic.ts` (fading enemy ship heatmap on naval maps,
    places towers), `baseResources.ts` (dropsite supplies per base), `bases.ts`
    (read-only `BaseView`), `captureTally.ts` (our units' capture strength per
    target, owned by HQ, exposed as `gameState.ai.captures`), `capture.ts`
    (`allowCapture`), `territory.ts` (territory helpers over
    `gameState.ai.geography`, the HQ's geography). World code reaches AI
    state only through such exposed world objects, never `gameState.ai.HQ`.
  - `decision/`: `headquarters.ts`, `startingStrategy.ts`, managers (`attack`,
    `base`, `bases`, `build`, `defense`, `diplomacy`, `emergency`, `garrison`,
    `naval`, `research`, `trade`, `victory`), `placement.ts`, `enemySelection.ts`,
    and pure/utility modules (`foodSource.ts`, `economyScore.ts`, `housing.ts`,
    `fields.ts`, `dropsites.ts`, `workforce.ts`, `gatherSplit.ts`).
  - `execution/`: `attackPlan.ts`, `transportPlan.ts`, `defenseArmy.ts`,
    `queue.ts`, `queueManager.ts`, `queueplan.ts`, `queueplanBuilding.ts`,
    `queueplanTraining.ts`, `queueplanResearch.ts`, `worker.ts`, `unitPlan.ts`,
    `treasure.ts`, `hq.ts` (`hqOf`, the execution layer's view of the HQ, and
    `basesOf`).
- `petra_out/` — generated, gitignored ("Petra TS" bot, VFS imports rewritten by
  `build/petra_ts/prepare-bot.ts`).

Control flow: `_petrabot.ts` (`PetraBot extends BaseAI`) → on the first turn
`startingStrategy.analyseMap` creates `Geography`, `new Headquarters(config,
gameState, geography)` constructs all managers whole (no two-step `init`), and
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
  `doorStub`/`doorManagers`), `navalWorld.ts`, `bareState.ts`
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
  pin original bugs and Stage 4–7 fixes (80 in all; see `tests/FINDINGS.md` §1).
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
  keep get/set accessors for saves and tests.
- Execution code (`execution/`) reaches `Headquarters` only through
  `hqOf(gameState)` (`execution/hq.ts`), reads bases through `world/bases.ts`
  (`BaseView`), and mutates them only through capability interfaces
  (`SupplyBooking`, `SupplyUpkeep`, `IdleWorkers`).
- Methods never called (in port and original) are marked
  `/** TODO never called ... */`.
- Port fixes go in a commit separate from tests. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
