# petra_ts — TSC Error Snapshot

> Auto-generated snapshot of the current TypeScript compile errors for the
> `petra_ts` AI module. Intended as a reference for future work (triage / fixes).

- **Generated:** 2026-10-16 01:50 (local, MSK)
- **Reproduce with:** `npx tsc -p binaries/data/mods/public/simulation/ai/petra_ts/tsconfig.json`
  (i.e. the `build:petra` script in the root `package.json`)
- **tsconfig:** `strict: true`, `noEmit: true`, `noCheck: false`, target `ES2022`, module `ESNext`
- **tsc exit code:** `2` (errors present)

## Headline numbers

- **Total errors:** **706**
- **Files with errors:** **24** of **31** source `.ts` files (7 source files clean; `.d.ts` files excluded)
- **Dominant theme:** almost every error is a **strict `undefined` / `null` safety**
  complaint — values that TypeScript now treats as optional (Map/array/object access,
  optional chaining, possibly-uninitialized locals) are used where a concrete type is required.

## Breakdown by error code

| Code | Count | Meaning |
|------|------:|---------|
| `TS18048` | 229 | Identifier is possibly `undefined` (used directly) |
| `TS2345` | 218 | Argument of possibly-`undefined` type not assignable to a required parameter type |
| `TS2532` | 178 | Object is possibly `undefined` (property access on it) |
| `TS2322` | 33 | Assignment of possibly-`undefined` type to a concrete type |
| `TS2538` | 25 | `undefined` used as an index type |
| `TS18047` | 23 | Identifier is possibly `null` |

### Most frequent individual messages

| Message | Count |
|---------|------:|
| `Object is possibly 'undefined'.` | 178 |
| `Argument of type 'CommonPosition \| undefined' is not assignable to parameter of type 'CommonPosition'.` | 96 |
| `Argument of type 'number \| undefined' is not assignable to parameter of type 'number'.` | 75 |
| `'base' is possibly 'undefined'.` | 27 |
| `Type 'undefined' cannot be used as an index type.` | 25 |
| `Argument of type 'string \| undefined' is not assignable to parameter of type 'string'.` | 16 |
| `'template' is possibly 'null'.` | 15 |
| `'pos' is possibly 'undefined'.` | 14 |
| `'bestIdx' is possibly 'undefined'.` | 14 |
| `'request' is possibly 'undefined'.` | 13 |
| `Argument of type 'Entity \| undefined' is not assignable to parameter of type 'Entity'.` | 13 |
| `'hero' is possibly 'undefined'.` | 9 |
| `'structPos' is possibly 'undefined'.` | 8 |
| `'shipPosition' is possibly 'undefined'.` | 8 |
| `'entPos' is possibly 'undefined'.` | 8 |

## Breakdown by file (error count)

| File | Errors |
|------|------:|
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
| defenseArmy.ts | 27 |
| queueplanTraining.ts | 24 |
| startingStrategy.ts | 23 |
| mapModule.ts | 11 |
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
| `template` (possibly `null`) | 15 |
| `pos` | 14 |
| `bestIdx` | 14 |
| `request` | 13 |
| `hero` | 9 |
| `structPos` | 8 |
| `shipPosition` | 8 |
| `entPos` | 8 |
| `ent` | 7 |
| `newPos` | 6 |
| `bestbase` | 6 |
| `bestBase` | 5 |
| `bb` | 5 |
| `aa` | 5 |
| `capturableTarget` | 5 |
| `plan` | 4 |
| `oldPos` | 4 |
| `item` | 4 |
| `capturable` | 4 |

## Representative examples

```
attackManager.ts(170,44): error TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'.
attackManager.ts(218,18): error TS2532: Object is possibly 'undefined'.
attackManager.ts(239,10): error TS18048: 'structPos' is possibly 'undefined'.
attackManager.ts(588,15): error TS2538: Type 'undefined' cannot be used as an index type.
defenseManager.ts(64,66): error TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'.
entityExtend.ts(7,2): error TS2322: Type 'boolean | undefined' is not assignable to type 'boolean'.
mapModule.ts(29,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
navalManager.ts(205,58): error TS2345: Argument of type 'CommonPosition | undefined' is not assignable to parameter of type 'CommonPosition'.
transportPlan.ts(160,7): error TS2532: Object is possibly 'undefined'.
victoryManager.ts(765,3): error TS2532: Object is possibly 'undefined'.
```

## Changes since previous snapshot (2026-10-15 20:52)

- **Total errors: 919 → 706** (−213).
- **Files with errors: 26 → 24.** Two files became fully clean:
  - `worker.ts` (was 104 errors → 0)
  - `attackPlan.ts` (was 104 errors → 0)
- Minor reductions: `defenseArmy.ts` 28 → 27, `mapModule.ts` 15 → 11.
- The 3 `TS2769` (`.concat` overload) errors are gone (they lived in `attackPlan.ts`).
- Error-code mix shifted: `TS18048` is now the single largest category (229),
  edging past `TS2345` (218).

## Root-cause notes / suggested fix strategy

Nearly all 706 errors stem from `strict` null/undefined checking. Typical sources:

1. **`Map.get(...)` / object bracket access / array indexing** returning `T | undefined`
   and being passed on without a guard.
2. **Locals assigned inside a conditional** (e.g. `let pos: CommonPosition;` then used
   later) that TS cannot prove are initialized.
3. **Optional chaining results** (`a?.b`) used where a non-optional type is expected.

Common remedies (pick per-site):
- Add an explicit guard / early `continue`/`return` when the value is `undefined`.
- Provide a default (`map.get(k) ?? fallback`).
- Narrow with `if (x !== undefined)` / `if (x)` before use.

## How to regenerate

```bash
cd "$(git rev-parse --show-root 2>/dev/null || echo .)"   # repo root
npx tsc -p binaries/data/mods/public/simulation/ai/petra_ts/tsconfig.json
```

Counts can be re-derived with:
```bash
npx tsc -p .../petra_ts/tsconfig.json 2>&1 | grep -oE 'error TS[0-9]+' | sort | uniq -c | sort -rn
```
