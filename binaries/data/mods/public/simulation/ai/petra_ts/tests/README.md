# Petra unit tests

Tests for the Petra AI, written in TypeScript and run by Node's built-in test
runner. They describe what the AI does, not how it is written, so the same suite
can be pointed at different builds of it.

## Running

```sh
npm run test:petra            # the port: simulation/ai/petra_ts/*.ts
npm run test:petra -- ref     # the original: simulation/ai/petra/*.js
```

`ref` is the game's own copy of Petra, the `petra` folder that sits next to the
port's `petra_ts` folder in the mod, so the suite reads whatever the game would
load today. `npm run build:petra:out` transpiles the port to
`simulation/ai/petra_out/*.js` — that is just tsc's output for the port, not a
third implementation to test.

Running against `ref` is expected to fail wherever the port deliberately
behaves differently from the original — that failure is the record of the
difference, not a regression. `queue.test.ts` says so above the test that only
the port passes.

Type checking:

```sh
npm run typecheck:petra:tests
```

Note that this also re-checks the port itself: `common-api.d.ts` reaches into
the sources with `import("./baseManager.ts")`, so the sources join the program.
The port currently has pre-existing strict-mode errors, so this is not yet a
clean gate — filter for `petra_ts/tests/` to see whether a change here added any:

```sh
npm run --silent typecheck:petra:tests 2>&1 | grep 'petra_ts/tests/'
```

An empty result means the tests and harness are clean. The suite needs
`@types/node` (declared in `package.json`, and what `tests/tsconfig.json` asks
for with `"types": ["node"]`); without it `tsc` reports one fatal
`TS2688: Cannot find type definition file for 'node'` and checks nothing.

## How it works

The AI scripts assume the game's environment: imports spelled as VFS paths, and
globals like `Engine`, `uneval` and `Vector2D` already defined. `harness/`
supplies both.

| file | role |
|---|---|
| `harness/target.ts` | loads a module under test from the selected target |
| `harness/paths.ts` | where the targets live, and which one is selected |
| `harness/hooks.ts` | resolves `simulation/...` specifiers to real files |
| `harness/engine.ts` | the engine's global scope |
| `harness/world.ts` | fake game state builders |
| `harness/persistence.ts` | the save/reload checks |

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
import { loadPetraModule } from "./harness/target.ts";

const { Queue } = await loadPetraModule<{ Queue: new () => QueueLike }>("queue");
```

Two rules keep the suite useful as a check on the port:

- **Assert behaviour, not implementation.** "A queued technology is not
  duplicated", not "the loop compares `plan.type`". A test that restates the
  source cannot tell a rewrite from a regression.
- **Fake the smallest thing that works.** `harness/world.ts` throws on any method
  a test did not declare, so a test only depends on what it asked for. When the
  code under test needs more of the world, add that method in the test — do not
  widen the shared fake by default.

Where the port deliberately behaves differently from the original JS, say so in
a comment above the test and assert the behaviour that is wanted, not the
behaviour the original happened to have. The original then fails that test,
which is the point of running it against `ref`.

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
