# petra_ts - TSC Error Snapshot

> Auto-generated snapshot of the current TypeScript compile errors for the
> `petra_ts` AI module. Intended as a reference for future work (triage / fixes).

- **Generated:** 2026-10-17 (local, MSK) - refreshed after fixing `transportPlan.ts`, `victoryManager.ts`, `basesManager.ts`
- **Reproduce with:** `npx tsc -p binaries/data/mods/public/simulation/ai/petra_ts/tsconfig.json`
  (i.e. the `build:petra` script in the root `package.json`)
- **tsconfig:** `strict: true`, `noEmit: true`, `noCheck: false`, target `ES2022`, module `ESNext`
- **tsc exit code:** `2` (errors present)

## Headline numbers

- **Total errors:** **262** (was 385; -123 after fixing the 3 files below)
- **Files with errors:** **19** of **31** source `.ts` files (12 source files clean; `.d.ts` files excluded)
- **Now clean (0 errors):** `transportPlan.ts`, `victoryManager.ts`, `basesManager.ts`
- **Dominant theme:** almost every error is a **strict `undefined` / `null` safety**
  complaint - values that TypeScript now treats as optional (Map/array/object access,
  optional chaining, possibly-uninitialized locals) are used where a concrete type is required.

## Breakdown by error code

| Code | Count | Meaning |
|------|------:|---------|
| `TS18048` | 88 | Identifier is possibly `undefined` (used directly) |
| `TS2532` | 79 | Object is possibly `undefined` (property access on it) |
| `TS2345` | 44 | Argument of possibly-`undefined` type not assignable to a required parameter type |
| `TS2322` | 24 | Assignment of possibly-`undefined` type to a concrete type |
| `TS18047` | 20 | Identifier is possibly `null` |
| `TS2538` | 7 | `undefined` used as an index type |

### Most frequent individual messages

| Message | Count |
|---------|------:|
| `Object is possibly 'undefined'.` | 79 |
| `Argument of type 'number | undefined' is not assignable to parameter of type 'number'.` | 17 |
| `'template' is possibly 'null'.` | 14 |
| `'request' is possibly 'undefined'.` | 13 |
| `Argument of type 'string | undefined' is not assignable to parameter of type 'string'.` | 10 |
| `Type 'boolean | undefined' is not assignable to type 'boolean'.` | 7 |
| `Type 'undefined' cannot be used as an index type.` | 7 |
| `Argument of type 'Entity | undefined' is not assignable to parameter of type 'Entity'.` | 7 |

## Per-file error counts (descending)

| File | Errors |
|------|------:|
| `diplomacyManager.ts` | 29 |
| `entityExtend.ts` | 26 |
| `queueplanBuilding.ts` | 25 |
| `baseManager.ts` | 25 |
| `tradeManager.ts` | 24 |
| `queueplanTraining.ts` | 22 |
| `garrisonManager.ts` | 22 |
| `navalManager.ts` | 19 |
| `defenseArmy.ts` | 13 |
| `attackManager.ts` | 10 |
| `queue.ts` | 9 |
| `mapModule.ts` | 9 |
| `startingStrategy.ts` | 8 |
| `researchManager.ts` | 8 |
| `queueplanResearch.ts` | 5 |
| `queueManager.ts` | 4 |
| `chatHelper.ts` | 2 |
| `queueplan.ts` | 1 |
| `buildManager.ts` | 1 |
| `transportPlan.ts` | 0 (fixed) |
| `victoryManager.ts` | 0 (fixed) |
| `basesManager.ts` | 0 (fixed) |

## Fix approach applied to the 3 fixed files

All fixes preserve runtime behaviour (no `!`/`??` shortcuts that change semantics):

1. **Possibly-undefined identifier/object** (`TS18048`/`TS2532`): add an explicit
   guard (`if (!x) continue/return;`) or hoist the value into a `const` and guard it
   before use. For `else`/`for` single-statement bodies, wrap in `{ }` when introducing
   a `const`.
2. **Argument / assignment of optional type** (`TS2345`/`TS2322`): guard the value
   first, or capture it in a `const` after a narrowing check.
3. **Index type** (`TS2538`): guard the index (`if (idx !== undefined && arr[idx])`).
4. **Arithmetic on optional metadata** (`getMetadata(...)` returns optional): use
   `?? NaN` so comparisons stay `false` exactly like the original JS `NaN` semantics
   (never `?? 0`, which would flip a comparison).
5. **Optional class field** (`this.sea` declared `number | undefined`): guard before
   passing to `getBoardingPos`/array index, or capture into a local and guard.
