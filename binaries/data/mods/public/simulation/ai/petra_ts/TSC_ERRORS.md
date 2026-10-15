# petra_ts — TSC Error Snapshot

> Auto-generated snapshot of the current TypeScript compile errors for the
> `petra_ts` AI module. Intended as a reference for future work (triage / fixes).

- **Generated:** 2026-10-15 20:52 (local)
- **Reproduce with:** `npx tsc -p binaries/data/mods/public/simulation/ai/petra_ts/tsconfig.json`
  (i.e. the `build:petra` script in the root `package.json`)
- **tsconfig:** `strict: true`, `noEmit: true`, `noCheck: false`, target `ES2022`, module `ESNext`
- **tsc exit code:** `2` (errors present)

## Headline numbers

- **Total errors:** **919**
- **Files with errors:** **26** of **31** source `.ts` files (5 source files clean; `.d.ts` files excluded)
- **Dominant theme:** almost every error is a **strict `undefined` / `null` safety**
  complaint — values that TypeScript now treats as optional (Map/array/object access,
  optional chaining, possibly-uninitialized locals) are used where a concrete type is required.

## Breakdown by error code

| Code | Count | Meaning |
|------|------:|---------|
| `TS2345` | 310 | Argument of possibly-`undefined` type not assignable to a required parameter type |
| `TS18048` | 265 | Identifier is possibly `undefined` (used directly) |
| `TS2532` | 224 | Object is possibly `undefined` (property access on it) |
| `TS2538` | 48 | `undefined` used as an index type |
| `TS2322` | 42 | Assignment of possibly-`undefined` type to a concrete type |
| `TS18047` | 27 | Identifier is possibly `null` |
| `TS2769` | 3 | No overload matches this call (bad `.concat` arg type) |

### Most frequent individual messages

| Message | Count |
|---------|------:|
| `Object is possibly 'undefined'.` | 224 |
| `Argument of type 'CommonPosition \| undefined' is not assignable to parameter of type 'CommonPosition'.` | 136 |
| `Argument of type 'number \| undefined' is not assignable to parameter of type 'number'.` | 119 |
| `Type 'undefined' cannot be used as an index type.` | 48 |
| `Argument of type 'string \| undefined' is not assignable to parameter of type 'string'.` | 19 |
| `Argument of type 'Entity \| undefined' is not assignable to parameter of type 'Entity'.` | 16 |
| `Type 'number \| undefined' is not assignable to type 'number'.` | 10 |
| `Argument of type 'CommonResourceAmounts \| undefined' ...` | 6 |
| `Type 'boolean \| undefined' is not assignable to type 'boolean'.` | 7 |

## Breakdown by file (error count)

| File | Errors |
|------|------:|
| worker.ts | 104 |
| attackPlan.ts | 104 |
| defenseManager.ts | 83 |
| headquarters.ts | 71 |
| transportPlan.ts | 69 |
| victoryManager.ts | 46 |
| basesManager.ts | 45 |
| navalManager.ts | 43 |
| entityExtend.ts | 42 |
| baseManager.ts | 36 |
| tradeManager.ts | 34 |
| queueplanBuilding.ts | 32 |
| diplomacyManager.ts | 32 |
| attackManager.ts | 30 |
| garrisonManager.ts | 28 |
| defenseArmy.ts | 28 |
| queueplanTraining.ts | 24 |
| startingStrategy.ts | 23 |
| mapModule.ts | 15 |
| queue.ts | 9 |
| researchManager.ts | 8 |
| queueplanResearch.ts | 5 |
| queueManager.ts | 4 |
| chatHelper.ts | 2 |
| queueplan.ts | 1 |
| buildManager.ts | 1 |

## Most common offending identifiers (undefined-safety)

These are the variables/fields most often flagged as possibly `undefined`
(`TS18048` / `TS18047`):

| Identifier | Times flagged |
|------------|------:|
| `base` | 27 |
| `structPos` | 18 |
| `pos` | 14 |
| `bestIdx` | 14 |
| `request` | 13 |
| `hero` | 9 |
| `shipPosition` | 8 |
| `plan` | 8 |
| `entPos` | 8 |
| `ent` | 7 |
| `newPos` | 6 |
| `bestbase` / `bestBase` | 11 |
| `template` (possibly `null`) | 15 |

## Representative examples

```
attackManager.ts(170,44): error TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'.
attackManager.ts(218,18): error TS2532: Object is possibly 'undefined'.
attackManager.ts(239,10): error TS18048: 'structPos' is possibly 'undefined'.
attackManager.ts(588,15): error TS2538: Type 'undefined' cannot be used as an index type.
attackPlan.ts(1773,110): error TS2769: No overload matches this call.  (bad .concat arg)
worker.ts(1144,35): error TS18048: 'approachingTime' is possibly 'undefined'.
```

## Root-cause notes / suggested fix strategy

Nearly all 919 errors stem from `strict` null/undefined checking. Typical sources:

1. **`Map.get(...)` / object bracket access / array indexing** returning `T | undefined`
   and being passed on without a guard.
2. **Locals assigned inside a conditional** (e.g. `let pos: CommonPosition;` then used
   later) that TS cannot prove are initialized.
3. **Optional chaining results** (`a?.b`) used where a non-optional type is expected.

Common remedies (pick per-site):
- Add an explicit guard / early `continue`/`return` when the value is `undefined`.
- Provide a default (`map.get(k) ?? fallback`).
- Narrow with `if (x !== undefined)` / `if (x)` before use.
- For `TS2769` (`.concat`): the receiver array is inferred as `never[]`; annotate its
  element type.

## How to regenerate

```bash
cd "$(git rev-parse --show-root 2>/dev/null || echo .)"   # repo root
npx tsc -p binaries/data/mods/public/simulation/ai/petra_ts/tsconfig.json
```

Counts can be re-derived with:
```bash
npx tsc -p .../petra_ts/tsconfig.json 2>&1 | grep -oE 'error TS[0-9]+' | sort | uniq -c | sort -rn
```
