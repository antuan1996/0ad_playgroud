# Petra TS: engineering plan

How Petra TS goes from a faithful port of Petra to a stronger AI, starting from
the state of branch `bugs_fixing` (2026-10-25). It answers the planning prompt
(goal, constraints, architecture, validation, roadmap); facts about the
project are referenced to the files that hold them.

## 0. Where the project stands

| Asset | Where | State |
|---|---|---|
| The port | `simulation/ai/petra_ts/*.ts` | One file per original `petra/*.js`; strict TypeScript, no `as` casts or `!` (`requireValue` where a value is guaranteed) |
| In-game bot | `simulation/ai/petra_out/` (generated) | `npm run build:petra:out`; bot id `petra_out`, "Petra TS" |
| Engine-facing types | `engine-api.d.ts`, `common-api.d.ts`, `globalscripts.d.ts`, `petra-runtime.d.ts` | `EntityId`, `PlayerId` are plain `number` aliases; commands are a union by `type` |
| Behaviour tests | `petra_ts/tests/`, harness in `tests/harness/` | 1532 tests on both targets; 95.6% real line coverage; the original fails 19, each a bug the port fixes |
| Findings | `tests/FINDINGS.md` | Bugs, port/original differences, shared quirks, unreachable code, match findings (§10–12) |
| Matches | `build/petra_ts/match.sh` | Deterministic headless or visual matches; records: statistics, timeline, commands, notices, bot state (`-b`), fingerprint, rerun line |
| Baselines | `build/petra_ts/baselines.ts`, tag `petra-ts-parity` | `petra_parity` (the port at the tag) and `petra_fixed` (original + patch), built as bots; with the 15-fix patch they play the same games (stage 1) |
| Parity tools | `command-diff.ts`, `parity-bisect.ts`, `baselines.ts hybrid` | Where two command logs part; which module makes a difference |
| Batches | `build/petra_ts/batch.ts`, `batch-stats.ts` | Parallel headless games with isolated `XDG_*` folders; `results.tsv`; win-rate with Wilson CI, SPRT, slot advantage, determinism |
| Integration test | `npm run test:petra:match` | One fixed mirror match, 13 anomaly checks on engine data only (`match-checks.ts`) |
| Upstream notes | `build/petra_ts/upstream/` | A patch of 15 fixes for the original, with which it plays as the port (stage 1); shared quirks; a `Commands.js` bug |

Known weaknesses, all shared with the original (`FINDINGS.md` §4, §11, §12):
the first field waits for fruit to run low (starvation on fruit-rich maps); a
finished attack withdraws into a civic centre's footprint (an army walking for
good); surplus workers stay idle once their base is gathered out; under
pressure, attack plans never fill; town phase waits for a population of 150.

## 1. Constraints that shape every stage

1. **Determinism, always.** The AI runs inside the lockstep simulation
   (`CCmpAIManager`'s `CAIWorker`): every multiplayer client runs it and
   replays re-run it, since AI commands are not recorded. Any divergence
   desyncs a game or breaks a replay. Rules: randomness only from the
   engine-seeded generator; no wall-clock time in decisions; iteration order
   from arrays or insertion-ordered maps, never from anything that differs
   between machines. Parity with Petra may go; determinism may not. Check:
   the same seeds twice give the same fingerprint (already how matches work).
2. **The engine interface.** Each turn the AI receives a structured-clone copy
   of the state `AIProxy`/`AIInterface` publish, and acts only through
   `Engine.PostCommand`. The engine's UnitAI owns unit state and changes it on
   its own (target exhausted, attacked, order refused); an order is a request,
   not a transition. Refusals reach the AI only as GUI notices (seen in
   `notices.txt`), not as results.
3. **The runtime.** SpiderMonkey; modules are loaded by VFS path
   (`prepare-bot.ts` rewrites imports); nothing outside the mod's files at
   runtime, so no npm libraries in the bot. The bot runs synchronously in the
   simulation turn (200 ms); Petra spreads its work by running the HQ update
   one turn in eight per player.
4. **Save games.** Every manager has `Serialize`/`Deserialize`. A new bot keeps
   them, versions its saved data, and refuses (with a message, then a fresh
   start) data from a version it cannot read.
5. **Two shipped bots.** `petra` (original) stays untouched in this repo;
   changes to it are proposed upstream (`upstream/petra-fixes.patch`).

## 2. Strategy: freeze, then evolve beside the baseline

- **Freeze the port.** Tag the current port (`petra-ts-parity`) and keep a copy
  of it built as its own bot, `petra_parity`, by `prepare-bot.ts` from the
  tag (a build step, not a second source tree). It is the fixed reference of
  every later stage.
- **Evolve `petra_ts` in place.** The 1:1 rule ends with the tag. Changes keep
  the tests green; a test that pins original behaviour the new bot changes on
  purpose is rewritten to the new behaviour with a note, or moved to a
  parity-only suite run against `petra_parity`.
- **Baselines for every measurement:** `petra_parity` (did this stage help?)
  and the original with `petra-fixes.patch` applied, built as `petra_fixed`
  (are we better than a fair Petra?). The unpatched original is no baseline:
  `removeSupply` cripples it in every game (§10: it lost 9 of 10 and never
  reached town phase).

## 3. Type-driven architecture

### 3.1 Typestates for lifecycles the AI owns

Plans are the AI's own objects, so their transitions can be enforced. Today
`attackPlan.state` is a string with three constants
(`unexecuted`, `completing`, `arrived`) and ad-hoc values (`"walking"`,
`"transporting"`, `""`), and `transportPlan.state` is `boarding`/`sailing`.

- Model each plan as a discriminated union of states, each carrying the data
  valid in it:
  ```ts
  type AttackState =
  	| { kind: "preparing"; queues: TrainingQueues; rallyPoint: WorldPos }
  	| { kind: "walking"; path: WorldPos[]; target: TargetRef }
  	| { kind: "transporting"; transport: TransportPlanId; target: TargetRef }
  	| { kind: "arrived"; target: TargetRef }
  	| { kind: "withdrawing"; to: WorldPos }
  	| { kind: "done"; outcome: "won" | "aborted" };
  ```
- Transitions are functions from one state type to the next
  (`launch(p: Preparing): Walking | Transporting`), so an illegal transition
  does not type-check; the plan holds the current state and switches on
  `kind` with an exhaustive `never` default.
- Order: attack plans (most states, most bugs: `Abort` at sea, the withdrawal
  into a civic centre), then transport plans, then construction and training
  plans and queue items.
- Serialization: each state serializes to a tagged record; `Deserialize`
  validates the tag and rebuilds the state, or rejects the save (constraint 4).

### 3.2 Parsing what the AI only observes

Unit and world state cannot be typestates (constraint 2). Instead, each turn:

- **Parse** the raw state into discriminated unions at one boundary, the
  engine adapter: `unitAIState()` strings like `INDIVIDUAL.GATHER.RETURNINGRESOURCE`
  become `{ kind: "gathering"; phase: "returning"; dropsite: EntityId }` and
  so on, with an `{ kind: "other"; raw: string }` case for states not modelled.
  The port already found that the engine can report no state at all (§2:
  `requireValue` on `unitAIState()` threw every turn), so "unknown" is a case,
  not an exception.
- **Reconcile intent with observation.** The AI keeps what it ordered (an
  intent per unit) and compares it with the parsed state; "ordered but not
  doing it" is a normal case with a handler (re-order, re-plan, give up),
  handled exhaustively. Two known weaknesses are exactly this gap: builders
  re-sent their orders every update while walking home (§4), and an army
  walking for good to an unreachable point (§4, `Abort`).
- **Refusals.** A command whose effect does not appear within a few turns is
  treated as refused; the notices (`notices.txt`) give the reasons while
  debugging, but the AI cannot rely on them.

### 3.3 Branded and phantom types

Brand the primitives that are mixed up today or easily could be:

| Brand | Replaces | Bug class it closes |
|---|---|---|
| `EntityId`, `PlayerId` | both `number` | passing one for the other: the game's `CanPlayerOrAllyControlUnit` does exactly this (`upstream/petra-fixes.md`, Part 3) |
| `TemplateName` (and civ-applied `ResolvedTemplate`) | `string` | using `structures/{civ}/field` where the civ-applied name is needed |
| `ClassName`, `ClassList` | `string`, `string[]` | the original's `byClass(["Palisade", "Wall"])`, which never matches (§1) |
| `WorldPos` (`[x, z]` in metres) | `number[]` | |
| `CellIndex<Map>` (phantom: which InfoMap/grid) | `number` | indexing one map with another's cell index; cell sizes differ (territory, passability, accessibility) |
| `AccessIndex`, `SeaIndex` | `number` | comparing a land region with a sea index |
| `GameMs`, `GameSeconds` | `number` | `elapsedTime` is seconds, the timer and commands use milliseconds |

Conversions live in one module (`gamePosToMapPos` and friends) and are the
only way to cross between brands. Brands cost nothing at runtime (they are
intersections with a phantom tag, erased by `tsc`).

### 3.4 Module boundaries

```
adapter/    engine state in, commands out: parse (3.2), brands (3.3), the
            command builders (typed by the commands union in engine-api.d.ts)
world/      the AI's model: bases, resources, threats, maps; read-only to the
            layers above (readonly types)
decision/   what to do: economy, build order, military; swappable
execution/  plans with typestates (3.1): turns decisions into commands,
            reconciles intent with observation
```

- Only `adapter/` touches `Engine`, `gameState` and raw entities; `decision/`
  sees `world/` through readonly interfaces, so a decision layer cannot
  mutate the model or issue commands directly.
- **Decision engines that fit the budget:** utility scoring (per-turn,
  bounded work, easy to tune from match data) as the first replacement for
  Petra's hand-written thresholds; behaviour trees or goal-oriented planning
  for multi-step military behaviour. **Search** (MCTS and similar) is not
  feasible as the main engine: there is no forward model of the game in the
  AI context and the turn budget is small. It is feasible in narrow, cheap
  models: a build-order planner over a resource-rate model, or a
  fight-outcome estimator over unit stats, each run rarely and time-boxed.
- The port is reshaped into these layers gradually (stage 3), not rewritten:
  each move keeps the tests and the integration match green.

## 4. Performance: measure first

- **Measure** AI time per turn in headless matches. The bot already wraps its
  update in `Engine.ProfileStart`/`ProfileStop` (`_petrabot.ts`), which the
  engine's profiler reports; to verify: how to read that from a headless run,
  or a debug-only wrapper (like `bot-state.js`) that times `OnUpdate` with an
  engine clock and prints it outside the fingerprinted output.
- **Budget:** pick it from the measurements (e.g. the 99th-percentile turn of
  a 300-population late game), and add a check to the integration match.
- **Optimise only what the profile shows.** Likely candidates, from the code:
  `updatingCollection` filters re-evaluated per call, entity scans per turn,
  repeated territory/accessibility lookups. Object pooling is not planned:
  the engine hands the AI a fresh copy of the state each turn anyway, so GC
  pressure from the AI's own temporaries is only worth attacking if measured.
  `readonly` types (3.4) are for correctness, not speed.

## 5. Validation

### 5.1 Parity of the frozen baseline

- Diff the command logs (`match.sh -l`, `commands.txt`) of `petra_parity` and
  `petra_fixed` on fixed seeds, slots swapped too (`-x`); the first differing
  line is the next thing to explain. Already shown once: with only
  `removeSupply` patched into the original, its 10313 commands matched the
  port's for the whole run compared (§10).
- Target: identical command logs on a set of seeds (say 10, mainland, very
  hard), or every difference explained in `FINDINGS.md` §3.
- **Done (stage 1, `FINDINGS.md` §14):** identical logs on 26 seed pairs from
  both slots. Every difference found was a bug of the original the port had
  fixed, now in the patch (15 fixes). Tools: `batch.ts -- -l` with
  `--slots both`, `command-diff.ts <batch>` (each pair's two logs must be
  the same), `parity-bisect.ts` (hybrids of `petra_fixed` with one port module
  find the module that makes a difference). Rerun the batch when the patch or
  the tag changes; a new difference is a stage-1 item again.

### 5.2 Every change

- `npm run build:petra`, `npm run typecheck:petra:tests`, `npm run test:petra`
  (and `-- ref` while parity tests remain).
- `npm run test:petra:match`: the fixed match and its anomaly checks; the
  fingerprint is printed, not asserted (any behaviour change moves it).
- Determinism: the integration match run twice gives the same fingerprint.
- Save/load: the persistence round trips in the tests (`persistence.ts`),
  plus an in-game check once a stage touches serialized data: save at a
  minute, reload, play on (to define: a scripted autosave in a headless run).

### 5.3 Strength

- **Pool:** maps (mainland first; then a few of different kind: a naval map,
  a forest-heavy one, a small one), civilisations (start with athen, then a
  sample), difficulty very hard, both slots. Fixed seed lists per pool, so a
  result is reproducible.
- **Statistic:** win-rate against each baseline, with a Wilson confidence
  interval; for go/no-go decisions, a sequential probability ratio test
  (SPRT) between H0 = 50% and H1 = the gain worth having. Rough sample sizes
  for a fixed one-sided test at α = β = 0.05: about 1080 games to tell 55% from 50%,
  about 270 for 60%; SPRT needs on average roughly half. Time-limited games
  (`-T`) count as draws, or are excluded and reported.
- **Supporting metrics,** from the existing records: time to town and city
  phase; resources gathered and used per minute; units lost per enemy unit
  killed (and in value, `unitsLostValue`); peak and mean map control; idle
  workers (timeline); commands per minute (commands log). They explain a
  result; the win-rate decides.
- **Throughput:** `batch.ts` runs games in parallel, each job with its own
  `XDG_*` folders: at 12 at a time, 50–60 s of wall time per game, about 100
  games in 8 minutes (1000 games in under 1.5 hours). Results go to one table
  (`results.tsv`: seeds, slot, bots, outcome, decision time, metrics).
- **Slots:** player 2 wins more mirror games (42.2% for player 1, CI
  35.6–49.0%, §13). Compare two bots only from both slots (`--slots both`,
  the default for two bots), never from fixed ones.
- **Crashes:** the engine aborts in about 1 game in 150 (a futex error, not
  reproducible); `batch.ts` books it as failed and a resumed batch replays it.
  If it gets more frequent with more jobs, look into the engine.

### 5.4 Property-based tests

On the existing harness (fake worlds, real InfoMaps): generate worlds and
assert invariants rather than examples. A generator library would be a
dev-only dependency (tests run on Node, not in the engine). Candidates:

- a planned building never overlaps an obstruction and lies in own territory;
- every worker ends a turn with a role and a reachable target, or idle;
- a withdrawal or rally point is reachable (would have caught `Abort`);
- serialization round-trips any reachable plan state (3.1);
- resource accounts never go negative, and reserved never exceeds owned.

## 6. Roadmap

Each stage ends on a measurable exit criterion; strength claims use 5.3.

| Stage | Work | Exit criterion |
|---|---|---|
| 0. Baselines (**done** 2026-10-25, `FINDINGS.md` §13) | Tag the port; build `petra_parity` and `petra_fixed` as bots; parallel headless runs (5.3); a results table | 100 mirror games of each baseline run in parallel without a path clash; `petra_parity` vs `petra_fixed` ~50% (no significant difference). Met: 315 games at 12 at a time, no clash, 15/15 repeats with the same fingerprint; 51.0% (CI 41.5–60.4%) |
| 1. Parity proof (**done** 2026-10-25, `FINDINGS.md` §14) | Command-log diffs on a seed set (5.1), starting with the 6 seed pairs where the baselines differ (`FINDINGS.md` §13); explain every difference | Identical logs, or each difference in `FINDINGS.md` §3. Met: identical in 26 of 26 pairs (52 games) once three more original bugs went into the patch |
| 2. Types in place | Brands (3.3) through the port, starting with `EntityId`/`PlayerId`/`WorldPos`; attack-plan typestate (3.1) | Typecheck clean, tests green, fingerprint of the integration match unchanged (pure refactor) |
| 3. Layers | Adapter and observation parsing (3.2), world model, execution; decisions still Petra's logic | Same fingerprint as stage 2, or every change explained; AI time per turn within budget (4) |
| 4. Fix the known weaknesses | Withdrawal to a reachable point; idle workers re-homed to bases with resources; first field by food income, not fruit left; attacks that cannot fill are cancelled or merged; reconsider the town-phase population | Each: an integration check or property test that fails before and passes after; then win-rate vs `petra_parity` > 50% at 95% (SPRT) |
| 5. Utility decisions | Replace threshold rules with utility scores, one domain at a time (economy mix, build order, attack timing), tuned on match data | Each domain: no win-rate loss vs the previous stage; together: a significant gain vs `petra_fixed` |
| 6. Narrow search | Build-order planner and fight estimator (3.4), time-boxed | Gain vs stage 5 (SPRT); turn budget kept |

Running throughout: determinism and save/load checks (5.2), `FINDINGS.md`
for what each stage finds, and upstream reports for bugs that are the
original's or the game's (`build/petra_ts/upstream/`).

## 7. Open questions

- Reading the engine profiler in a headless run, or which clock the AI context
  offers for a debug-only timer (4).
- Answered in stage 0: `XDG_*` per run is enough to isolate parallel engines
  (config, cache, replays and logs all follow it); `-writableRoot` is not
  needed (5.3, `FINDINGS.md` §13).
- Why player 2 wins more mirror games (5.3).
- Which civilisations and maps make the pool, given the time per game.
- Whether to keep testing against the original (`ref`) once the bot
  diverges, or only against `petra_parity` (2).
