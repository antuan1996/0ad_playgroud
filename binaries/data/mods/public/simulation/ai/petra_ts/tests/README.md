# Petra unit tests

Tests for the Petra AI, written in TypeScript and run by Node's built-in test
runner. They describe what the AI does, not how it is written, so the same suite
runs on the port's sources and on the bot built from them.

## Running

```sh
npm run test:petra                 # the port: simulation/ai/petra_ts/**/*.ts
npm run test:petra:out             # builds the "Petra TS" bot, then runs on simulation/ai/petra_out/**/*.js
npm run test:petra:coverage        # the port, plus Node's coverage report
npm run test:petra -- queue.test.ts --test-name-pattern="restor"   # one file, some of its tests
npm run test:petra:out -- queue.test.ts                            # the same on the built bot
```

Both run `tests/run.ts`, which starts `node --test` with `--import
harness/setup.ts`, the preload every test process needs (see "How it works"): a
bare `node --test <file>` cannot load the port.

Coverage counts the code under test only: the report takes the target's own
modules and leaves `tests/` out, so a class that reads 0% is a class no test
has loaded yet.

### Coverage you can trust: `coverage.ts`

Node's `--experimental-test-coverage` line figure overstates: a block V8
reports as never run is counted as run once another test process hit the
surrounding code, so whole untested branches read as covered (worker.ts showed
100% lines while markers planted in such branches never fired). Use
`coverage.ts` for the real figures:

```sh
npm run coverage:petra                      # the port, per module
npm run coverage:petra -- out               # the built bot
npm run coverage:petra -- src --file worker # one module: functions, lines and blocks never run
npm run coverage:petra -- src --json c.json
```

It runs the suite once with `NODE_V8_COVERAGE`, resolves every character of a
module to the innermost V8 range in each test process, keeps the highest count
any process saw, and only then folds characters into lines. It reports:

- **lines**: lines holding code, and of those the ones where any code ran.
  Comments, blank lines, lone braces/`else` and TypeScript-only declarations
  (interfaces, type aliases, `declare` members) are not code.
- **blocks never run**: stretches of code no test reached — a branch, a
  `continue;` never taken, a `?? -1` fallback never used.
- **functions**: bodies V8 saw called at least once.

A module no test loads is marked `*`.

`npm run build:petra:out` builds the port into the game's "Petra TS" bot in
`simulation/ai/petra_out/` (see the root `CLAUDE.md`). The `out` target runs the
suite on that output: it is the port again, and checks that the build the game
loads still works.

A test imports the port's sources like any module (`../execution/queue.ts`),
with their types; for the `out` target `harness/hooks.ts` loads the built module
(`petra_out/execution/queue.js`) in its place, so the same imports test either.

Until stage 3 (`PLAN.md`) the suite also ran against the original
`simulation/ai/petra/*.js`, the `ref` target; its modules no longer match the
port's folders and names, so that target is gone. The parity of the port as it
was frozen is shown in games instead (stage 1, `FINDINGS.md` §14). A test with
an `// only the port passes: ...` comment pins one of the original's bugs
(`FINDINGS.md` §1); the original failed exactly the first 20 of them when it was last
run; eight more pin stage-4 fixes and eight stage 5's (36 in all).

Type checking:

```sh
npm run typecheck:petra:tests
```

Note that this also re-checks the port itself: `common-api.d.ts` reaches into
the sources with `import("./baseManager.ts")`, so the sources join the program.
Both this and the port's own check (`npm run build:petra`) are clean, so any
error either reports was introduced by a change. The configs live in
`build/petra_ts/`, outside the mod: the engine takes every `*.json` under
`simulation/ai/` for a bot's description, and the game setup cannot list a
tsconfig. The suite needs `@types/node` (declared in `package.json`, and what
`build/petra_ts/tsconfig.tests.json` asks for with `"types": ["node"]`);
without it `tsc` reports one fatal
`TS2688: Cannot find type definition file for 'node'` and checks nothing.

## How it works

The AI scripts assume the game's environment: imports spelled as VFS paths, and
globals like `Engine`, `uneval` and `Vector2D` already defined. `harness/`
supplies both.

| file | role |
|---|---|
| `harness/setup.ts` | preloaded into every test process: the hooks and the engine's globals |
| `harness/paths.ts` | where the targets live, and which one is selected |
| `harness/hooks.ts` | resolves `simulation/...` specifiers, and the port's sources to the built bot for `out` |
| `harness/engine.ts` | the engine's global scope; records commands (`commands`, `sent(type)`) and warnings (`logs`) |
| `harness/fakes.ts` | fake entities and templates, the turn's events, engine stubs, `fake`/`override` |
| `harness/world.ts` | a world of entities around a stub headquarters (`makeWorld`) |
| `harness/hqWorld.ts` | a real Headquarters on a small map, its co-managers as recorded doors (`makeHqWorld`, `seatHQ`) |
| `harness/navalWorld.ts` | the hq world split by a sea, with ships and transports |
| `harness/bareState.ts` | a game state with only a config, queues and templates (`makeFakeGameState`) |
| `harness/diplomacy.ts` | the players' table and its diplomacy (`setPlayers`) |
| `harness/persistence.ts` | the save/reload checks |

The hooks have to be in place before a test file's own imports are resolved,
and the globals before the port's modules run, so `setup.ts` is a preload
(`--import`), not something a test imports.

`harness/engine.ts` evaluates the mod's real `globalscripts/*.js` rather than
reimplementing them, and answers `ReadJSONFile`/`ListDirectoryFiles` from the
real files on disk, so resource codes and template helpers are the game's own.
Everything else is a stub that **throws with its own name** when called
unprepared — a test cannot pass because a missing global quietly returned
`undefined`.

## Writing a test

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity } from "./harness/fakes.ts";
import { makeWorld, PLAYER } from "./harness/world.ts";

import { entityId } from "../adapter/brands.ts";
import { DefenseArmy } from "../execution/defenseArmy.ts";
```

The tests are typed by the port itself: a test uses the port's classes and
types (and, where it needs one the port does not export, exports it there)
rather than declaring its own copy of them. Ids, positions and the other
branded values go through `adapter/brands.ts` (`entityId(2000)`,
`worldPos(40, 40)`), as the port's own code does. A fake that stands in for an
engine or port object is typed as that object through `fake<T>()` (the
harness's one sanctioned cast), and a fake's answers are changed with
`override(target, { method })`, which, like a fake's declared methods, does
not check them against the real signatures.

Two rules keep the suite useful as a check on the port:

- **Assert behaviour, not implementation.** "A queued technology is not
  duplicated", not "the loop compares `plan.type`". A test that restates the
  source cannot tell a rewrite from a regression.
- **Fake the smallest thing that works.** A fake entity (`harness/fakes.ts`)
  throws on any method a test did not declare, so a test only depends on what it asked for. When the
  code under test needs more of the world, add that method in the test — do not
  widen the shared fake by default.

A guard on every test: an attack plan's `changeState(from, to)` warns when the
plan is not in the state `from` its caller expects, and `harness/engine.ts`
fails any test that produced such a warning. It means the test set up a state
no game reaches (a plan started straight from "unexecuted", where the game has
it "completing"): set the state the game has there. A test that means to make
such a move calls `allowMisplacedMoves()` (from `harness/engine.ts`) first; that
lifts the guard for that test only.

Where the port deliberately behaves differently from the original JS, say so in
a comment above the test and assert the behaviour that is wanted, not the
behaviour the original happened to have.

## Save and reload

`persistence.test.ts` checks the managers that survive a save game. Petra has no
storage: each manager returns a blob from `Serialize()`, and on load a freshly
constructed manager is filled by `Deserialize()`. A field either side forgets is
invisible until someone reloads a match, so `harness/persistence.ts` checks two
things per class, without naming a single field:

- **The save comes back unchanged.** Fill the instance's fields with values no
  default has, save it, restore a *different* instance from that data, and
  require the second instance to save to exactly the same data. A field
  `Deserialize` ignores shows up as a key lost on reload; one it invents as a key
  that only appears after a reload.
- **The save covers the state.** Every field that was filled must appear in the
  save somewhere. Without this, a field `Serialize` stopped writing is invisible:
  both saves would be missing it and agree.

A field that is deliberately not saved goes in the test's `notSaved` with a
reason, so the list of what a manager chooses not to remember is written down
rather than inferred. `populate` fills only numbers, strings and booleans; a test
that wants a Map or an entity in the save passes it in `set`, because only it
knows what a sensible entry is.
