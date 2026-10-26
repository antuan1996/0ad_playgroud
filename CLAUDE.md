# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

0 A.D. (engine "Pyrogenesis"): a C++ engine in `source/` and the game itself as
JavaScript/XML/JSON mod data in `binaries/data/mods/` (`mod` = engine-level
GUI/global scripts, `public` = the game). Upstream docs live on the Gitea wiki
(BuildInstructions, GettingStartedProgrammers).

The work here is a **TypeScript port of the Petra AI** and its behaviour-test
suite, under `binaries/data/mods/public/simulation/ai/`, and its evolution into
a stronger AI.

**`PLAN.md` is the project's goal and plan**: the constraints every change must
keep (determinism, the engine interface, the runtime, save games), the
strategy (freeze the port as the `petra_parity` baseline, evolve `petra_ts`),
the type-driven architecture (typestates for plans, parsed observations,
branded types, layers), validation (parity, per-change checks, win-rate with
SPRT) and the staged roadmap with exit criteria. Check work against it, and
update it when a stage is done or a decision changes.

## Commands

### Engine (C++)
```sh
libraries/build-source-libs.sh            # bundled third-party libs (once)
build/workspaces/update-workspaces.sh     # premake -> build/workspaces/gcc/ (options: --without-tests, --without-atlas, ...)
make -C build/workspaces/gcc -j$(nproc)   # binaries land in binaries/system/
binaries/system/test                      # cxxtest runner (also runs the JS component tests)
binaries/system/test --suite <Suite> [--test <name>]   # one suite / one test; --list to enumerate
```

### Linting
- `npm run lint` / `npm run lint:fix` — ESLint for the game's **JS** (tabs, see `.editorconfig`). It does not lint `.ts` files.
- `pre-commit run --all-files` — the CI hooks (ruff, shellcheck/shfmt, markdownlint, yamllint, eslint, the non-breaking space in "0 A.D." under `binaries/`).

### Petra TS port
```sh
npm run build:petra                 # strict typecheck of the port (noEmit); clean
npm run typecheck:petra:tests       # typecheck tests + harness (also re-checks the port); clean
npm run build:petra:out             # build the "Petra TS" in-game bot into simulation/ai/petra_out/ (gitignored)
npm run test:petra                  # all tests against the port (petra_ts/*.ts)
npm run test:petra:out              # build the bot, then the same tests against petra_out/*.js
npm run test:petra:match            # integration: a fixed headless mirror match in the game, checked for anomalies
npm run build:petra:baselines       # the baseline bots petra_parity and petra_fixed (gitignored)
npm run batch:petra -- [options]    # many headless matches in parallel, a results table and win-rate statistics
npm run test:petra:tools            # unit tests of the batch statistics (batch-stats.test.ts)
npm run coverage:petra -- [src|out] [--file <module>]   # real per-module coverage
# one file / one test (tests/run.ts preloads harness/setup.ts; a bare node --test cannot load the port):
npm run test:petra -- <name>.test.ts --test-name-pattern="<regex>"
npm run test:petra:out -- <name>.test.ts
```
Use `coverage:petra` (`tests/coverage.ts`), not `test:petra:coverage`: Node's
built-in line figure counts never-run branches as covered.

The TypeScript configs are in `build/petra_ts/` (`tsconfig.json` strict check,
`tsconfig.build.json` emit, `tsconfig.tests.json`; the root `tsconfig.json` only
points editors at the tests one). **Never put a `.json` file under
`simulation/ai/`** other than a bot's `data.json`: the engine
(`ICmpAIManager.cpp` GetAIs) lists every `*.json` there as a bot, and the game
setup's AI list breaks on one without a `name`.

`build:petra:out` = clean, `tsc`, then `build/petra_ts/prepare-bot.ts`, which
rewrites the output's relative imports to VFS paths
(`simulation/ai/petra_out/x.js`: the engine's module loader does not resolve
`./x.js`) and writes `data.json` ("Petra TS", constructor `PetraBot`). In game
the bot id is `petra_out`.

`npm run match:petra -- [options]` (`build/petra_ts/match.sh`, `-h` for the
options: map, seeds, difficulty, civ, `-w` victory conditions (default
conquest, the game's default; e.g. `conquest,wonder,capture_the_relic`), `-W` minutes a wonder or the relics must be
held (default 20), `-o` the blue bot, `-p` the red bot (each `petra_out`,
`petra`, `petra_parity` or `petra_fixed`), `-x` swap slots, `-B` do not build,
`-v` speed, `-n` headless, `-t` timeline, `-l` command log and notices, `-b`
the bot's own state (both for debugging), `-P` each AI's script time per turn
(`aitimes.txt`, measured by the engine: `PYROGENESIS_AI_TIMES` in
`CCmpAIManager.cpp`, two clock reads per AI and turn kept in memory and written
at the end; `build/petra_ts/ai-times.ts <dir>...` summarises, `--compare
<batch>` sets two bots' times side by side, the turn budget's check),
`-k` how many match folders to keep, default 5) builds the bots and starts an
observed match of Petra TS (`petra_out`) against itself, or with
`-o`/`-p` against the original, Petra JS (`petra`), or a baseline; it needs the
engine built from this repo. Petra TS against itself is the default: the original
loses most games to its `removeSupply` bug (`tests/FINDINGS.md` §10). Each match is recorded in `build/petra_ts/matches/<time>/`
(`latest` links the newest; gitignored): `match.txt` (who is who, seeds,
commit SHA, a sha256 of the `petra_out` build, command, a line to rerun it;
then the result, a statistics table, the distinct errors/warnings, the replay
path and a fingerprint, written by `build/petra_ts/match-report.ts`),
`statistics.json`, `timeline.txt` with `-t`, `commands.txt` with `-l` (every
command each bot sent, `<game ms> <player> <JSON>`, from
`maps/scripts/MatchCommands.js`: AI commands are not in the replay; diffing two
runs' logs finds where they diverge), `notices.txt` with `-l` (what the game
told the bots: refused orders, their chat; `maps/scripts/MatchNotices.js`),
`botstate.txt` with `-b` (Petra TS's AI-side state every two game minutes:
workers by role, each base's resource lists, queues and reserved resources,
attack plans, HQ flags; `build/petra_ts/bot-state.js`, which
`prepare-bot.ts state` adds to the `petra_out` build only, so the port stays
1:1 and the game is the same), the replay's `metadata.json` (each
statistic sampled every 30 game seconds), and `logs.tar.gz`: `game.log`
(stdout/stderr: script errors and the end-of-game statistics) and the engine's
`mainlog.html`/`interestinglog.html`.
Matches are deterministic: an explicit `-autostart-seed` also picks the
settings the game setup leaves random (biome, placement, ...), so the same
seeds and code replay the same game and print the same fingerprint.
After a port change, a headless match (`-n`) is a quick smoke test: the unit
tests once missed a `requireValue` that threw every turn in a real game.
`npm run test:petra:match` (`build/petra_ts/match.test.ts`, about 80 s, skipped
without the engine) plays one fixed mirror match (seeds 287591089/941505347,
recorded in `matches/test/`, `-r`) with `-t -l -T` (`-T`: `MatchTimeLimit.js`
ends an undecided game at 90 game minutes, "time limit") and asserts the
checks of `build/petra_ts/match-checks.ts`, which also runs on any record
(`node build/petra_ts/match-checks.ts <dir>`): no errors, a decided game, the
winner's town phase and metal, idle women, unspent stockpiles, early growth,
and from the commands silence, a command repeated turn after turn, floods,
production churn and phases ordered but not had, and from the notices refused
orders. The checks read only what the engine records, never `botstate.txt`:
the bot's internal structure changes with its code, so `-b` is for reading
while debugging (a section of the dump that no longer fits the code prints as
`{"error": ...}` rather than breaking the bot's turn). It does not assert the
fingerprint, which any change to the bot moves; it prints it.
Baselines (`PLAN.md` §2; `build/petra_ts/baselines.ts`, gitignored outputs):
`petra_parity` ("Petra TS parity") is the port compiled from the tag
`petra-ts-parity` (git archive of that tag's `petra_ts/` and tsconfigs, tsc,
`prepare-bot.ts --bot=petra_parity`), so it stays fixed while `petra_ts`
changes; `petra_fixed` ("Petra fixed") is `petra/*.js` with
`upstream/petra-fixes.patch` applied and its imports pointed at
`simulation/ai/petra_fixed/`. With the patch's 15 fixes the two play the same
games command for command (stage 1, `FINDINGS.md` §14: a game with the slots
swapped is the same game, the same command log).
Parity tools: `node build/petra_ts/command-diff.ts <dir> <dir>` (where two
command logs part, with context) or `<batch dir>` (each seed pair's two games
from a `--slots both` batch played with `-- -l`; `batch.ts --pairs M/A,...`
replays chosen seeds); `node build/petra_ts/baselines.ts hybrid <petra_hybrid_*
id> <module>...` (`petra_fixed` with those modules from the port; the port's
extra helper exports are appended); `node build/petra_ts/parity-bisect.ts
--pair M/A --player P [--with m]` (plays the reference games to the end, then
one hybrid per module to 2 minutes past the divergence, `match.sh -L`, and
names the module whose hybrid plays as `petra_parity`; about 1.5 minutes).
`match.sh -L MIN` is `-T` at game minute MIN (`-autostart-timelimit`, the
`MatchTimeLimit` game setting read by `maps/scripts/MatchTimeLimit.js`).
`build/petra_ts/batch.ts` (`--blue`, `--red`, `--games` seed pairs, `--slots
one|both`, `--seed` of the pool, `--jobs`, `--twice N`, `--out`; header for
the rest) builds the bots once, then runs `match.sh -n -T -B -r` per game,
`--jobs` at a time, each job with its own `XDG_DATA_HOME`/`CONFIG`/`CACHE`/
`STATE` under `build/petra_ts/workers/<job>/` (the engine's replays, logs,
config and cache; checked per game), into `build/petra_ts/batches/<name>/`:
`batch.txt`, `games/<n>/` (match records; replays are deleted, the rerun line
replays), `results.jsonl`/`results.tsv` (one row per game, from each record's
`result.json`, written by `match-report.ts`) and `summary.txt`
(`batch-stats.ts`, also a CLI: win-rate over decided games with a 95% Wilson
interval, an SPRT of 50% against `--h1` (0.55), slot advantage, seed pairs won
from both slots, errors, game lengths, mean statistics, and determinism: games
played twice by `--twice` must share a fingerprint). Time-limit games are
draws, outside the win-rate. An existing `--out` resumes the batch.
The names and colors use autostart options added on this branch
(`-autostart-name`, `-autostart-color`, `-autostart-script`; see
`autostart/cmd_line_args.js`), and `-autostart-stop-on-end` (C++: `CGame::Update`)
runs no turn after the one the game is decided in, the turn a non-visual game
quits on, so both leave the same files; a visual game then shows the result
(`gui/session/message_box/QuitConfirmationObserver.js`: how it was won, then
each player's state) until you leave it. `maps/scripts/MatchEnd.js` prints the
decision with the game's reason ("last player alive", "wonder victory",
"Capture the Relic", ...), which `match.txt` shows with the result.

## Petra architecture (`simulation/ai/`)

- `common-api/` — shared, engine-facing JS (not part of the port): `SharedScript`
  (entities, templates, terrain/accessibility, resource maps), `GameState`,
  `Entity`/`Template`, `EntityCollection`, `filters`, `BaseAI`.
- `petra/` — the original JS bot, the reference: the baselines are built from it
  (`petra_fixed`) and from the frozen port (`petra_parity`); it is no test
  target since stage 3. The game loads the bot named by a folder's `data.json`
  (`constructor`, `filename`, `useShared`).
- `petra_ts/` — the port, in layers (stage 3, `PLAN.md` §3.4): `_petrabot.ts`
  and the `.d.ts` declarations at the root; `adapter/` (the engine boundary:
  `brands.ts`, `entityExtend.ts`, `chatHelper.ts`, `unitState.ts` parsing what a
  unit does, `commands.ts` where the bot's own commands leave it); `world/` (the
  AI's model: `mapModule.ts`, `mapMask.ts`; `geography.ts`, the territory and
  border maps and the land/sea regions, owned by the HQ; `baseResources.ts`,
  the supplies each base's dropsites reach, owned by each base; `bases.ts`, the
  read-only view of the bases); `decision/` (headquarters, startingStrategy, config, difficultyLevel and
  the managers); `execution/` (attack and transport plans, defense armies, queues,
  the queue plans, `worker.ts`). Files kept the original's names; the 1:1 rule
  ended with the tag `petra-ts-parity`.
- `petra_out/` — generated, gitignored: the port built as the "Petra TS" bot.
  Imports use VFS paths (`simulation/ai/common-api/...`); the engine-facing
  shapes are declared in `engine-api.d.ts`, `common-api.d.ts`, `globalscripts.d.ts`
  and `petra-runtime.d.ts` (port-wide metadata/config types).

Control flow: `_petrabot.ts` (`PetraBot extends BaseAI`) → on the first turn
`startingStrategy.gameAnalysis` reads the map and sets up `Headquarters`; then
one turn in eight (offset by player id) `Headquarters.update` drives the
managers (bases/base, build, attack + attack/transport plans, defense +
defense armies, naval, trade, research, diplomacy, garrison, victory,
emergency) and `QueueManager` funds `queues` of plans
(`queueplanBuilding`/`Training`/`Research`) by priority. Workers are steered
by `worker.ts` through entity metadata (`role`, `subrole`, `base`, `plan`,
`transport`, …). Every manager has `Serialize`/`Deserialize` for save games.

## Petra tests (`petra_ts/tests/`)

Read `tests/README.md` before writing tests; `tests/FINDINGS.md` records the
known bugs, port/original differences, shared quirks, unreachable code and
untested branches.

- The harness (`tests/harness/`) recreates the engine. `setup.ts` is preloaded
  into every test process (`--import`, by `tests/run.ts`): `hooks.ts` resolves
  VFS specifiers and, for `PETRA_TARGET=out`, loads the built `petra_out/` module
  for each import of a port source; `engine.ts` evaluates the real
  `globalscripts` and records `Engine.PostCommand`/warnings (`commands`,
  `sent(type)`, `logs`).
- Tests import the port directly (`../execution/queue.ts`) and are typed by it:
  no local copies of the port's classes or types (export a type from the port
  when a test needs it), branded values through `adapter/brands.ts`.
- Fakes: `fakes.ts` (`makeEntity`, `makeTemplate`, `emptyEvents`/`eventsWith`,
  `stubGlobal`/`restoreEngine`; `fake<T>()` types a fake as the real object, the
  harness's one cast, and `override(target, { method })` changes a fake's
  answers), `world.ts` (`makeWorld`: entities around a stub HQ), `hqWorld.ts`
  (`makeHqWorld`/`seatHQ`: a real Headquarters on real InfoMaps, with
  out-of-scope managers swapped for recording `doorStub`s, `doorManagers`),
  `navalWorld.ts`, `bareState.ts` (`makeFakeGameState`: config, queues,
  templates), `diplomacy.ts` (`setPlayers`), `persistence.ts` (save/reload
  round trips).
- Fake entities and stubs **throw on any undeclared method**: declare what the
  code under test asks for in the test itself.
- Every test fails if a plan moved from a state its caller did not expect
  (`changeState`'s warning; the guard is in `harness/engine.ts`): set the state
  the game has there, or call `allowMisplacedMoves()` in that test.
- Harness answers must match what the common-api really returns (e.g. parsed
  template leaves are strings; `resistanceStrengths()` is `{ Damage: {...} }`).

### Conventions for this work
- Tests assert behaviour in realistic game situations, not implementation.
  Check new tests actually reach the branch they name (run `coverage:petra --file`).
- Tests run on the port's sources (`src`) and on the built bot (`out`); the
  original is no target since stage 3. A test with `// only the port passes:
  ...` pins one of the original's bugs; the original failed exactly those 20
  when last run (19 bugs; one pins the attack plan's save validation).
- Port code must not silence the compiler with `as X` casts or `!`; use
  `requireValue` / `requireTemplate` / `requireMetadata` (`entityExtend.ts`)
  where the context guarantees a value, and remove guards that cannot fire.
- Ids, positions, regions, times, template names and grid cells are branded
  (`EntityId`, `PlayerId`, `WorldPos`, `MapPos`, `AccessIndex`, `SeaIndex`,
  `RegionIndex`, `GameMs`, `GameSeconds`, `TemplateName`, `CellIndex<Grid>`
  in `engine-api.d.ts`; `InfoMap<Grid>` and `CommonGrid<Grid>` carry their
  grid): what the engine hands over carries the brand. `petra_ts/brands.ts`
  is the only place that gives it to a plain value (`entityId`, `playerId`,
  `worldPos`, `landRegion`, `seaRegion`, `seconds`, `secondsOf`,
  `templateName`, `cellIndex`, and `GAIA`, `INVALID_PLAYER`,
  `INVALID_ENTITY`, `NO_LAND`, `NO_REGION`, `NO_TEMPLATE`): its identity
  functions hold the port's only sanctioned casts. A loop over a map's cells
  brands its index once (`const j = cellIndex(map, jIndex)`). A loop over player indices brands its index once
  (`const i = playerId(iIndex)`); records keyed by a `for...in` key keep
  `number` keys.
- The attack plan's state changes only through `changeState(from, to)`
  (the moves are in `AttackTransitions`, `attackPlan.ts`).
- What a unit is doing is read through `adapter/unitState.ts` (`isInState`,
  `hasActivity`, `stateIs`, ...), never by comparing `unitAIState()` strings:
  the state names are the union `UnitAIStateName`, taken from `UnitAI.js`
  (`unitState.test.ts` fails when UnitAI's states change).
- The bot's own commands go through `adapter/commands.ts` (`postCommand`,
  `debugShade`); only that module calls `Engine.PostCommand`.
- Saved data carries `SAVE_VERSION` (`_petrabot.ts`): raise it with any change
  to a manager's saved shape; a save of another version is refused and the bot
  starts afresh.
- World state lives in `world/` objects owned by the managers that used to hold
  it (`HQ.geography`, `base.resources`), and the port reads them there
  (`HQ.geography.territoryMap`, `base.resources.dropsiteSupplies`): an accessor
  on a hot path cost measurable turn time. The owners keep get/set accessors with
  the old names (`HQ.territoryMap`, `HQ.landRegions`, `base.dropsiteSupplies`,
  ...) for the save format and the tests; the stub HQ of `harness/world.ts` is
  its own `geography`.
- Execution code (`execution/`) reaches the headquarters only through
  `hqOf(gameState)` (`execution/hq.ts`): a read-only view of the members it
  uses, whose bases are `BaseView`s, and four reports (`phaseResearched`,
  `markBuildingStarted`, `noteNothingToGather`, `allowsDistantFood`). It reads
  bases through `world/bases.ts` (`BaseView`, read-only supply lists) and
  changes them only through its capabilities (`SupplyBooking`, `SupplyUpkeep`,
  `IdleWorkers`); a manager's own state (e.g. the victory manager's raided
  relics) is changed only through that manager's methods. A new use of the HQ
  from execution code goes into `ExecutionHQ`, as a read or a report.
- Methods never called (in port and original) are marked `/** TODO never called ... */`.
- Port fixes go in a commit separate from tests. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
