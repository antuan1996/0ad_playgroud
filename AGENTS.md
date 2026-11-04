# Agent instructions

Read `CLAUDE.md` for the repository commands and conventions, and check work
against `PLAN.md`.

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
