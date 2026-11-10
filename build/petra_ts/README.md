# Petra TS build, match, batch and analysis tools

This directory holds the TypeScript configurations, build scripts, headless
match/batch runners, baselines, parity tools, and code-quality/structure checks
for `binaries/data/mods/public/simulation/ai/petra_ts/`.

See the root `CLAUDE.md` for architecture and coding conventions, and `PLAN.md`
for the project roadmap and validation methodology.

## TypeScript configurations and bot build

- `tsconfig.json` — strict typecheck of the port (`npm run build:petra`, noEmit).
- `tsconfig.build.json` — emits JS for `petra_out`.
- `tsconfig.tests.json` — typechecks tests, harness, and port (`npm run typecheck:petra:tests`).
- `prepare-bot.ts` — used by `npm run build:petra:out`: cleans, runs `tsc`,
  rewrites relative imports to VFS paths (`simulation/ai/petra_out/x.js`, since
  the engine's module loader does not resolve `./x.js`), and writes `data.json`
  ("Petra TS", constructor `PetraBot`, in-game bot id `petra_out`).

**Never put a `.json` file under `simulation/ai/`** other than a bot's
`data.json`: the engine (`ICmpAIManager.cpp` `GetAIs`) lists every `*.json`
there as a bot, and the game setup's AI list breaks on one without a `name`.

## Quality and structure checks

### `quality.ts` (`npm run quality:petra`)

```sh
npm run quality:petra -- [--file <module>] [--top N] [--tests] [--renamed] [--json F]
```

Tested by `quality.test.ts` in `npm run test:petra:tools`. Parses the port (not
`.d.ts`; `--tests` adds tests) with the TypeScript compiler (no typecheck, ~0.5s):

- **Per function** (callbacks measured on their own): lines, cyclomatic and
  cognitive (SonarSource) complexity, nesting depth, and parameters.
- **Per class**: lines, methods, and fields.
- **Per module**: code lines and sums.
- **Duplicated code**: runs of at least 60 tokens over 6 lines found twice or
  more (imports excluded; `--renamed` catches copies over different names).
- **Thresholds**: lines 96 (80 before dprint's `useBraces: "always"` added +21%
  code lines), cyclomatic 15, cognitive 25, depth 4, params 5. The port has no
  function over the thresholds and no clone: keep it so.

### `structure.ts` (`npm run structure:petra`)

```sh
npm run structure:petra -- [--check] [--update-baseline] [--top N] [--json F]
```

Tested by `structure.test.ts` in `npm run test:petra:tools` (~1s):

- **Hard rules (`--check` fails on any violation)**:
  - No `as` cast outside `adapter/brands.ts` (`as const` apart).
  - No `!` non-null assertion.
  - `Engine.PostCommand` only in `adapter/commands.ts`.
  - No execution code reaching the HQ (`.ai.HQ`, importing
    `decision/headquarters.ts`): it uses the town (`execution/town.ts`) and
    its desks on `gameState.ai.town`.
  - `view-only`: no decision module imports an execution class it sees
    through a view (`VIEW_ONLY` in `structure.ts`: `AttackPlan`, seen as
    `AttackPlanView`, its states and types from `attackConstants.ts`).
- **Baseline counts (`structure-baseline.json`, all 0 — keep them 0)**:
  - Layer violations (`adapter < world < execution < decision < root`,
    `PLAN.md` §3.4; type-only imports included).
  - `layer-access` (0): members of a higher layer reached at run time with no
    import, through `gameState.ai.HQ` and the like: a property (read as
    `x.name`, `x["name"]` or destructured) whose declaration, or the type of
    the value it yields, lies in a higher layer, resolved by the type checker;
    once a chain (a decision manager's method from `execution/` too). Listed
    in full in the report.
  - Modules in value-import cycles.
  - `Engine` uses outside `adapter/` (profiling apart).
  - Dead exports (unmarked) and dead methods (unmarked, not named in port or
    `bot-state.js`).
  - Stale `TODO never called` markers (reached by a call in the port, resolved
    by the typechecker).
  - `whole-hq`: values (parameters, fields, variables, returns) typed as the
    whole `Headquarters` outside `decision/headquarters.ts` and the bot's root,
    where a view of what they use (`TownState` and the members they add)
    would do.
- **Cohesion baseline (`cohesion-baseline.json`, `--check` fails when one
  worsens)**: each class's core LCOM4 and each class-with-parts' LCOM4; a
  class the baseline does not know may have 4 (`NEW_CLASS_CORE_MAX`). The
  core LCOM4 groups a class's own methods: forwarders apart (a method whose
  whole body passes one call or read on to a member of a collaborator,
  `return this.manager.getPlan(id)`, or a getter and setter passing a field's
  member on), and only collaborators (fields with no initializer that the
  constructor does not set to fresh data) set apart as hubs, never its own
  state (`private plans = []`, or `this.turnCache = {}` in the constructor,
  links every method using it). The report lists each class's core groups. A facade (the town, a
  desk) is judged by what it does itself, a registry by its own lists. The
  report lists the figures worse and better than the baseline;
  `--update-baseline` writes both baselines (lower a figure when a class
  improves, raise one only for a split that is meant).
- **Also reports**: exports used only by their own module (keep at 0) or only by
  tests, module fan-in/fan-out, and per-class methods, fields, LCOM4, the
  forwarders and the core LCOM4.
- **Coupling and cohesion** (`coupling.ts`, type-checked, report-only):
  - Classes with their parts: LCOM4 over a class's methods and the port's
    functions taking the class (`walkTo(plan: AttackPlan)`), `this.x` and
    `plan.x` alike. Hubs and whole-state units (more than half the fields: the
    saves) are set apart. It also lists the fields only one module uses, the
    constructor and the saves apart: state a part could hold.
  - Types used narrowly: for each class, interface or object type of the
    port, the members other modules read out of its public ones, and the
    modules reading a quarter or less of a type of 8 members or more. Those
    could take an interface of what they use, as the town's desks do.
  - Both count a member read through an interface or object type the class
    is given as (returned, passed or assigned as `SiteHQ`,
    `PlacementHQ`, ...) as a read of the class's member.

## Matches (`match.sh` / `npm run match:petra`)

```sh
npm run match:petra -- [options]   # build/petra_ts/match.sh (-h for options)
```

Builds the bots and starts an observed match of Petra TS (`petra_out`) against
itself (default; the unpatched original loses most games to its `removeSupply`
bug, `tests/FINDINGS.md` §10), or against another bot. Requires the C++ engine
built in `binaries/system/pyrogenesis`.

### Options

- Map, seeds, difficulty, civ.
- `-w`: victory conditions (default `conquest`; e.g.
  `conquest,wonder,capture_the_relic`).
- `-W`: minutes a wonder or relics must be held (default 20).
- `-o` / `-p`: blue / red bot (`petra_out`, `petra`, `petra_parity`,
  `petra_prev`, or `petra_fixed`).
- `-x`: swap slots.
- `-N`: number of players (2 to 8, all against all; players 3+ play the `-q`
  bot, default `petra_out`).
- `-B`: do not rebuild bots.
- `-v`: speed; `-n`: headless; `-T`: 90-minute game time limit
  (`MatchTimeLimit.js`); `-L MIN`: time limit at game minute `MIN`.
- `-t`: timeline (`timeline.txt`).
- `-l`: command log (`commands.txt`, `<game ms> <player> <JSON>` from
  `maps/scripts/MatchCommands.js`) and GUI notices (`notices.txt`: refused
  orders and chat, from `maps/scripts/MatchNotices.js`).
- `-b`: AI-side state dumps (`build/petra_ts/bot-state.js`, added to `petra_out`
  by `prepare-bot.ts state` without altering gameplay):
  - `botstate.txt`: every 2 game minutes (workers by role, base supplies, queues,
    reserved resources, attack plans, HQ flags).
  - `attacks.txt`: attack plan creation, start, abort, end, and 1-minute
    preparation snapshots; summarised by `node build/petra_ts/attack-log.ts <dir>`.
  - `economy.txt`: every 30 game seconds (gather-rate estimates, wanted rates,
    `pickMostNeededResources` order, gatherers by activity, trip lengths, start
    supply layout, trainer utilization, queue accounts); summarised beside replay
    stats by `node build/petra_ts/economy-log.ts <dir>`.
  - `ships.txt`: every 5 s, each of our ships: position, angle, UnitAI state,
    units aboard, transport plan, stage and goal; `node build/petra_ts/ship-log.ts
    <match or batch dir>` finds ships with no headway toward their goal, still
    away from it, or circling (PLAN.md §6.2, item 4).
  - `fights.txt`: each fight (a started attack at its target, a defense army)
    with 5 or more units a side: both sides, the fight estimator's answer
    (`decision/fightEstimate.ts`) and each side's losses 60 and 120 s on;
    `node build/petra_ts/fight-log.ts <match or batch dir>` scores the
    estimator (PLAN.md §6.3.1).
  - `forecasts.txt`: every minute from minute 2 to 13, the build-order
    planner's forecast (`decision/economyForecast.ts`) 60, 120 and 180 s on,
    against what was there; `node build/petra_ts/forecast-log.ts <match or
    batch dir>` gives its errors (PLAN.md §6.3.2).
  - `apiprobe.txt`: at minutes 6 and 20, read-only common-API accessor audit
    (`tests/FINDINGS.md` §23).
- `-P`: script turn timing (`aitimes.txt` via `PYROGENESIS_AI_TIMES` in
  `CCmpAIManager.cpp`, and `turntimes.txt` via `PYROGENESIS_TURN_TIMES`).
  Summarise with `node build/petra_ts/ai-times.ts <dir>... [--compare <batch>]`.
- `-i`: unit idle time (`idle.txt` from `maps/scripts/MatchIdle.js`, sampled
  every 5 game seconds); summarised by `node build/petra_ts/idle-log.ts <dir>`.
- `-k`: match folders to keep (default 5).
- `-K MIN` / `-S SEC`: watchdog limits (kills engine if CPU time in
  `/proc/<pid>/stat` stalls for `-S` seconds, default 60, or wall time exceeds
  `-K` minutes, default 10 headless; exits 137 and logs `watchdog: ...` in
  `match.txt`).

### Match records and determinism

Recorded in `build/petra_ts/matches/<time>/` (`latest` symlink; gitignored):
`match.txt` (written by `match-report.ts`), `statistics.json`, replay
`metadata.json` (sampled every 30 game seconds; note `total` is 0 for units lost
and killed — use the `Unit` class), and `logs.tar.gz` (`game.log`,
`mainlog.html`, `interestinglog.html`).

Matches are deterministic: `-autostart-seed` fixes random setup choices, so the
same seeds and code produce the same game and fingerprint.

## Integration match & smoke test

- `npm run test:petra:match` (`build/petra_ts/match.test.ts`, ~80s): runs one
  fixed mirror match (seeds 287591089/941505347, `matches/test/`) with
  `-t -l -T` and runs `build/petra_ts/match-checks.ts` (also runnable via
  `node build/petra_ts/match-checks.ts <dir>`): asserts no errors, decided game,
  winner's town phase and metal, idle women, unspent stockpiles, early growth,
  no infinite `WALKING` march, no command silence/repeats/floods/churn, and no
  refused orders.
- `npm run test:petra:smoke` (`build/petra_ts/smoke.ts`; `-- --jobs J`, default
  12, ~3 min): plays 24 headless games (`petra_out` vs `petra_parity` across the
  12 seed pairs of `build/petra_ts/smoke/reference.tsv` from both slots).
  - Pure refactors must leave all 24 fingerprints identical.
  - Gameplay changes update the reference via `-- --update` (or
    `-- --update --from <batch>`) in the same commit.

## Baselines and parity tools

Built by `build/petra_ts/baselines.ts` (`npm run build:petra:baselines`,
gitignored outputs under `simulation/ai/`):

- `petra_parity` ("Petra TS parity"): compiled from tag `petra-ts-parity`. Fixed
  reference across stages.
- `petra_prev` ("Petra TS previous", `baselines.ts prev`): compiled from tag
  `petra-ts-prev` (move with `git tag -f petra-ts-prev <commit>` when a change
  is kept).
- `petra_fixed` ("Petra fixed"): original `petra/*.js` with
  `upstream/petra-fixes.patch` applied.

Parity utilities:

- `node build/petra_ts/command-diff.ts <dir1> <dir2>` or `<batch dir>`: finds
  where command logs diverge.
- `node build/petra_ts/baselines.ts hybrid <petra_hybrid_* id> <module>...`:
  builds `petra_fixed` with selected modules replaced by the port's.
- `node build/petra_ts/parity-bisect.ts --pair M/A --player P [--with m]`:
  bisects module by module to find which module causes a divergence (~1.5 min).

## Batches and strength measurement (`batch.ts`)

```sh
npm run batch:petra -- [options]   # node build/petra_ts/batch.ts
```

Options: `--blue`, `--red`, `--games` (seed pairs), `--slots one|both`, `--seed`
(pool seed), `--jobs`, `--twice N`, `--out`, `--bot-state` (builds with state
dump and passes `-b`), `--game-timeout M` (default 15), `--map` (e.g.
`random/mainland` or `random/mainland_mirror`).

Builds the bots once, then runs `match.sh -n -T -B -r` in parallel with isolated
`XDG_*` directories under `build/petra_ts/workers/<job>/`. Output lands in
`build/petra_ts/batches/<name>/`: `batch.txt`, `games/<n>/`,
`results.jsonl`/`results.tsv`, and `summary.txt` (from `batch-stats.ts`:
win-rate with 95% Wilson CI, SPRT against `--h1`, slot advantage, pairs won from
both slots, errors, game lengths, mean statistics, determinism). Passing an
existing `--out` resumes the batch.

Early proxy for tuning (`PLAN.md` §5.3):

```sh
node build/petra_ts/pair-score.ts <batch> [--minute M] [--compare <batch>]
```

Computes blue's lead at minute `M` (default 8) in units trained and resources
gathered, averaged over each seed pair's two games so slot advantage cancels.
