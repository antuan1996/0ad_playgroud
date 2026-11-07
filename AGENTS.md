# Agent instructions

The Petra TypeScript AI port lives in
`binaries/data/mods/public/simulation/ai/petra_ts/` with build/check/match
tools in `build/petra_ts/`.

## Token and context efficiency

- **Read docs selectively, not upfront:**
  - Read `CLAUDE.md` only when you need architecture, test-harness, or
    convention details not covered below.
  - Read `PLAN.md` by section (e.g. `§1` constraints, `§3` types/layers, `§5`
    validation, `§6.2` active Stage 6 items) when planning or checking
    architectural/gameplay changes. Completed Stage 0–5 history is in
    `build/petra_ts/STAGE_HISTORY.md`.
  - Read `build/petra_ts/README.md` only when running or debugging matches,
    batches, baselines, or parity tools.
  - Never read `petra_ts/tests/FINDINGS.md` (2,100+ lines) in full: search it
    with `grep` and read only the matching section with `offset` and `limit`.
- **Use targeted reads on `petra_ts` code and tests:**
  - Several port modules and `tests/*.test.ts` files exceed 1,000–2,000 lines.
    Locate functions, classes, or test cases with `grep` first, then `read` a
    narrow slice (`offset` and `limit` of 80–150 lines) instead of full files.
- **Scope test, typecheck, and analysis commands:**
  - Always run `npm run format:petra` **before** any typecheck, test, or
    coverage command (their `pre*` hooks run `dprint check` and fail otherwise).
  - While iterating, run only the relevant test file and pattern:
    `npm run test:petra -- <name>.test.ts --test-name-pattern="<regex>"`
  - When running the full suite (`test:petra` or `test:petra:out`), pass
    `-- --test-reporter=dot` so 1,700+ passing test lines do not flood context.
  - `npm run typecheck:petra:tests` checks both the port and `tests/`; skip
    running `npm run build:petra` separately while iterating.
  - Scope quality, coverage, and structure tools to the edited module:
    - `npm run quality:petra -- --file <module> --top 5`
    - `npm run coverage:petra -- src --file <module>`
    - `npm run structure:petra -- --check --top 0`

## Mandatory Petra TypeScript formatting

After editing any Petra TypeScript source, test, declaration, or tool, run
`npm run format:petra` **before every typecheck or test run and before
committing**. If more edits follow, format them before the next check or test.
Do not merely inspect the formatter's diff: apply it.

- `npm run format:petra` formats `petra_ts/**/*.ts` and
  `build/petra_ts/**/*.ts` with dprint, using the root `dprint.json`.
- `npm run format:petra:check` is the non-mutating verification. Petra test and
  coverage npm scripts run it automatically, as does the pre-commit hook.
- Never format generated bots or match/batch output. In particular,
  `petra_out/`, `petra_generated/`, the baseline bots, and `build/petra_ts/`
  output directories are not formatter targets.

## Core `petra_ts` invariants

- **Layers (`PLAN.md` §3.4):** `adapter < world < execution < decision < root`.
  A module may only import its own layer or lower layers (including `import type`).
- **Strict typing (`structure:petra -- --check`):**
  - No `as` casts outside `adapter/brands.ts` (`as const` apart), and no `!`
    non-null assertions; use `requireValue`, `requireTemplate`, and
    `requireMetadata` (`adapter/entityExtend.ts`).
  - Branded IDs, coordinates, regions, times, templates, techs, and grid cells
    come from `adapter/brands.ts`.
  - Send commands only via `adapter/commands.ts` (`postCommand`, `debugShade`);
    read orders via `adapter/orders.ts` and unit states via `adapter/unitState.ts`.
  - `execution/` reaches `Headquarters` only through `hqOf(gameState)`
    (`execution/hq.ts`) and reads bases as `BaseView`s (`world/bases.ts`).
- **Quality & structure gates:** No function over 96 lines, cyclomatic 15,
  cognitive 25, depth 4, or 5 params, and 0 clones (`quality:petra`). Keep all
  `structure:petra` violation counts and single-module-only exports at 0.
- **No `.json` files under `simulation/ai/`** other than a bot's `data.json`.
