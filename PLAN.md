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
| Engine-facing types | `engine-api.d.ts`, `common-api.d.ts`, `globalscripts.d.ts`, `petra-runtime.d.ts` | `EntityId`, `PlayerId`, `WorldPos`, `MapPos`, `AccessIndex`/`SeaIndex`, `GameMs`/`GameSeconds`, `TemplateName`, `CellIndex<Grid>` are branded (stage 2; conversions in `petra_ts/brands.ts`); commands are a union by `type` |
| Behaviour tests | `petra_ts/tests/`, harness in `tests/harness/` | 1568 tests on the sources and the built bot, importing and typed by the port; 29 pin a bug of the original the port fixes (it failed the first 20 when it was last a target, stage 3) |
| Findings | `tests/FINDINGS.md` | Bugs, port/original differences, shared quirks, unreachable code, match findings (§10–12) |
| Matches | `build/petra_ts/match.sh` | Deterministic headless or visual matches; records: statistics, timeline, commands, notices, bot state (`-b`), fingerprint, rerun line |
| Baselines | `build/petra_ts/baselines.ts`, tag `petra-ts-parity` | `petra_parity` (the port at the tag) and `petra_fixed` (original + patch), built as bots; with the 15-fix patch they play the same games (stage 1) |
| Parity tools | `command-diff.ts`, `parity-bisect.ts`, `baselines.ts hybrid` | Where two command logs part; which module makes a difference |
| Batches | `build/petra_ts/batch.ts`, `batch-stats.ts` | Parallel headless games with isolated `XDG_*` folders; `results.tsv`; win-rate with Wilson CI, SPRT, slot advantage, determinism |
| Turn timing | `match.sh -P`, `ai-times.ts`, `CCmpAIManager.cpp` | Each AI's script time per turn, measured by the engine (two clock reads, about 27 ns, kept in memory); the paired budget check `ai-times.ts --compare` |
| Layers | `petra_ts/{adapter,world,decision,execution}/` | Stage 3 done: the folders, unit state parsed (`unitState.ts`), one command exit (`commands.ts`), versioned saves, the read-only base view |
| Smoke test | `npm run test:petra:smoke`, `build/petra_ts/smoke/reference.tsv` | 24 fixed games vs `petra_parity` compared game for game with a recorded reference: a refactor leaves all identical |
| Attack log | `match.sh -b` (`attacks.txt`), `batch.ts --bot-state`, `attack-log.ts` | Every attack plan's life and what it lacked; with the replays' 30 s statistics, the paired games of a batch compared slot against slot |
| Economy log | `match.sh -b` (`economy.txt`), `economy-log.ts` | Every 30 s: the bot's gather-rate estimate and wanted rates against the real income, gatherers and what they do, trip lengths, the start's supply layout |
| Early proxy | `pair-score.ts` | The lead at minute 8 per seed pair, with its worth as a predictor and a pair-by-pair comparison of two batches (§5.3) |
| Integration test | `npm run test:petra:match` | One fixed mirror match, 13 anomaly checks on engine data only (`match-checks.ts`) |
| Upstream notes | `build/petra_ts/upstream/` | A patch of 15 fixes for the original, with which it plays as the port (stage 1); shared quirks; a `Commands.js` bug |

The weaknesses stage 4 started from (`FINDINGS.md` §4, §11, §12) are fixed
or found not to decide games (§16): the withdrawal into a civic centre's
footprint, mercenaries booked as workers, attacks that never ended, plans
churned at the population cap; the first field and the town-phase population
do not lose the games that were blamed on them, and attacks that never fill
belong to a side that already lost. What decides the games is a production
lead of a few units at minutes 7-8, from how fast food and wood come in at
the start, amplified by the first fight (§16): stage 5. Its first measurement
(§18) found the economy's own gauge broken: since an engine change, every read
of a unit's orders failed and the gather-rate estimate was 0. Reading them
again (stage 5's first change) gives 62.9% against `petra_parity` (CI
57.3-68.2%, 150 fresh seed pairs, SPRT accepts 55%).

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
  (are we better than a fair Petra?). Since stage 5's checkpoint (§6.1) the
  strength comparisons use `petra_parity` alone: the two play the same games
  command for command (stage 1), and the checkpoint gave both the same 300
  results; `petra_fixed` stays for the parity tools (`parity-bisect.ts`,
  `baselines.ts hybrid`). The unpatched original is no baseline:
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
- **Done in stage 2, the state kind:** `attackPlan.ts` declares
  `AttackTransitions` (each state and the states it may move to; the values
  are the strings Petra saves, with names now for `"walking"`,
  `"transporting"` and the attacking `""`), `state: AttackPlanState`, and
  `changeState(from, to)`, which only type-checks for a listed move and warns
  if the plan is not where its caller says. `Deserialize` parses the saved
  tag and sends a plan with an unknown one back to preparation.
- **Deferred, the data per state:** in Petra's logic the data spans the
  states (the target is chosen and updated in all of them, the path is
  computed while preparing), so moving it into the states changes the logic,
  not only its types. It goes with stage 4, where the withdrawal and the
  attack's handling are rewritten anyway.

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
| `TechName` (stage 4, 3.5) | `string` | looking a technology up as an entity template: `getTemplate` returns a `Technology` for it, and `QueuePlan<T>` keeps the two apart |
| `ClassName`, `ClassList` | `string`, `string[]` | the original's `byClass(["Palisade", "Wall"])`, which never matches (§1) |
| `WorldPos` (`[x, z]` in metres) | `number[]` | |
| `CellIndex<Map>` (phantom: which InfoMap/grid) | `number` | indexing one map with another's cell index; cell sizes differ (territory, passability, accessibility) |
| `AccessIndex`, `SeaIndex` | `number` | comparing a land region with a sea index |
| `GameMs`, `GameSeconds` | `number` | `elapsedTime` is seconds, the timer and commands use milliseconds |

Done in stage 2, all of them, in `petra_ts/brands.ts`. Two notes from doing
it: a time loses its brand in arithmetic (`elapsedTime + 20` is a plain
number, marked again with `seconds()`), so the brand guards what a time is
stored as, not every sum; and a record keyed by a `for...in` key keeps
`number` keys, since a branded key cannot index it (a `Map` would, but it
iterates in insertion order where an object lists integer keys in ascending
order: a behaviour change, for stage 3).
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

### 3.5 Type hygiene

The port compiles under `strict`, but strict mode lets some holes through.
A review in stage 4 (`FINDINGS.md` §17) closed most of them: no `as` cast
outside `adapter/brands.ts`, no `!`, no `any` (written or inferred), no reads
of common-api's private fields, typed save data, `TechName` apart from
`TemplateName`. The second round, in this order, is done too (every step
with the integration match's fingerprint unchanged, and a 24-game batch
identical game for game before and after):

1. **Done.** `Template.get(path)` returns `unknown`; the footprint (seven
   copies of the same code), the obstruction shapes and the attack bonuses
   are read by `adapter/templateData.ts`. The bonuses' declared type was
   wrong (an array of numbers; the template holds an object of strings).
2. **Done.** No `any` left in the declarations: `ResourcesManager` is its
   methods intersected with `{ [resource: string]: number }` (a class whose
   methods share its object cannot type its string index), the metadata
   writes are typed by key as the reads were (which found `transporter`
   declared an entity id: it is a transport plan's), `queryInterface` is
   `unknown`.
3. **Done.** `UnitPlan` (`AttackPlanId | -1 | -2 | -3`) for the `plan`
   metadata, `AttackPlanId` a brand; `execution/unitPlan.ts` names the
   three states (out of any plan; lent while it had one; lent while it had
   none) and the lend and release the defense army and the garrison
   manager each wrote out.
4. **Done.** Queue names: `ConfiguredQueueName`, the attack plans'
   `` `plan_${number}` `` (with `_champ`, `_siege`), the collection typed
   by them; the queue manager walks its queues lazily in their own order.
5. Long functions (19 over 150 lines): split with the behaviour work of
   stages 4-5, not on their own.
6. **Done.** `===` throughout (531 by the checker's types, where the two
   operators cannot differ; the rest read one by one), the aliases for the
   inline `import()` types, no `for...in` over arrays, the attack records
   keyed by `AttackType`. The records keyed by player or entity id stay
   objects: a `Map` would change their iteration order (stage 5).
7. **Done.** "Nothing found" is `undefined`, not `null`; the plans' saves
   typed in `QueuePlan`; module constants `const` (an importer cannot
   reassign another module's `let`, so the mods' reason did not hold).
8. `declare` fields. A `declare` field is not checked for being assigned
   before it is read. **Done in stage 4:** 115 of the 133 assigned in their
   own constructor lost it; the other 18 are assigned only on some paths
   (the attack and transport plans' constructors return early when a plan
   fails). **Stage 5:** those 18, the 12 in subclasses (a plain field would
   overwrite what `super()` set; the value goes to the base constructor
   instead) and the 57 set only in `init()`, `Deserialize` or later (the
   two-step set-up of managers and plans: a constructor that can compute
   them, or a type that admits their absence), as each class is rewritten.

A third round (done, the same checks, the 24 games identical again):
`BaseId`, `ArmyId`, `TransportPlanId` brands (with `NO_BASE`, and `NEW_BASE`
and `NEW_ANCHORLESS_BASE` for the foundations that found a base); plan
metadata typed as the entity metadata it becomes (`PlanMetadata extends
Partial<PetraEntityMetadata>`; `train`/`construct` take it); `WorkerRole`
and `WorkerSubrole` unions for `role`/`subrole`; `plansIn()` for the loop
over every attack plan; no callback restating its types; `debugWarn(config,
level, () => message)` for the single-warning debug guards; and
`noUnusedLocals` on for the port, after removing what it found (unused
imports, a loop the original also left doing nothing, unused test names).

## 4. Performance: measure first

- **Measure** (done, stage 3): the engine times each AI's script call when
  `PYROGENESIS_AI_TIMES` names a file (`match.sh -P`): two `timer_Time()`
  reads around the shared component and each player's `Run`, kept in a
  preallocated vector and written once when the game ends. One timed call
  costs about 27 ns (two clock reads and a store) against a median AI turn of
  about 0.5 ms; nothing is printed during the game, and no bot code changes,
  so the times are the bot's and the game is the same. Wall-clock times
  include garbage collection (as in a real game) and the machine's load:
  measure with few jobs at a time.
- **Baseline** (stage 2's bot, 20 mirror games, mainland, very hard, 4 at a
  time; 193,206 turns): the whole turn (shared component and both AIs) takes
  1.96 ms on average, median 0.60, 99th percentile 12.5, 99.9th 68, at worst
  351 ms; the 99th percentile grows from 7 ms in the first ten minutes to 34
  ms at 30–40 minutes. In the mirror games the two sides' 99.9th percentiles
  differ by a third (41 and 30 ms): the games are not symmetric.
- **Budget**, so a paired test: the new bot plays `petra_parity` from both
  slots (`batch.ts --red petra_parity -- -P`, then `ai-times.ts --compare`);
  while a refactor keeps the fingerprint the two play the same games, and each
  turn is timed for both on the same game at the same moment. The new bot's
  mean and 99th percentile may be at most 5% above `petra_parity`'s, its 99.9th
  at most 10%. Stage 3 so far (20 games, 208,906 turns each): ratios 1.002
  (mean), 0.994 (99th), 1.001 (99.9th), the same games in all 10 seed pairs;
  with the execution layer behind `hqOf` (20 other games, 203,382 turns
  each): 1.010, 1.001, 1.024, again the same games in all 10 pairs. The
  single worst turn varies by run (ratio 0.99 and 1.16), so it is no budget.
  With the world state moved into `world/` behind accessors of the old names,
  the check failed: 1.052 (mean), 1.096 (90th), 1.042 (99th), the accessors
  being read on hot paths (`territoryMap` about 90 times, the supply lists in
  the worker's searches). With the port reading the world objects directly
  (the accessors kept for saves and tests), the same 20 games give 1.007,
  1.011, 0.997 and 0.989 (99.9th). So the check catches a few percent.
  Once the bot plays differently (stage 4 on), the games are no longer the
  same and the comparison needs more games.
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
  and `npm run test:petra:out`.
- `npm run test:petra:match`: the fixed match and its anomaly checks; the
  fingerprint is printed, not asserted (any behaviour change moves it).
- `npm run test:petra:smoke`: 24 fixed games (12 seed pairs from both slots,
  `petra_out` against `petra_parity`, about 3 minutes) compared game for game
  with the recorded `build/petra_ts/smoke/reference.tsv`. A refactor must
  leave all 24 identical; a change meant to alter play lists the games it
  moved, and is recorded with `--update` in the same commit. It is a check
  that play did (not) change, not a measure of strength (5.3).
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
- **Against the previous version:** `petra_prev` ("Petra TS previous",
  `baselines.ts prev`) is the port at the tag `petra-ts-prev`; each stage-5
  change plays it head to head, on a seed pool it was not tuned on, and the
  tag moves to a change once it is kept.
- **Early proxy** (`pair-score.ts`): blue's lead in resources gathered (and
  units trained) at minute 8, the mean of a seed pair's two games. A bot that
  plays as its opponent until then scores exactly 0, so the score has no
  noise of its own and shows a change to the start after a few dozen pairs
  (`alpha` 0.6: +111 ± 96 over 93 pairs, where the win-rate showed nothing);
  the side ahead in gathering at minute 8 won 79% of stage 4's games. It
  chooses which variants deserve an SPRT; it decides nothing.
- **Throughput:** `batch.ts` runs games in parallel, each job with its own
  `XDG_*` folders: at 12 at a time, 50–60 s of wall time per game, about 100
  games in 8 minutes (1000 games in under 1.5 hours). Results go to one table
  (`results.tsv`: seeds, slot, bots, outcome, decision time, metrics).
- **Same starts:** `random/mainland_mirror` gives both players the same land
  (one half turned onto the other). The start's layout turned out to be a
  small part of the noise: on it half the seed pairs still split, and the
  interval is as wide as on Mainland (`FINDINGS.md` §22). It checks that a
  gain does not depend on unequal starts; Mainland decides.
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
| 2. Types in place (**done** 2026-10-25) | Brands (3.3) through the port, starting with `EntityId`/`PlayerId`/`WorldPos`; attack-plan typestate (3.1) | Typecheck clean, tests green, fingerprint of the integration match unchanged (pure refactor). Met: fingerprint `2164cc14d7c5e28f` before and after; 1533 tests pass. Every brand of 3.3: `EntityId`, `PlayerId`, `WorldPos`, `MapPos`, `AccessIndex`/`SeaIndex` (`RegionIndex` for either), `GameMs`/`GameSeconds`, `TemplateName`, `CellIndex<"territory" \| "passability">`; the attack plan's state kind is a typestate (3.1); the data-carrying states move to stage 4, records keyed by `for...in` keys to stage 3 |
| 3. Layers (**done** 2026-10-26, `FINDINGS.md` §15) | Adapter and observation parsing (3.2), world model, execution; decisions still Petra's logic | Same fingerprint as stage 2, or every change explained; AI time per turn within budget (4). Met: the layer folders; `unitState.ts`, `commands.ts`, `SAVE_VERSION`; the execution layer reaches the HQ only through a read-only view (`execution/hq.ts`) and reads bases as `BaseView`s; the maps and regions (`world/geography.ts`) and the bases' resource model (`world/baseResources.ts`) moved out of the managers. Fingerprint unchanged throughout; the same games as `petra_parity` in every paired check, within the budget. The decision layer still changes the world objects it owns; read-only views for decisions come with stages 4–5, as they are rewritten |
| 4. Fix the known weaknesses (**done** 2026-10-27, `FINDINGS.md` §16) | In order of what each costs, as replays showed it: withdrawal to a reachable point (**done**: past the anchor's footprint); idle workers (**done**: they were mercenaries, booked as workers by class though they cannot gather); attacks that never end (**done**: units garrisoned in our buildings leave the plan; a stuck plan held up every later attack); attacks that cannot fill (**done**, measured with an attack lifecycle log: the plans that never fill belong to a side that already lost, its queues paused for want of workers; what churned was a winner at the population cap, whose plans the cap rule aborted and recreated, 124 times in 200 games; now they wait: 21 of the 22 games it moved ended sooner, 50.3% as before); first field by food income, not fruit left, and the town-phase population: not what loses games (`FINDINGS.md` §16: in 139 of 196 games the loser was beaten in a fight at minutes 10-15, far below the threshold, starving after it). Measured with the four fixes: 50.3% vs `petra_parity` (CI 43-57%): the fixes help the economy (+12% gathered), not the result. Games are decided by a border skirmish at minutes 1-11 that both bots fight with the same opening, so the start decides; an earlier army (`alpha` 0.6) gave 52.2% (CI 49.1-55.3%, 975 games) and was reverted; calling back workers that chase into enemy land, 47.7% (reverted: the chases hurt the enemy's economy); six small original bugs fixed (`FINDINGS.md` §1, stage-4 rows), 50.5%. The first fight is stage 5's first domain. Type hygiene (3.5): items 1-4 and 6-8 done, without a change to any game | Each: an integration check or property test that fails before and passes after; then win-rate vs `petra_parity` > 50% at 95% (SPRT). Met for the first: every fix has a test the original fails. The second is not met (50.3%, CI 43-57%, 200 games) and moves to stage 5: every measurement places what decides a game in the economy of minutes 2-8 and the first fight, which are stage 5's domains, not in the weaknesses fixed here |
| 5. Utility decisions | Replace threshold rules with utility scores, one domain at a time (economy mix, build order, attack timing), tuned on match data. Where to start, from stage 4's logs (`FINDINGS.md` §16): the two games of a seed pair are the same until minute 6, and the side that wins is a few units ahead at minutes 7-8 (wood: its food comes faster, so fewer gatherers go to food), a lead the first fight at minute 9 amplifies; so first the gatherer split of minutes 2-8 by how fast each resource comes in, then when to take a fight. Measured (`FINDINGS.md` §18): the split's rate estimate is always 0 since an engine change to `unitAIOrderData()` (orders, not their data), so the split follows the queues' wishes alone; food is the slow resource (about 22 per gatherer-minute at minutes 4-10 against wood's 51), and a long food trip is what the lost game of a pair has. First change, **done** 2026-10-27: the orders' data read again (`adapter/orders.ts`): 62.9% vs `petra_parity` on 150 fresh seed pairs (CI 57.3-68.2%, SPRT accepts 55%), 58.1% on stage 4's pairs. The split by measured income per gatherer (`world/gatherEconomy.ts`, `decision/gatherSplit.ts`; `FINDINGS.md` §19): four variants, 42-52% against `petra_prev` (the best: 52.0% over 494 games, 48.6% on fresh pairs, 2-3% more food, and women idle on full fields): dropped, Petra's order kept; the measured rates stay as the next domain's measurement. The domains in order, each measured against `petra_prev` on fresh seed pairs: (1) the split (tried, dropped); (2) where food comes from (**done**, `FINDINGS.md` §20: a field as soon as a gatherer brings in less at the berries than at a field, measured; 56.3% against `petra_prev` on 150 fresh pairs, CI 50.7-61.8%, 13% more gathered); (3) the houses (**done**, `FINDINGS.md` §22: a needed house before the training queues; 56.0% against `petra_prev` on 150 fresh pairs, CI 50.4-61.6%, 8% more gathered; the first fights, tried three ways, are decided by the soldiers a side has when the raid comes: §21); (4) dropsite placement by the trips it saves; (5) the worker/soldier mix and the population targets; (6) when to fight (stage 6's fight estimator). Tools: `economy-log.ts`, and `pair-score.ts`, the early proxy (§5.3). Measure on the paired games (`attack-log.ts`, the replays' 30 s statistics), and position logging for the start's layout; with each rewritten class, its remaining `declare` fields (3.5: the 18 set on some paths, the 12 in subclasses, the 57 set outside the constructor) and long functions | Each domain: no win-rate loss vs the previous stage; together: a significant gain vs `petra_fixed`, and win-rate vs `petra_parity` > 50% at 95% (SPRT; carried over from stage 4). **Met** 2026-10-28 (§6.1): 78.7% against both on 150 fresh pairs (CI 73.7-83.0%); later comparisons use `petra_parity` alone (§2) |
| 6. Narrow search | Build-order planner and fight estimator (3.4), time-boxed | Gain vs stage 5 (SPRT); turn budget kept |

Running throughout: determinism and save/load checks (5.2), `FINDINGS.md`
for what each stage finds, and upstream reports for bugs that are the
original's or the game's (`build/petra_ts/upstream/`).

### 6.1 Stage 5: where it stands, and what is left

**Where it stands** (2026-10-28). Three changes kept, each measured against
the version before it on fresh seed pairs: the units' orders read as the
engine hands them over (62.9% against `petra_parity`, `FINDINGS.md` §18), a
field as soon as the berries bring in less (56.3%, §20), a needed house before
the training queues (56.0%, §22). Tried and dropped: the gatherer split (§19),
a rush that drafts only its own size, sheltering an attacked woman, the town
bell, defenders by distance (§21). Only the field rule is a utility decision;
the rest of the bot is Petra's threshold rules (fixed numbers each rule
compares on its own: 600 berries, priorities 250-600, rushes of 16-24 that
draft all but 8). The kept changes all removed a block on early growth; the
fights are decided by the soldiers a side has when the raid comes (§21), the
economy's output.

**The conversion to utility scores**, from the next domain on: one economy
module that scores the economy's options on one scale (resources gained per
second for resources spent: the next women or soldiers, a house, a field, a
dropsite, research), reading a model in `world/` (`gatherEconomy`'s measured
rates; population against the housing limit; production buildings and their
idle time; stock against costs), and sets the queues' priorities from the
scores instead of the config's constants. The house and field fixes become
two cases of it. Measured against `petra_prev` like any change; then, inside
it and one at a time, the thresholds of housing, fields, training (batch
sizes, `targetNumWorkers`, `supportRatio`), dropsites and research. The
military side (when and how big to attack, how to defend) waits for stage
6's fight estimator.

**What the measurements point at, not yet acted on:**

| What | Evidence | Lever |
|---|---|---|
| housing still blocks | 32% of games at the limit at minute 3 after the fix (56% before) | the first houses earlier, not only funded first |
| hunting | hunters gather 20-23% of the time, trips of 160-180, for 1.2-1.5 food a second | a dropsite by the hunt, or no far hunting |
| berries' walk | ~30% of food gatherers at minutes 4-10 have no supply, mostly carrying back from bushes picked clean | a farmstead by the bushes, fields sooner |
| wood's walk | woodcutters gather 64% of the time, trips of 26 | storehouses by the trips they save (+5-10% wood) |
| stone and metal | gathering 70-75%, trips of about 45 | the same, smaller |
| rush timing | first attacks at minutes 8-10 win 45%, at 12-16 74% (a correlation) | the timing, tested (its size was: 40.6%) |
| soldiers away when raided | a losing side's defense army: a median 2 defenders against 8 foes | where they are (dead or away), then keeping some home |
| HugeAttack churn | 224 plans made and dropped within 30 s, no target to start on | probably harmless; reserves and releases resources |

**Never measured:** idle production (do the civic centre and barracks train
all the time?), phasing up (when, at what cost), research (which techs, when:
gather-rate techs compound as fields do), army composition, and other engine
interfaces the port reads: `unitAIOrderData()` changed shape after the port
and nothing noticed (§18), the change worth the most of all.

**The order:**
1. An audit of the engine interface: the common API's and the engine's
   changes since the port against what the port reads. Cheap; the last such
   fault was worth more than everything since. Done (`FINDINGS.md` §23):
   nothing of the kind left; the probe (`apiprobe.txt`) reruns it.
2. A checkpoint against `petra_parity` and `petra_fixed` (150 fresh pairs
   each): the stage's exit criteria are the sum, not single changes. Done
   2026-10-28 (pool seed 31, 300 games each, the same 150 pairs): 78.7%
   against `petra_parity` (233/296, CI 73.7-83.0%, SPRT accepts 55%, LLR
   15.6) and 78.7% against `petra_fixed`, the same games (the two baselines
   play alike, stage 1); 89 pairs won from both slots, 5 lost from both;
   76% more gathered (105k against 60k), peak map control 69% against 32%.
   Both exit criteria are met; the three changes compound to more than
   their single measurements (62.9%, 56.3%, 56.0% are about +180 Elo, the
   checkpoint about +230). From here on, `petra_fixed` is dropped from the
   comparisons: it gave the same 300 results as `petra_parity`.
3. Idle production and the worker/soldier targets, as the first part of the
   economy scoring module.
4. Dropsites, hunting and the housing that still blocks, in the same module:
   all come down to how far gatherers walk, scored by the trips they save.
5. Research timing (the gather-rate techs).
6. Rush timing, tested directly; then the fights, with stage 6's estimator.

Each step as before: measured first, tuned on one seed pool, decided on 150
fresh pairs against `petra_prev`; the early proxy tells a change's direction,
not its worth; `random/mainland_mirror` checks that a gain does not depend on
unequal starts.

## 7. Open questions

- Answered in stage 3: the AI context offers no clock; the engine times the
  AI's calls instead (`match.sh -P`, 4).
- Answered in stage 0: `XDG_*` per run is enough to isolate parallel engines
  (config, cache, replays and logs all follow it); `-writableRoot` is not
  needed (5.3, `FINDINGS.md` §13).
- Why player 2 wins more mirror games (5.3).
- Which civilisations and maps make the pool, given the time per game.
- Answered in stage 3: the original is no test target once the port is in
  layers; the frozen port's parity is shown in games (stage 1).
