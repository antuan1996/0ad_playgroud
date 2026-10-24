# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

0 A.D. (engine "Pyrogenesis"): a C++ engine in `source/` and the game itself as
JavaScript/XML/JSON mod data in `binaries/data/mods/` (`mod` = engine-level
GUI/global scripts, `public` = the game). Upstream docs live on the Gitea wiki
(BuildInstructions, GettingStartedProgrammers).

The work on this branch (`petra_behaviour_tests`) is a **TypeScript port of the
Petra AI** and its behaviour-test suite, under
`binaries/data/mods/public/simulation/ai/`.

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
npm run test:petra -- ref           # same tests against the original petra/*.js
npm run test:petra:out              # build the bot, then the same tests against petra_out/*.js
npm run coverage:petra -- [src|ref|both] [--file <module>]   # real per-module coverage
# one file / one test:
PETRA_TARGET=src node --test binaries/data/mods/public/simulation/ai/petra_ts/tests/<name>.test.ts
PETRA_TARGET=ref node --test --test-name-pattern="<regex>" <same path>
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
options: map, seeds, difficulty, civ, `-x` swap slots, `-v` speed, `-n`
headless, `-k` how many match folders to keep, default 5) builds the bot and starts an observed conquest match, Petra JS
(blue, `petra`) against Petra TS (red, `petra_out`); it needs the engine
built from this repo. Each match is recorded in `build/petra_ts/matches/<time>/`
(`latest` links the newest; gitignored): `match.txt` (who is who, seeds,
commit SHA, a sha256 of the `petra_out` build, command, a line to rerun it;
then the result, a statistics table, the distinct errors/warnings, the replay
path and a fingerprint, written by `build/petra_ts/match-report.ts`),
`statistics.json`, `timeline.txt` with `-t`, the replay's `metadata.json` (each
statistic sampled every 30 game seconds), and `logs.tar.gz`: `game.log`
(stdout/stderr: script errors and the end-of-game statistics) and the engine's
`mainlog.html`/`interestinglog.html`.
Matches are deterministic: an explicit `-autostart-seed` also picks the
settings the game setup leaves random (biome, placement, ...), so the same
seeds and code replay the same game and print the same fingerprint.
After a port change, a headless match (`-n`) is a quick smoke test: the unit
tests once missed a `requireValue` that threw every turn in a real game.
The names and colors use autostart options added on this branch
(`-autostart-name`, `-autostart-color`, `-autostart-script`; see
`autostart/cmd_line_args.js`), and `-autostart-stop-on-end` (C++: `CGame::Update`)
runs no turn after the one the game is decided in, the turn a non-visual game
quits on, so both leave the same files; a visual game then shows the result
(`gui/session/message_box/QuitConfirmationObserver.js`) until you leave it.

## Petra architecture (`simulation/ai/`)

- `common-api/` — shared, engine-facing JS (not part of the port): `SharedScript`
  (entities, templates, terrain/accessibility, resource maps), `GameState`,
  `Entity`/`Template`, `EntityCollection`, `filters`, `BaseAI`.
- `petra/` — the original JS bot, the reference (`ref`). The game loads the bot named
  by a folder's `data.json` (`constructor`, `filename`, `useShared`).
- `petra_ts/` — the port, one `.ts` per original `.js`, meant to stay 1:1 with it.
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

- The harness (`tests/harness/`) recreates the engine: `hooks.ts` resolves VFS
  specifiers, `engine.ts` evaluates the real `globalscripts` and records
  `Engine.PostCommand`/warnings (`commands`, `logs`), `target.ts` loads a module
  from the selected target (`PETRA_TARGET`).
- Fake worlds: `attackWorld.ts` (`makeWorld`, `makeEntity`, `makeTemplate`, a stub HQ),
  `hqWorld.ts` (`makeHqWorld`/`seatHQ`: a real Headquarters on real InfoMaps,
  with out-of-scope managers swapped for recording `doorStub`s), `navalWorld.ts`,
  `diplomacy.ts` (`setPlayers`), `world.ts`, `persistence.ts` (save/reload round trips).
- Fake entities and stubs **throw on any undeclared method**: declare what the
  code under test asks for in the test itself.
- Harness answers must match what the common-api really returns (e.g. parsed
  template leaves are strings; `resistanceStrengths()` is `{ Damage: {...} }`).

### Conventions for this work
- Tests assert behaviour in realistic game situations, not implementation.
  Check new tests actually reach the branch they name (run `coverage:petra --file`).
- Every test runs on both targets. A test only the port passes carries a
  `// only the port passes: ...` comment explaining the original's bug; the
  original currently fails exactly 16 tests, all of that kind.
- Port code must not silence the compiler with `as X` casts or `!`; use
  `requireValue` / `requireTemplate` / `requireMetadata` (`entityExtend.ts`)
  where the context guarantees a value, and remove guards that cannot fire.
- Methods never called (in port and original) are marked `/** TODO never called ... */`.
- Port fixes go in a commit separate from tests. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
