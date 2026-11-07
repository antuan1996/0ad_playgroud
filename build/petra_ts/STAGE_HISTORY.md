# Petra TS: completed stage history (Stages 0–5)

This file archives the detailed step-by-step measurements and progression of
Stages 0–5 from `PLAN.md`. For current constraints, architecture, validation,
and active Stage 6 goals, see `PLAN.md`. For detailed test and match findings by
section number, see `binaries/data/mods/public/simulation/ai/petra_ts/tests/FINDINGS.md`.

## Stage 0–5 detailed roadmap log (`PLAN.md` §6)

- **Stage 0 — Baselines (done 2026-10-25, `FINDINGS.md` §13):**
  Tagged `petra-ts-parity`; built `petra_parity` and `petra_fixed` as bots; added
  parallel headless runs (`batch.ts`) and results tables.
  *Exit criterion met:* 315 mirror games at 12 jobs in parallel without path
  clash; 15/15 repeats shared identical fingerprints; `petra_parity` vs
  `petra_fixed` 51.0% (CI 41.5–60.4%).
- **Stage 1 — Parity proof (done 2026-10-25, `FINDINGS.md` §14):**
  Command-log diffs on fixed seed sets (`PLAN.md` §5.1), starting with the 6
  seed pairs where the baselines differed (`FINDINGS.md` §13).
  *Exit criterion met:* identical command logs across 26 of 26 pairs (52 games)
  once 3 additional original bugs were added to `upstream/petra-fixes.patch`
  (15 fixes total).
- **Stage 2 — Types in place (done 2026-10-25):**
  Branded types (`PLAN.md` §3.3) across the port (`EntityId`, `PlayerId`,
  `WorldPos`, `MapPos`, `AccessIndex`/`SeaIndex`/`RegionIndex`,
  `GameMs`/`GameSeconds`, `TemplateName`, `CellIndex<"territory" | "passability">`)
  and `AttackPlanState` transition map (`PLAN.md` §3.1).
  *Exit criterion met:* typecheck clean, 1,533 tests passing, integration match
  fingerprint `2164cc14d7c5e28f` unchanged.
- **Stage 3 — Layers (done 2026-10-26, `FINDINGS.md` §15):**
  Reshaped `petra_ts/` into `adapter/`, `world/`, `decision/`, `execution/`;
  added `unitState.ts`, `commands.ts`, `SAVE_VERSION`, `execution/hq.ts`
  (`hqOf`), `world/geography.ts`, and `world/baseResources.ts`.
  *Exit criterion met:* fingerprint unchanged throughout; identical games to
  `petra_parity` in paired turn-timing checks within the 5% mean/99th and 10%
  99.9th turn budget (`PLAN.md` §4).
- **Stage 4 — Fix the known weaknesses (done 2026-10-27, `FINDINGS.md` §16):**
  Fixed withdrawal past the civic centre's footprint, mercenaries booked as
  workers, attacks stuck on garrisoned units, and attack-plan churn at the
  population cap (124 plans aborted within 30s in 200 games; 21 of 22 moved
  games ended sooner). Investigated first-field threshold and town-phase
  population (found not to decide games: in 139 of 196 games the loser was
  beaten in a fight at minutes 10–15). With the four fixes plus six small
  original bugs fixed (`FINDINGS.md` §1), win-rate vs `petra_parity` was 50.3–50.5%
  (+12% resources gathered). Tried and reverted: earlier army (`alpha` 0.6,
  52.2% over 975 games) and recalling workers chasing into enemy territory
  (47.7%). Completed type hygiene (`PLAN.md` §3.5) items 1–4 and 6–8 with 0
  smoke-game changes.
- **Stage 5 — Utility decisions (done 2026-11-04, `FINDINGS.md` §§18–46, tag `petra-ts-stage5`):**
  Replaced economy bottlenecks and fixed island play one measured change at a
  time against `petra_prev` on fresh seed pairs, reaching **95.0% win-rate
  against `petra_parity`** (285/300, CI 91.9–96.9%, pool seed 43). Also
  completed data-carrying plan stages (`AttackStage`, `TransportStage`,
  `PlanStart`), split all 19 functions over 150 lines, and eliminated two-step
  `init`/`Deserialize` setup.

## `declare` fields elimination history (`PLAN.md` §3.5 item 8)

- **Stage 4:** 115 of 133 `declare` fields assigned in their own constructor had
  `declare` removed; 18 remained where attack/transport plan constructors
  returned early on failure.
- **Stage 5 (first pass, `FINDINGS.md` §32):** `AttackPlan.create` and
  `TransportPlan.create` factories replaced `failed` flags; queue-plan category
  passed to base constructor; HQ flags given initial values (41 fewer `declare`
  fields, 62 remaining in `init(gameState)`).
- **Stage 5 (second pass, 2026-11-04):** 9 plain values given initializers on
  transport/attack plans and `BaseManager`. Then two-step `init`/`Deserialize`
  setup was removed altogether: objects are constructed whole or restored via
  `restore` / `start` factories from explicit inputs (`Geography`, fleet,
  `canBuildUnits`), and `Worker`'s per-unit fields became `UnitWork`. Only 1
  `declare` field remains in the port: `PetraBot.player` (set by `BaseAI`).

## Stage 5 step-by-step notes (from 2026-10-28, `PLAN.md` §6.1)

### Initial measurements and candidate levers (2026-10-28)

1. **Order reading (`FINDINGS.md` §18):** `Entity.unitAIOrderData()` had changed
   shape in engine commit `4b516b336e`, breaking every order target check and
   making `currentGatherRate()` return 0. Fixing it in `adapter/orders.ts`
   (`ordersOf`, `gatherRate`) gave **62.9% vs `petra_parity`** (CI 57.3–68.2%,
   150 fresh pairs).
2. **Gatherer split (`FINDINGS.md` §19):** Tested 4 variants of gatherer split
   by measured rates (`world/gatherEconomy.ts`, `decision/gatherSplit.ts`);
   scored 42–52% vs `petra_prev` (best: 52.0% over 494 games, 48.6% on fresh
   pairs) and was dropped; `gatherEconomy.ts` kept for rate measurements.
3. **First field (`FINDINGS.md` §20):** Plant a field as soon as berry gatherers
   bring in less than a field (`decision/foodSource.ts`): **56.3% vs
   `petra_prev`** (CI 50.7–61.8%, +13% gathered).
4. **Early defense / rush size trials (`FINDINGS.md` §21):** Rush drafting only
   its own size, sheltering attacked women, town bell, and defenders by distance
   were tested and dropped.
5. **Housing priority (`FINDINGS.md` §22):** Put a needed house before training
   queues: **56.0% vs `petra_prev`** (CI 50.4–61.6%, +8% gathered).
6. **Engine API audit (`FINDINGS.md` §23):** Audited all common-API accessors via
   `apiprobe.txt`; no further broken accessors found.
7. **Checkpoint 1 (2026-10-28, pool seed 31):** **78.7% vs `petra_parity`** and
   **78.7% vs `petra_fixed`** (233/296, CI 73.7–83.0%, identical games;
   `petra_fixed` dropped from subsequent strength runs).
8. **Queue funding & worker share (`FINDINGS.md` §§24–26):**
   - `completeBestPlan` (pay highest-priority plan that stock + lower accounts
     cover): **61.0% vs `petra_prev`** (CI 55.4–66.3%).
   - Women's queue priority 650 (above soldiers' 600): **74.2% vs `petra_prev`**
     (CI 68.9–78.8%).
   - `supportRatio` 0.5 (up from 0.3): **61.3% vs `petra_prev`** (CI 55.7–66.7%).
   - **Checkpoint 2 (pool seed 35):** **92.3% vs `petra_parity`** (CI 88.8–94.8%).
   - Tried and dropped (`FINDINGS.md` §27): earlier rush (30.0%), no rush
     (47.0%), town phase at 100 pop (30.3%).
9. **Research payback & barracks scaling (`FINDINGS.md` §§28–31):**
   - `decision/economyScore.ts` (queue economy tech above women when payback
     <= 240s): **54.4% vs `petra_prev`** on 300 fresh pairs (CI 50.4–58.4%).
   - `world/production.ts` (add a barracks/range when existing ones train >= 85%
     of the time and unbooked stock covers two, up to 5): **66.4% vs
     `petra_prev`** (CI 60.9–71.6%).
   - Tried and dropped (`FINDINGS.md` §30): earlier civic centre (43.4%), eight
     barracks (49.0%), woodcutter-walk dropsite rule (§31, 45.0%), workers past
     150 by payback (§46, 50.2%).
   - Extracted pure economy modules `decision/housing.ts`, `fields.ts`,
     `dropsites.ts`, `workforce.ts` over `world/census.ts` (§31).
10. **Islands & naval play (`FINDINGS.md` §§33–45):**
    Local attacks while sailing, attacking defended buildings without siege,
    sea routes around enemy shooters (`world/seaRoute.ts`), early market and
    town phase on dry islands, ship queue priority while transports wait, towers
    over enemy sea traffic (`world/shipTraffic.ts`), civic-centre spot selection,
    hunting fleet, dock targeting, and ship turn/block handling.
11. **Checkpoint 3 (pool seed 43, 300 games):** **95.0% vs `petra_parity`**
    (285/300, CI 91.9–96.9%; 135 of 150 pairs won from both slots, 0 lost from
    both).
