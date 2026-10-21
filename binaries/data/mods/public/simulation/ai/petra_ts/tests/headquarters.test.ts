/**
 * Headquarters: the office that coordinates the whole AI. The suites build a
 * real Headquarters — its own constructor, its own init — on a small
 * engine-truthful map (see tests/harness/hqWorld.ts), then walk the office
 * through the weeks of a campaign: the events a turn raises, the workers it
 * trains, the townships it decides to build and where it puts them, the
 * emergencies it detects, and the bookkeeping other offices ask of it.
 *
 * Its sub-managers are filed per suite: the ones in the suite's walls stay
 * real, the ones out of it are recorded doors, so no suite re-runs a manager
 * whose own campaign already verifies it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import { logs, resetRecorder } from "./harness/engine.ts";
import {
	makeGaiaSupply, makeHqEntity, makeHQConfig, makeHqWorld, seatHQ, structureTemplate, centerOfCell, PLAYER, ENEMY, GAIA,
	type HqSeatOptions, type HqWorldOptions
} from "./harness/hqWorld.ts";
import { emptyEvents, makeTemplate, restoreEngine, stubGlobal, type World } from "./harness/attackWorld.ts";
import type { FakeEnt } from "./harness/attackWorld.ts";
import type { HqInstance, HqWorld } from "./harness/hqWorld.ts";

// the co-managers every suite in this file keeps outside its walls: naval,
// trade, research, diplomacy, victory and defense all run their own campaigns
const doorManagers = [
	"navalManager", "tradeManager", "researchManager", "diplomacyManager",
	"victoryManager", "defenseManager"
];

/** the turn's events as the engine raises them, renamed for the office */
function eventsWith(extra: Record<string, unknown[]>): EngineAIEvents
{
	const events = emptyEvents() as unknown as Record<string, unknown[]>;
	for (const [name, list] of Object.entries(extra))
		events[name] = list;
	// the glue-code bucket the military campaigns never hear
	events.TerritoryDecayChanged ??= [];
	return events as unknown as EngineAIEvents;
}

/** an office seated on the plain, with its doors recorded (unless a suite seats its own) */
function seat(worldOptions: Partial<HqWorldOptions> = {}, seatOptions: Partial<HqSeatOptions> = {})
{
	const world = makeHqWorld(worldOptions as HqWorldOptions);
	const hq = seatHQ(world, { stubs: doorManagers, ...seatOptions });
	return { world, hq };
}

/** the outro board, so frontiers and borders read by bit */
async function mapBits()
{
	return await loadPetraModule<{
		outside: number; border: number; narrowFrontier: number; largeFrontier: number;
	}>("mapMask");
}

describe("headquarters boot: the office opening its doors", () => {
	it("constructs, inits and reads the map it was handed", async () => {
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// the office took the world's grids
		assert.equal(hq.territoryMap.width, world.map.territory.width);
		assert.equal(hq.territoryMap.cellSize, 8);
		// every interior cell is ours
		assert.equal(hq.territoryMap.getOwner(centerOfCell(20, 20)), PLAYER);
		// the border ring (the outer 10 territory cells) is marked, as the
		// engine's createBorderMap marks a square world's ring: each ring
		// tile keeps unrestricted-passable mini-cells, so it carries the
		// `border` bit rather than `outside` (that one survives only on
		// tile whose whole mini-cell block is unrestricted-impassable)
		const { outside, border } = await loadPetraModule<{ outside: number; border: number; }>("mapMask");
		assert.ok(hq.borderMap.map[0] & border);
		assert.ok(!(hq.borderMap.map[0] & outside));
		assert.ok(!(hq.borderMap.map[20 + 20 * 40] & (outside | border)));

		// no treasures on the plain; the office keeps an updated list anyway
		assert.equal((hq.treasures as { length: number }).length, 0);
		// the regions regionAnalysis would have filled
		assert.deepEqual(hq.landRegions, { 2: true });
		assert.deepEqual(hq.navalRegions, {});
	});

	it("reports the phase the world is in", async () => {
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });
		assert.equal(hq.currentPhase, 1);
	});
});

describe("headquarters and the queues: what the workers should gather", () => {
	it("reads the wanted rates the queue manager books", async () => {
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// on turn 0 the wanted rates are the config's first-turn table
		const rates = hq.GetWantedGatherRates(world.gameState);
		assert.deepEqual(rates, { "food": 10, "wood": 10, "stone": 0, "metal": 0 });
		assert.equal(hq.GetWantedGatherRates(world.gameState), rates); // cached
	});
});

describe("headquarters and the next worker: the resource that starves first", () => {
	it("orders the resources by how far the gatherers fall short", async () => {
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// the gather-rate roll is the bases manager's ledger; the suite hands
		// HQ current rates and records that it asked for them (the roll itself
		// is the basesManager campaign's business)
		let asked = 0;
		(hq.basesManager as Record<string, unknown>).GetCurrentGatherRates = () =>
		{
			++asked;
			return { "food": 1, "wood": 0, "stone": 0, "metal": 0 };
		};

		const needed = hq.pickMostNeededResources(world.gameState) as Array<{ type: string; wanted: number; current: number }>;
		assert.equal(asked, 1);
		// the two shortfalls order first: wood (no gatherer at all) before food
		assert.deepEqual(needed.map((item: { type: string }) => item.type).slice(0, 2), ["wood", "food"]);
		// the wanted table the office compared against
		assert.equal(needed[0].wanted, 10);
		assert.equal(needed[2].wanted, 0); // stone fills its nothing
	});
});

describe("checkEvents: diplomacy waves", () => {
	it("a change we are party to resets the diplomacy-bound collections", () => {
		const { world, hq } = seat();
		hq.checkEvents(world.gameState, eventsWith({ "DiplomacyChanged": [{ "player": 1, "otherPlayer": 2 }] }));
		assert.deepEqual(world.diplomacyResets, [world.ai.playedTurn]);
	});

	it("a change far away deals with other tables", () => {
		const { world, hq } = seat();
		hq.checkEvents(world.gameState, eventsWith({ "DiplomacyChanged": [{ "player": GAIA, "otherPlayer": ENEMY }] }));
		assert.deepEqual(world.diplomacyResets, []);
	});
});

describe("checkEvents: a finished market frees the fields", () => {
	it("a market finishing sets maxFields off", () => {
		const { world, hq } = seat();
		hq.maxFields = 5;	// fields are still being limited (configFirstBase's small map case)
		const market = world.addEntity(makeHqEntity({
			id: 31, owner: PLAYER, position: centerOfCell(20, 21),
			classes: ["Structure", "Market"], templateName: "structures/athen/market"
		}));
		hq.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": 999, "newentity": 31 }]
		}));
		assert.equal(hq.maxFields, false);
	});

	it("a repaired building is not the finished market", () => {
		const { world, hq } = seat();
		hq.maxFields = 5;
		world.addEntity(makeHqEntity({
			id: 31, owner: PLAYER, position: centerOfCell(20, 21),
			classes: ["Structure", "Market"], templateName: "structures/athen/market"
		}));
		hq.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": 31, "newentity": 31 }]
		}));
		assert.equal(hq.maxFields, 5);
	});

	it("an enemy market finishing is none of our business", () => {
		const { world, hq } = seat();
		hq.maxFields = 5;
		world.addEntity(makeHqEntity({
			id: 31, owner: ENEMY, position: centerOfCell(30, 30),
			classes: ["Structure", "Market"], templateName: "structures/athen/market"
		}));
		hq.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": 999, "newentity": 31 }]
		}));
		assert.equal(hq.maxFields, 5);
	});
});

describe("checkEvents: what a captured unit carries into town", () => {
	it("a captured worker becomes an idle worker again", () => {
		const { world, hq } = seat();
		const worker = world.addEntity(makeHqEntity({
			id: 51, owner: PLAYER, position: centerOfCell(21, 21),
			classes: ["Unit", "Support", "Worker"], templateName: "units/athen/support_female_citizen"
		}, {}, { "role": "trader", "subrole": "trading", "plan": 7, "PartOfArmy": true }));
		hq.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 51, "from": ENEMY, "to": PLAYER }]
		}));
		// the capture calming: books wiped, the office's own role granted
		assert.equal(worker.getMetadata(PLAYER, "role"), "worker");
		assert.equal(worker.getMetadata(PLAYER, "subrole"), "idle");
		assert.equal(worker.getMetadata(PLAYER, "plan"), undefined);
		assert.equal(worker.getMetadata(PLAYER, "PartOfArmy"), undefined);
	});

	it("a captured attacker keeps no old plans and loses the worker books", () => {
		const { world, hq } = seat();
		const soldier = world.addEntity(makeHqEntity({
			id: 52, owner: PLAYER, position: centerOfCell(22, 21),
			classes: ["Unit", "CitizenSoldier", "Infantry"], templateName: "units/athen/infantry_spearman_b"
		}, { "attackTypes": () => ["Melee"] }, { "plan": 3 }));
		hq.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 52, "from": ENEMY, "to": PLAYER }]
		}));
		// plan -1: no plan is waiting for it
		assert.equal(soldier.getMetadata(PLAYER, "plan"), -1);
		assert.equal(soldier.getMetadata(PLAYER, "role"), undefined);
		// the worker book stays closed for a soldier
		assert.equal(soldier.getMetadata(PLAYER, "subrole"), undefined);
	});

	it("a captured ship reads the sea, a captured trader trades again", () => {
		const { world, hq } = seat();
		const ship = world.addEntity(makeHqEntity({
			id: 53, owner: PLAYER, position: centerOfCell(12, 30),
			classes: ["Unit", "Ship", "Trader"], templateName: "units/athen/ship_merchant"
		}, { "attackTypes": () => ["Melee"] }, { "plan": 4, "route": [1, 2] }));
		hq.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 53, "from": ENEMY, "to": PLAYER }]
		}));
		// ship and trader features both apply: sea access read, route wiped, trader role kept
		assert.equal(ship.getMetadata(PLAYER, "sea"), 2);
		assert.equal(ship.getMetadata(PLAYER, "route"), undefined);
		assert.equal(ship.getMetadata(PLAYER, "role"), "trader");
		assert.equal(ship.getMetadata(PLAYER, "plan"), undefined);
		assert.equal(ship.getMetadata(PLAYER, "subrole"), undefined);
	});
});

describe("checkEvents: the wall that decays (captured or fading)", () => {
	it("a captured decaying tower goes to the garrison office's decay watch", () => {
		const { world, hq } = seat();
		const tower = world.addEntity(makeHqEntity({
			id: 61, owner: PLAYER, position: centerOfCell(25, 25),
			classes: ["Structure", "Tower"], templateName: "structures/athen/watchtower"
		}, {
			"decaying": () => true, "isGarrisonHolder": () => true, "hasDefensiveFire": () => true,
			"territoryDecayRate": () => 6, "garrisonRegenRate": () => 2, "defaultRegenRate": () => 1
		}));
		hq.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 61, "from": GAIA, "to": PLAYER }]
		}));
		// the garrison manager keeps its bet: ceil((6-1)/2) = 3 men minimum
		assert.deepEqual([...hq.garrisonManager.decayingStructures.keys()], [61]);
		assert.deepEqual([...hq.garrisonManager.decayingStructures.values()], [3]);
		assert.ok(!hq.decayingStructures.has(61));
	});

	it("a decaying wall without garrison rights lands on the plain list", () => {
		const { world, hq } = seat();
		const wall = world.addEntity(makeHqEntity({
			id: 62, owner: PLAYER, position: centerOfCell(25, 26),
			classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
		}, { "decaying": () => true }));
		hq.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "entity": 62, "from": GAIA, "to": PLAYER }]
		}));
		// a bare wall cannot be defended by garrison; the plain book keeps it
		assert.ok(hq.decayingStructures.has(62));
		assert.deepEqual([...hq.garrisonManager.decayingStructures.keys()], []);
	});
});

describe("checkEvents: rally points when training starts", () => {
	function trainer(id: number, queue: unknown)
	{
		// engine entities answer both the entity API (trainingQueue()) and the
		// raw sim view (_entity.trainingQueue); the port walks the first, the
		// original the second
		return makeHqEntity({
			id, owner: PLAYER, position: centerOfCell(20, 20),
			classes: ["Structure", "Trainer"], templateName: "structures/athen/barracks"
		}, {
			"trainingQueue": () => queue,
			"_entity": { "trainingQueue": queue === false ? undefined : queue } as unknown as (
				...args: any[]) => unknown,
			"setRallyPoint": (...args: unknown[]) => { calls.push(["setRallyPoint", args]); },
			"unsetRallyPoint": (...args: unknown[]) => { calls.push(["unsetRallyPoint", args]); }
		});
	}
	let calls: Array<[string, unknown[]]> = [];

	it("a queued autogarrison trains its units straight into the wall", () => {
		const { world, hq } = seat();
		calls = [];
		const barracks = world.addEntity(trainer(71, [{ "metadata": { "garrisonType": "Tower" } }]));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingStarted": [{ "entity": 71 }] }));
		assert.deepEqual(calls, [["setRallyPoint", [barracks, "garrison"]]]);
	});

	it("nothing to garrison: the usual rally to the training ground", () => {
		const { world, hq } = seat();
		calls = [];
		world.addEntity(trainer(72, [{ "metadata": {} }]));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingStarted": [{ "entity": 72 }] }));
		assert.deepEqual(calls, [["unsetRallyPoint", []]]);
	});

	it("no queue, no rally point, and the enemy's barracks is no business", () => {
		const { world, hq } = seat();
		calls = [];
		world.addEntity(trainer(73, false));
		const enemyBarracks = world.addEntity(makeHqEntity({
			id: 74, owner: ENEMY, position: centerOfCell(30, 30),
			classes: ["Structure", "Trainer"], templateName: "structures/athen/barracks"
		}, {
			"trainingQueue": () => [{ "metadata": { "garrisonType": "Tower" } }],
			"setRallyPoint": (...args: unknown[]) => { calls.push(["setRallyPoint", args]); },
			"unsetRallyPoint": (...args: unknown[]) => { calls.push(["unsetRallyPoint", args]); }
		}));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingStarted": [{ "entity": 73 }, { "entity": 74 }] }));
		assert.deepEqual(calls, []);
	});
});

describe("checkEvents: training finished — landing and stale plans", () => {
	it("a unit garrisoned by its training ends up registered in the holder's book", () => {
		const { world, hq } = seat();
		world.addEntity(makeHqEntity({
			id: 81, owner: PLAYER, position: centerOfCell(20, 20),
			classes: ["Structure", "Tower"], templateName: "structures/athen/watchtower"
		}));
		const unit = world.addEntity(makeHqEntity({
			id: 82, owner: PLAYER, classes: ["Unit"], templateName: "units/athen/infantry_archer_b"
		}, { "garrisonHolderID": () => 81 }));	// no position: garrisoned inside the holder
		hq.checkEvents(world.gameState, eventsWith({ "TrainingFinished": [{ "entities": [82] }] }));
		// registration only: nobody has marched into the holder through this call
		assert.ok(hq.garrisonManager.holders.has(81));
		assert.deepEqual(hq.garrisonManager.holders.get(81)?.list, []);
	});

	it("autogarrison that fails on a full wall forgets its intent", () => {
		const { world, hq } = seat();
		const unit = world.addEntity(makeHqEntity({
			id: 83, owner: PLAYER, position: centerOfCell(21, 20),
			classes: ["Unit"], templateName: "units/athen/infantry_archer_b"
		}, {}, { "garrisonType": "Tower" }));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingFinished": [{ "entities": [83] }] }));
		assert.equal(unit.getMetadata(PLAYER, "garrisonType"), undefined);
	});

	it("a finished unit of an aborted attack plans no more", async () => {
		const { world, hq } = seat();
		const unit = world.addEntity(makeHqEntity({
			id: 84, owner: PLAYER, position: centerOfCell(21, 20),
			classes: ["Unit"], templateName: "units/athen/infantry_spearman_b"
		}, {}, { "plan": 12 }));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingFinished": [{ "entities": [84] }] }));
		assert.equal(unit.getMetadata(PLAYER, "plan"), -1);
	});

	it("a plan still waiting keeps its recruit", async () => {
		const { AttackPlan } = await loadPetraModule<{ AttackPlan: { STATE_UNEXECUTED: string; }; }>("attackPlan");
		const { world, hq } = seat();
		// a raid plan that never started: the recruit recorded under its name
		(hq.attackManager as Record<string, unknown>).upcomingAttacks = {
			"Raid": [{ "getName": () => 12, "state": AttackPlan.STATE_UNEXECUTED }]
		};
		const unit = world.addEntity(makeHqEntity({
			id: 85, owner: PLAYER, position: centerOfCell(21, 20),
			classes: ["Unit"], templateName: "units/athen/infantry_spearman_b"
		}, {}, { "plan": 12 }));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingFinished": [{ "entities": [85] }] }));
		assert.equal(unit.getMetadata(PLAYER, "plan"), 12);
	});

	it("a foreign unit finishing training is none of ours", () => {
		const { world, hq } = seat();
		const allyUnit = world.addEntity(makeHqEntity({
			id: 86, owner: ENEMY, position: centerOfCell(30, 30),
			classes: ["Unit"], templateName: "units/athen/unit"
		}, {}, { "plan": 12 }));
		hq.checkEvents(world.gameState, eventsWith({ "TrainingFinished": [{ "entities": [86] }] }));
		assert.equal(allyUnit.getMetadata(ENEMY, "plan"), 12);
	});
});

describe("checkEvents: territory decay events", () => {
	it("a wall in dead territory goes to the plain book, a tower to garrison", () => {
		const { world, hq } = seat();
		const wall = world.addEntity(makeHqEntity({
			id: 91, owner: PLAYER, position: centerOfCell(12, 12),
			classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
		}, { "decaying": () => true }));
		const tower = world.addEntity(makeHqEntity({
			id: 92, owner: PLAYER, position: centerOfCell(12, 13),
			classes: ["Structure", "Tower"], templateName: "structures/athen/watchtower"
		}, {
			"isGarrisonHolder": () => true, "hasDefensiveFire": () => true,
			"territoryDecayRate": () => 6, "garrisonRegenRate": () => 2, "defaultRegenRate": () => 1
		}));
		hq.checkEvents(world.gameState, eventsWith({
			"TerritoryDecayChanged": [
				{ "entity": 91, "to": true },
				{ "entity": 92, "to": true }
			]
		}));
		assert.ok(hq.decayingStructures.has(91));
		assert.ok(hq.garrisonManager.decayingStructures.has(92));
		assert.ok(!hq.decayingStructures.has(92));
	});

	it("the tower recovered: the garrison bet is withdrawn", () => {
		const { world, hq } = seat();
		const tower = world.addEntity(makeHqEntity({
			id: 92, owner: PLAYER, position: centerOfCell(12, 13),
			classes: ["Structure", "Tower"], templateName: "structures/athen/watchtower"
		}, {
			"isGarrisonHolder": () => true, "hasDefensiveFire": () => true,
			"territoryDecayRate": () => 6, "garrisonRegenRate": () => 2, "defaultRegenRate": () => 1
		}));
		hq.garrisonManager.decayingStructures.set(92, 3);
		hq.checkEvents(world.gameState, eventsWith({
			"TerritoryDecayChanged": [{ "entity": 92, "to": false }]
		}));
		assert.ok(!hq.garrisonManager.decayingStructures.has(92));
	});

	it("a foundation and a foreign wall are not decayed property yet", () => {
		const { world, hq } = seat();
		const foundation = world.addEntity(makeHqEntity({
			id: 93, owner: PLAYER, position: centerOfCell(12, 12),
			classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
		}, { "foundationProgress": () => 0.5, "decaying": () => true }));
		const foreign = world.addEntity(makeHqEntity({
			id: 94, owner: ENEMY, position: centerOfCell(12, 14),
			classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
		}, { "decaying": () => true }));
		hq.checkEvents(world.gameState, eventsWith({
			"TerritoryDecayChanged": [
				{ "entity": 93, "to": true },
				{ "entity": 94, "to": true }
			]
		}));
		assert.ok(!hq.decayingStructures.has(93));
		assert.ok(!hq.decayingStructures.has(94));
	});
});

describe("checkEvents: the wall that gives in is torn down", () =>
{
	it("a wall past the threshold, unattacked, keeps standing", () =>
	{
		const destroyed: number[] = [];
		const { world, hq } = seat();
		stubGlobal("randFloat", () => 0);
		try
		{
			const wall = world.addEntity(makeHqEntity({
				id: 101, owner: PLAYER, position: centerOfCell(12, 12),
				classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
			}, {
				"decaying": () => true, "capturePoints": () => [0, 150, 50],
				"destroy": () => { destroyed.push(101); }
			}));
			hq.decayingStructures.add(101);
			hq.checkEvents(world.gameState, eventsWith({ "Attacked": [] }));
			// we still hold three quarters: above the 0.7 surrender line
			assert.deepEqual(destroyed, []);
			// the book keeps the entry — the office keeps watching a standing wall
			assert.ok(hq.decayingStructures.has(101));
		}
		finally { restoreEngine(); }
	});

	it("one attack at the wall moves the line and the falling wall goes", () =>
	{
		const destroyed: number[] = [];
		const { world, hq } = seat();
		stubGlobal("randFloat", () => 0);
		try
		{
			world.addEntity(makeHqEntity({
				id: 102, owner: PLAYER, position: centerOfCell(12, 12),
				classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
			}, {
				"decaying": () => true, "capturePoints": () => [0, 150, 50],
				"destroy": () => { destroyed.push(102); }
			}));
			hq.decayingStructures.add(102);
			// the same capture ratio (0.75), but with someone shooting at it
			hq.checkEvents(world.gameState, eventsWith({ "Attacked": [{ "target": 102 }] }));
			assert.deepEqual(destroyed, [102]);
		}
		finally { restoreEngine(); }
	});

	it("giving-in walls survive when the wild reclaims them or we still hold most", () =>
	{
		const destroyed: number[] = [];
		const { world, hq } = seat();
		stubGlobal("randFloat", () => 0);
		try
		{
			// no enemy shares a piece: the wall turns back to gaia, harmless
			world.addEntity(makeHqEntity({
				id: 103, owner: PLAYER, position: centerOfCell(12, 12),
				classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
			}, {
				"decaying": () => true, "capturePoints": () => [0, 100],
				"destroy": () => { destroyed.push(103); }
			}));
			// an enemy touching it, but 95% of the stones still ours
			world.addEntity(makeHqEntity({
				id: 104, owner: PLAYER, position: centerOfCell(12, 13),
				classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
			}, {
				"decaying": () => true, "capturePoints": () => [0, 190, 10],
				"destroy": () => { destroyed.push(104); }
			}));
			hq.decayingStructures.add(103);
			hq.decayingStructures.add(104);
			hq.checkEvents(world.gameState, eventsWith({ "Attacked": [] }));
			assert.deepEqual(destroyed, []);
		}
		finally { restoreEngine(); }
	});

	it("in easy games the office shrugs at decaying walls", () =>
	{
		const destroyed: number[] = [];
		const { world, hq } = seat({}, { config: makeHQConfig({ difficulty: 1 }) });
		stubGlobal("randFloat", () => 0);
		try
		{
			world.addEntity(makeHqEntity({
				id: 105, owner: PLAYER, position: centerOfCell(12, 12),
				classes: ["Structure", "Wall"], templateName: "structures/athen/wall"
			}, {
				"decaying": () => true, "capturePoints": () => [0, 100, 100],
				"destroy": () => { destroyed.push(105); }
			}));
			hq.decayingStructures.add(105);
			hq.checkEvents(world.gameState, eventsWith({ "Attacked": [] }));
			assert.deepEqual(destroyed, []);
		}
		finally { restoreEngine(); }
	});
});

describe("updateTerritories: the town's borders move", () =>
{
	it("the first update books our ground under the base", () =>
	{
		const { world, hq } = seat();
		hq.updateTerritories(world.gameState);
		const base = hq.basesManager.baseManagers[0];
		// a square world's border ring carries only the `border` bit: nothing is
		// skipped for it, and all 40x40 cells — ring included — are ours and
		// booked under the nearest base (engine truth: real games book the
		// whole owned ground, ring included)
		assert.equal(base.territoryIndices.length, 40 * 40);
		const middle = 20 + 20 * 40;
		assert.equal(hq.basesManager.basesMap.map[middle], base.ID);
	});

	it("a cell captured by the enemy leaves the base's book and draws the frontier", async () =>
	{
		const { outside, narrowFrontier, largeFrontier } = await mapBits();
		const { world, hq } = seat();
		hq.updateTerritories(world.gameState);
		const base = hq.basesManager.baseManagers[0];
		const j = 12 + 12 * 40;
		world.map.setTerritoryOwner(12, 12, ENEMY);
		hq.updateTerritories(world.gameState);

		assert.equal(hq.basesManager.basesMap.map[j], 0);
		assert.ok(!base.territoryIndices.includes(j));
		assert.ok(base.territoryIndices.includes(20 + 20 * 40));

		// the frontiers follow the line: the cell six ticks away sits on the narrow
		// frontier, the one ten ticks away only on the large one
		assert.ok(hq.borderMap.map[18 + 12 * 40] & narrowFrontier);
		assert.ok(!(hq.borderMap.map[18 + 12 * 40] & largeFrontier));
		assert.ok(hq.borderMap.map[22 + 12 * 40] & largeFrontier);
		assert.ok(!(hq.borderMap.map[22 + 12 * 40] & narrowFrontier));
	});

	it("a settlement on wild land: small gains open no market routes", () =>
	{
		// a young colony: the island is not ours except the few cells we clear
		const { world, hq } = seat({ "territoryOwner": () => 0 });
		// 36 cells (6x6) cleared by hand: 36*64 = 2304? no: still under the cut
		// ... smaller: 12 cells cleared
		for (let iy = 18; iy < 21; ++iy)
			for (let ix = 18; ix < 22; ++ix)
				world.map.setTerritoryOwner(ix, iy, PLAYER);
		hq.updateTerritories(world.gameState);
		// 12 cells * 64 = 768 map units: not enough to rethink trade
		assert.notEqual((hq.tradeManager as Record<string, unknown>).routeProspection, true);
	});

	it("a fort expansion into new territory opens market route prospection", () =>
	{
		const { world, hq } = seat({ "territoryOwner": () => 0 });
		for (let iy = 18; iy < 23; ++iy)
			for (let ix = 18; ix < 26; ++ix)
				world.map.setTerritoryOwner(ix, iy, PLAYER);
		hq.updateTerritories(world.gameState);
		// 40 cells * 64 = 2560 > 960: the camp built itself new ground to trade on
		assert.equal((hq.tradeManager as Record<string, unknown>).routeProspection, true);
	});
});

//
// the first arrival
//

/** configFirstBase loaded for both targets */
async function startingStrategy()
{
	return await loadPetraModule<{ configFirstBase(hq: unknown, gameState: unknown): void; }>("startingStrategy");
}

/** a villager able to raise the listed structures, put on the plain */
function builder(world: HqWorld, id: number, buildables: string[], position: [number, number] = [14, 14])
{
	return world.addEntity(makeHqEntity({
		id, "owner": PLAYER, position,
		"classes": ["Unit", "Support", "Worker", "Villager"],
		"templateName": "units/athen_support_villager",
	}, {
		"buildableEntities": () => buildables,
	}));
}

describe("headquarters and first arrival: what a new civilization counts on day one", () => {
	it("a continental start books no scarcity and prepares one rush", () =>
	{
		const world = makeHqWorld({ "stock": { "food": 1000, "wood": 9000 } });
		// the accessibility campaign measured this island for real games: region
		// 2 a large land (disponible 80k map units of it)
		(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
		const hq = seatHQ(world, { stubs: doorManagers });

		hq.handleNewBase(world.gameState);

		// the day-one policy for a rich continent
		assert.equal(hq.firstBaseConfig, true);
		assert.notEqual(hq.saveResources, true);
		assert.notEqual(hq.saveSpace, true);
		assert.notEqual(hq.maxFields, 1);
		assert.equal(hq.maxFields, false);
		// enough wood over the 6000 cut: no corral, no farm, no fish
		assert.ok(!hq.needCorral);
		assert.ok(!hq.needFarm);
		assert.ok(!hq.needFish);
		// (9000 - 8500)/3000 = a single rush wave for this personality
		assert.equal(hq.attackManager.maxRushes, 1);
	});

	it("a tiny island books space, fishers and an early corral", () =>
	{
		const world = makeHqWorld({
			"stock": { "food": 300, "wood": 900 },
			// the island link to open sea 4, as naval campaign's navy reads it
			"regionLinks": { 2: [4], 3: [3] },
		});
		const hq = seatHQ(world, {
			stubs: doorManagers,
			"navalRegions": { 4: true },
		});
		// the map's island is region 2 of 100 territory cells...
		// (the harness default 100 cells * 2x2 = 400 map units, under every cut)
		// the same list the manager campaigns register from territories
		world.templates["structures/athen/corral"] = structureTemplate("structures/athen/corral",
			{ "classes": ["Structure", "Corral"] });
		builder(world, 17, ["structures/athen/corral"]);
		hq.buildManager.init(world.gameState);

		hq.handleNewBase(world.gameState);

		assert.equal(hq.saveSpace, true);
		// targetNumFishers 1 → at least two boats requested on the sea reaching us
		assert.deepEqual(hq.navalManagerCalls[0], ["updateFishingBoats", [4, 2]]);
		assert.equal(hq.maxFields, 1);
		// almost no food on the island: the plans dock fishing over farms
		assert.equal(hq.needFish, true);
		assert.equal((hq.Config.Economy as Record<string, number>).popForDock, 1);
		// almost no wood: save up until the town phase, and floors popPhase2
		assert.equal(hq.saveResources, true);
		assert.equal((hq.Config.Economy as Record<string, number>).popPhase2, 112); // floor(0.75 * 150)
		// the corral is raised right away (no fields without feed for them)
		assert.equal(hq.needCorral, true);
		assert.equal(world.ai.queues.corral.plans.length, 1);
	});

	it("no room for a farm: the corral takes over the island-economy", () =>
	{
		const world = makeHqWorld({ "stock": { "food": 500, "wood": 1500 } });
		(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
		const hq = seatHQ(world, { stubs: doorManagers });
		world.templates["structures/athen/corral"] = structureTemplate("structures/athen/corral",
			{ "classes": ["Structure", "Corral"] });
		builder(world, 17, ["structures/athen/corral"]);
		hq.buildManager.init(world.gameState);

		hq.handleNewBase(world.gameState);

		// under 800 food the continent plants farms; under 2000 wood there is
		// nothing to harvest the farms with, so the plan flips to corrals
		assert.equal(hq.maxFields, false);
		assert.equal(hq.needCorral, true);
		assert.ok(!hq.needFarm);
	});

	it("a rich wood pile forgives rushes by the ceasefire weather", () =>
	{
		// (1) long truce: no rush is worth it at all
		{
			const world = makeHqWorld({ "stock": { "food": 1000, "wood": 16000 }, "ceasefire": 1200 });
			(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
			const hq = seatHQ(world, { stubs: doorManagers,
				config: makeHQConfig({ "personality": { "aggressive": 0.8 } }) });
			hq.handleNewBase(world.gameState);
			// allowed = ceil(7500/3000) = 3, but the truce lasts
			assert.equal(hq.attackManager.maxRushes, 0);
		}
		// (2) a short truce: one wave still goes out
		{
			const world = makeHqWorld({ "stock": { "food": 1000, "wood": 16000 }, "ceasefire": 700 });
			(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
			const hq = seatHQ(world, { stubs: doorManagers,
				config: makeHQConfig({ "personality": { "aggressive": 0.8 } }) });
			hq.handleNewBase(world.gameState);
			assert.equal(hq.attackManager.maxRushes, 1);
			assert.deepEqual(hq.attackManager.rushSize, [20]);
		}
		// (3) open war and a very aggressive player: three waves at once
		{
			const world = makeHqWorld({ "stock": { "food": 1000, "wood": 16000 } });
			(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
			const hq = seatHQ(world, { stubs: doorManagers,
				config: makeHQConfig({ "personality": { "aggressive": 0.8 } }) });
			hq.handleNewBase(world.gameState);
			assert.equal(hq.attackManager.maxRushes, 3);
			assert.deepEqual(hq.attackManager.rushSize, [16, 20, 24]);
		}
	});

	it("the first storehouse rises at the forest gate", () =>
	{
		const world = makeHqWorld({ "stock": { "food": 1000, "wood": 9000 } });
		(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
		const hq = seatHQ(world, { stubs: doorManagers });

		// a forest inside the settled ground (past the map's border ring), and
		// the gather-estimation map HQ records for its cells — the value
		// updateResources books for a wood-that-matters there
		const seedCC = world.ents.get(1000) as unknown as Record<string, (...args: any[]) => unknown>;
		seedCC.resourceDropsiteTypes = () => ["food", "wood", "stone", "metal"];
		world.addEntity(makeGaiaSupply({ "id": 2, "position": [140, 100], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		world.addEntity(makeGaiaSupply({ "id": 3, "position": [146, 96], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		const { width } = world.map.territory;
		const forestCell = (140 / 8 | 0) + width * (100 / 8 | 0);
		const woodMap = (world.gameState.sharedScript as unknown as
			Record<string, Record<string, { map: Float32Array }>>).resourceMaps.wood.map;
		woodMap[forestCell] = 100;
		// gameAnalysis books the stockade's territory before the town plans —
		// the depot scanner only looks inside the claimed ground
		hq.updateTerritories(world.gameState);

		world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse",
			{ "classes": ["Structure", "DropsiteWood"], "dropsiteTypes": ["wood"] });
		builder(world, 17, ["structures/athen/storehouse"]);
		hq.buildManager.init(world.gameState);

		hq.basesManager.baseManagers[0].assignResourceToDropsite(world.gameState, seedCC);
		// the scanner saw the forest inside the town square's radius (medium band)
		assert.ok((hq.basesManager.baseManagers[0].dropsiteSupplies.wood.medium as unknown[]).length >= 1);

		hq.handleNewBase(world.gameState);

		const plans = world.ai.queues.dropsites.plans;
		assert.equal(plans.length, 1);
		assert.equal(plans[0].type, "structures/athen/storehouse");
		// it belongs to the first base
		assert.deepEqual(plans[0].metadata, { "base": hq.baseManagers()[0].ID });
		// not our starting position: the depot sits by the trees, not at the cc
		assert.notDeepEqual(plans[0].position, [10, 10]);
		// the coworkers' census is a handful, too few to pre-fund the depot:
		// the dropsites account rests at zero wood (resources.js books every
		// resource at 0 on a fresh account, and nothing tops it before start)
		const account = world.ai.queueManager.accounts.dropsites;
		assert.equal((account as unknown as Record<string, number>).wood, 0);
	});

	it("no wood to book on the map: no depot is planned", () =>
	{
		const world = makeHqWorld({ "stock": { "food": 1000, "wood": 9000 } });
		(world.ai.accessibility as Record<string, unknown>).regionSize = { 2: 20000, 3: 400 };
		const hq = seatHQ(world, { stubs: doorManagers });

		const seedCC = world.ents.get(1000) as unknown as Record<string, (...args: any[]) => unknown>;
		seedCC.resourceDropsiteTypes = () => ["food", "wood", "stone", "metal"];
		world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse",
			{ "classes": ["Structure", "DropsiteWood"], "dropsiteTypes": ["wood"] });
		builder(world, 17, ["structures/athen/storehouse"]);
		hq.buildManager.init(world.gameState);

		hq.handleNewBase(world.gameState);

		// the gather-estimation maps are flat: the depot-scanner finds a quality
		// of 0 everywhere and plans nothing
		assert.equal((world.ai.queues as Record<string, { plans: unknown[] }>).dropsites.plans.length, 0);
	});

	it("a corral already standing is not doubled", async () =>
	{
		const world = makeHqWorld({ "stock": { "food": 300, "wood": 900 } });
		const hq = seatHQ(world, { stubs: doorManagers });
		world.addEntity(makeHqEntity({
			id: 500, "owner": PLAYER, "position": [15, 15],
			"classes": ["Structure", "Corral"],
			"templateName": "structures/athen_corral",
		}));

		const { configFirstBase } = await startingStrategy();
		configFirstBase(hq, world.gameState);
		assert.equal(hq.needCorral, true);
		// the queue stays unparked: one corral already rises
		const corral = (world.ai.queues as Record<string, { plans: unknown[] }>).corral;
		assert.ok(!corral || corral.plans.length === 0);
	});

	it("the second civil centre clears the scarcity flags", () =>
	{
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// a town expanded once: the scarcity day-one is already written
		hq.firstBaseConfig = true;
		hq.saveResources = true;
		hq.saveSpace = true;
		hq.maxFields = 1;

		hq.handleNewBase(world.gameState);

		// the code clears the flags by writing them away (undefined): the
		// second settlement resets the starting scarcity to nothing at all
		assert.notEqual(hq.saveResources, true);
		assert.notEqual(hq.saveSpace, true);
		assert.equal(hq.maxFields, false);
		// and the rushes table was not touched a second time
		assert.equal(hq.attackManager.maxRushes, 0);
	});
});

/** A town square with its training cards: the civic centre raises the
 * native civilian (`units/{native}/support_civilian`, template_structure_civic_
 * civil_centre's Trainer list) and the barracks the basic infantry cards. */
type FakeFacility = FakeEnt & Record<string, (...args: any[]) => unknown>;
function trainerTown(world: HqWorld): { civicCentre: FakeFacility; barracks: FakeFacility }
{
	const civicCentre = world.ents.get(1000) as unknown as FakeFacility;
	if (civicCentre)
	{
		// the engine's CCmpTrainer always answers an array here (an empty
		// queue still answers []), so the CC is a facility even at rest
		civicCentre.trainingQueue = () => [];
		civicCentre.trainableEntities = () => ["units/athen/support_civilian"];
		world.templates["units/athen/support_civilian"] = makeTemplate("units/athen/support_civilian",
			{
				"classes": ["Unit", "Human", "Support", "Builder", "Civilian", "Worker"],
				"cost": { "food": 50 }, "walkSpeed": 9,
				"getPaths": { "Cost": { "Population": 1 } }
			});
	}
	const barracks = world.addEntity(makeHqEntity({
		"id": 400, "owner": PLAYER, "position": [104, 140],
		"classes": ["Structure", "Barracks"], "templateName": "structures/athen/barracks",
	}, { "trainingQueue": () => [] })) as FakeFacility;
	barracks.trainableEntities = () => [
		"units/athen/infantry_spearman_b", "units/athen/infantry_archer_b"
	];
	world.templates["structures/athen/barracks"] = structureTemplate("structures/athen/barracks",
		{ "classes": ["Structure", "Barracks"] });
	// crops under the walls: the full 0.3 support share applies unless a
	// suite drops the field again (the lost-fields suite)
	world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
		{ "classes": ["Structure", "Economic", "Field"] });
	world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b",
		{
			"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Melee",
				"Spearman", "Worker", "Citizen"],
			// the infantry base costs 50 food, the spearman adds 50 wood
			"cost": { "food": 50, "wood": 50 }, "walkSpeed": 9.5,
			"getPaths": { "Cost": { "Population": 1 } }
		});
	world.templates["units/athen/infantry_archer_b"] = makeTemplate("units/athen/infantry_archer_b",
		{
			"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Ranged",
				"Archer", "Worker", "Citizen"],
			"cost": { "food": 50, "wood": 50 }, "walkSpeed": 9,
			"getPaths": { "Cost": { "Population": 1 } }
		});
	return { civicCentre, barracks };
}

/** a citizen worker already on the payroll (no plan holds it) */
function hand(world: HqWorld, id: number, soldier: boolean): FakeEnt
{
	const spec = soldier ?
		{ "id": id, "owner": PLAYER, "position": [80 + id, 80 + id] as [number, number],
			"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry", "Melee", "Worker"],
			"templateName": "units/athen/infantry_spearman_b" } :
		{ "id": id, "owner": PLAYER, "position": [60 + id, 60 + id] as [number, number],
			"classes": ["Unit", "Human", "Support", "Worker", "Civilian", "Builder"],
			"templateName": "units/athen/support_civilian" };
	const ent = world.addEntity(makeHqEntity(spec, {}, { "role": "worker" })) as FakeEnt;
	return ent;
}

/** seed a live training order on a queue, as a started TrainingPlan sits */
async function trainingOrder(world: HqWorld, queueName: string, template: string,
	number: number, metadata: Record<string, unknown>, count = 1)
{
	const { TrainingPlan } = await petraPlans();
	const queues = world.ai.queues as unknown as
		Record<string, { addPlan(plan: unknown): void; plans: Array<Record<string, unknown>> }>;
	for (let i = 0; i < count; ++i)
		queues[queueName].addPlan(new TrainingPlan(world.gameState, template, metadata,
			number, Math.max(number, 5)));
}

/** the plan cards the suites build orders with (petra's module exports) */
let petraPlansCache: Promise<{ TrainingPlan: unknown; ConstructionPlan: unknown }> | undefined;
async function petraPlans(): Promise<{ TrainingPlan: any; ConstructionPlan: any }>
{
	petraPlansCache ??= Promise.all([
		loadPetraModule<{ TrainingPlan: unknown }>("queueplanTraining"),
		loadPetraModule<{ ConstructionPlan: unknown }>("queueplanBuilding")
	]).then(([training, building]) => ({
		"TrainingPlan": training.TrainingPlan,
		"ConstructionPlan": building.ConstructionPlan
	}));
	return petraPlansCache as Promise<{ TrainingPlan: any; ConstructionPlan: any }>;
}


describe("headquarters and phase advance: what the city still lacks", () => {
	it("a town requirement orders the market; the phase-up booking goes through", () =>
	{
		// the real ladder (phase_city_generic.json) asks three Town-class
		// structures before the city research completes; a fresh town holds
		// its civic centre (not a Town-class building — the civil centre
		// template carries no Town token) so the office must raise one
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Town", "count": 3 }] }
		});

		world.templates["structures/athen/market"] = structureTemplate("structures/athen/market",
			{ "classes": ["Structure", "Trade", "Town", "Market"] });
		builder(world, 17, ["structures/athen/market"]);
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		const economic = world.ai.queues as unknown as
			Record<string, { plans: Array<Record<string, unknown>> }>;
		const plans = economic.economicBuilding.plans;
		assert.equal(plans.length, 1);
		assert.equal(plans[0].type, "structures/athen/market");
		// marked as the phase-up building and parked back afterwards
		assert.deepEqual(plans[0].metadata, { "phaseUp": true });
		assert.equal(plans[0].queueToReset, "economicBuilding");
		// construction first: the economic queue reservation climbs to 1000
		const priority = (world.ai.queueManager as unknown as
			{ getPriority(queue: string): number }).getPriority("economicBuilding");
		assert.equal(priority, 1000);
		// and the barracks gets nothing: one building per phase-up turn
		assert.equal((economic.militaryBuilding as { plans: unknown[] }).plans.length, 0);
	});

	it("the market already trading hands the town requirement to the temple", () =>
	{
		// a market stands (it counts Town) so the next code path looks for
		// the second town anchor of a real city core
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Town", "count": 3 }] }
		});

		world.addEntity(makeHqEntity({
			"id": 500, "owner": PLAYER, "position": [80, 120],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market",
		}));
		world.templates["structures/athen/market"] = structureTemplate("structures/athen/market",
			{ "classes": ["Structure", "Trade", "Town", "Market"] });
		world.templates["structures/athen/temple"] = structureTemplate("structures/athen/temple",
			{ "classes": ["Structure", "Town", "Temple"] });
		builder(world, 17, ["structures/athen/temple"]);
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		const economic = (world.ai.queues as unknown as
			Record<string, { plans: Array<Record<string, unknown>> }>).economicBuilding;
		assert.equal(economic.plans.length, 1);
		assert.equal(economic.plans[0].type, "structures/athen/temple");
		assert.equal(economic.plans[0].queueToReset, "economicBuilding");
	});

	it("market and temple standing: the forge answers on the military queue", () =>
	{
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Town", "count": 3 }] }
		});

		world.addEntity(makeHqEntity({
			"id": 500, "owner": PLAYER, "position": [80, 120],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market",
		}));
		world.addEntity(makeHqEntity({
			"id": 501, "owner": PLAYER, "position": [96, 120],
			"classes": ["Structure", "Town", "Temple"],
			"templateName": "structures/athen/temple",
		}));
		world.templates["structures/athen/forge"] = structureTemplate("structures/athen/forge",
			{ "classes": ["Structure", "Town", "Forge"] });
		builder(world, 17, ["structures/athen/forge"]);
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		const military = (world.ai.queues as unknown as
			Record<string, { plans: Array<Record<string, unknown>> }>).militaryBuilding;
		assert.equal(military.plans.length, 1);
		assert.equal(military.plans[0].type, "structures/athen/forge");
		assert.equal(military.plans[0].queueToReset, "militaryBuilding");
		// the barracks' own line climbs to 1000 for the phase-up building
		const priority = (world.ai.queueManager as unknown as
			{ getPriority(queue: string): number }).getPriority("militaryBuilding");
		assert.equal(priority, 1000);
	});

	it("three town buildings standing: the requirement is already met", () =>
	{
		// market, temple and forge all carry the Town visible class — with
		// three of them the city-bound count is satisfied
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Town", "count": 3 }] }
		});

		world.addEntity(makeHqEntity({
			"id": 500, "owner": PLAYER, "position": [80, 120],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market",
		}));
		world.addEntity(makeHqEntity({
			"id": 501, "owner": PLAYER, "position": [96, 120],
			"classes": ["Structure", "Town", "Temple"],
			"templateName": "structures/athen/temple",
		}));
		world.addEntity(makeHqEntity({
			"id": 502, "owner": PLAYER, "position": [112, 120],
			"classes": ["Structure", "Town", "Forge"],
			"templateName": "structures/athen/forge",
		}));
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		// every queue stays empty and untouched
		for (const queue of ["economicBuilding", "militaryBuilding", "wonder", "majorTech"])
			assert.equal(((world.ai.queues as Record<string, { plans: unknown[] }>)[queue] ??
				{ plans: [] }).plans.length, 0, queue);
		// no priority was lifted
		const priorities = hq.Config.priorities;
		assert.equal((priorities as Record<string, number>).economicBuilding, 700);
	});

	it("the economic queue is busy: a town requirement waits its turn", async () =>
	{
		// the town's line already builds a corral for the herd; the office
		// will not wedge the market in front of a running project
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Town", "count": 3 }] }
		});

		world.templates["structures/athen/market"] = structureTemplate("structures/athen/market",
			{ "classes": ["Structure", "Trade", "Town", "Market"] });
		world.templates["structures/athen/temple"] = structureTemplate("structures/athen/temple",
			{ "classes": ["Structure", "Town", "Temple"] });
		world.templates["structures/athen/forge"] = structureTemplate("structures/athen/forge",
			{ "classes": ["Structure", "Town", "Forge"] });
		builder(world, 17, ["structures/athen/market"]);
		hq.buildManager.init(world.gameState);

		world.templates["structures/athen/corral"] = structureTemplate("structures/athen/corral",
			{ "classes": ["Structure", "Corral"] });
		const { ConstructionPlan } = await petraPlans();
		const queues = world.ai.queues as unknown as
			Record<string, { addPlan(plan: unknown): void; plans: Array<Record<string, unknown>> }>;
		queues.economicBuilding.addPlan(new ConstructionPlan(world.gameState,
			"structures/athen/corral"));

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		// the corral remains the only order on the economic line
		assert.equal(queues.economicBuilding.plans.length, 1);
		assert.equal(queues.economicBuilding.plans[0].type, "structures/athen/corral");
		assert.equal((queues.militaryBuilding).plans.length, 0);
	});

	it("the village count is the houses' business, not the office's", () =>
	{
		// the true phase-town requirement (phase_town_generic.json) reads
		// five Village-class structures; the office leaves houses half of it
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Village", "count": 5 }] }
		});

		world.templates["structures/athen/market"] = structureTemplate("structures/athen/market",
			{ "classes": ["Structure", "Trade", "Town", "Market"] });
		builder(world, 17, ["structures/athen/market"]);
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		assert.equal(((world.ai.queues as Record<string,
			{ plans: unknown[] }>).economicBuilding).plans.length, 0);
		const priority = (world.ai.queueManager as unknown as
			{ getPriority(queue: string): number }).getPriority("economicBuilding");
		assert.equal(priority, 700);
	});

	it("a wonder class books the wonder and scraps the major-tech price", () =>
	{
		// wonder victory worlds require their wonder before the last phase:
		// the office steers the class-less requirement to the wonder queue
		const { world, hq } = seat({
			"phaseRequirements": { 2: [{ "class": "Wonder", "count": 1 }] }
		});

		world.templates["structures/athen/wonder"] = structureTemplate("structures/athen/wonder",
			{ "classes": ["Structure", "City", "Wonder"] });
		builder(world, 17, ["structures/athen/wonder"]);
		hq.buildManager.init(world.gameState);

		hq.checkPhaseRequirements(world.gameState, world.ai.queues as never);

		const wonder = (world.ai.queues as unknown as
			Record<string, { plans: Array<Record<string, unknown>> }>).wonder;
		assert.equal(wonder.plans.length, 1);
		assert.equal(wonder.plans[0].type, "structures/athen/wonder");
		assert.equal(wonder.plans[0].queueToReset, "majorTech");
		// techs queue demoted to 400 so the wonder holds the cash
		const priority = (world.ai.queueManager as unknown as
			{ getPriority(queue: string): number }).getPriority("majorTech");
		assert.equal(priority, 400);
	});
});

describe("headquarters and the workforce: how many hands the village asks for", () => {
	it("eight hands out, ten more on the books: the orders trim back to one", async () =>
	{
		// eight workers stand in the fields, two queued orders of ten hands
		// each. With the standing workforce under a dozen, the training
		// orders shrink to a single pair of hands, so a raid's losses heal
		// cheaply and the town rebuilds from small bills
		const { world, hq } = seat();
		const { civicCentre, barracks } = trainerTown(world);
		assert.ok(civicCentre && barracks);
		for (let i = 0; i < 8; ++i)
			hand(world, 500 + i, false);
		await trainingOrder(world, "villager", "units/athen/support_civilian", 10,
			{ "role": "worker", "base": 0, "support": true }, 2);

		// the queued supports now stand far past the share the office
		// wants, so the next order goes to the barracks; the office
		// sprinkles one recruit class, and the suite pins the dice to the
		// melee pick (["Ranged", "Melee", "Infantry"][1])
		stubGlobal("pickRandom", (list: string[]) => list[1]);
		try
		{
			hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

			const queues = world.ai.queues as unknown as
				Record<string, { plans: Array<{ number: number; type: string; metadata?: Record<string, unknown> }> }>;
			assert.equal(queues.villager.plans[0].number, 1);
			assert.equal(queues.villager.plans[1].number, 1);
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_spearman_b");
			assert.deepEqual(queues.citizenSoldier.plans[0].metadata, { "role": "worker", "base": 0 });
		}
		finally
		{
			restoreEngine();
		}
	});

	// one census, two answers: the town holds 30 paid workers of which 13
	// are support hands. The office's share formula reads
	// supportNum(α) = 18 · (1 − e^−α·30/18) — 18 being supportRatio 0.3 ×
	// targetNumWorkers 60 — so peace (α 0.85) books 13.6 supports and a
	// rush getting ready (α 0.7) only 12.4. Thirteen supports stand above
	// the ready-for-rush share but below the peaceful one: the two answers
	// part exactly at this census.
	it("a fresh town: thirteen supports stand below the peaceful share", async () =>
	{
		const { world, hq } = seat();
		trainerTown(world);
		for (let i = 0; i < 13; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 17; ++i)
			hand(world, 600 + i, true);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ number: number; type: string; metadata?: Record<string, unknown> }> }>;
		assert.equal(queues.villager.plans.length, 1);
		assert.equal(queues.villager.plans[0].type, "units/athen/support_civilian");
		// the batch reads ceil(30/10) = 3
		assert.equal(queues.villager.plans[0].number, 3);
		assert.deepEqual(queues.villager.plans[0].metadata,
			{ "role": "worker", "base": 0, "support": true });
		assert.equal(queues.citizenSoldier.plans.length, 0);
	});

	it("a second rush getting ready: the same town now reaches for spears", async () =>
	{
		// the attack manager (as setRushes books for a second wave) allows
		// one more rush: alpha drops to 0.7, the share falls under the
		// thirteen standing supports and the order goes to the barracks
		const { world, hq } = seat();
		trainerTown(world);
		for (let i = 0; i < 13; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 17; ++i)
			hand(world, 600 + i, true);
		hq.attackManager.maxRushes = 1;

		stubGlobal("pickRandom", (list: string[]) => list[1]);
		try
		{
			hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

			const queues = world.ai.queues as unknown as
				Record<string, { plans: Array<{ number: number; type: string }> }>;
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_spearman_b");
			// the villager line stands still
			assert.equal(queues.villager.plans.length, 0);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("a truce day: the peace lobe books one hand more", async () =>
	{
		// arming the truce boost: with 14 supports of 30 the peaceful share
		// (13.6) stays below them, while the boosted alpha reads
		// α = 0.85 + (1 − 0.85) · min(max(600 − 120, 0), 180)/180 = 1.0 →
		// 18 · (1 − e^−30/18) = 14.6 — one hand beyond the standing count,
		// so the truce town trains a civilian where the open town would
		// not
		const { world, hq } = seat({
			"ceasefire": true
		});
		trainerTown(world);
		for (let i = 0; i < 14; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 16; ++i)
			hand(world, 600 + i, true);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ type: string }> }>;
		assert.equal(queues.villager.plans.length, 1);
		assert.equal(queues.villager.plans[0].type, "units/athen/support_civilian");
	});

	it("the fields are lost: the town no longer leans on civilians", async () =>
	{
		// no field template is on offer (the fields under the walls fall),
		// so the share supportRatio takes the 0.1 floor: supportMax 6 hands (0.1·60) and with 30 numberTotal
		// the share reads 6·(1 − e^−0.85·30/6) ≈ 5.9 — the eight standing
		// supports stand above it, and the next hands come from the barracks
		const { world, hq } = seat();
		trainerTown(world);
		// the fields fall: the office sweeps for any field template and
		// finds none
		delete (world.templates as Record<string, unknown>)["structures/athen/field"];
		for (let i = 0; i < 8; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 22; ++i)
			hand(world, 600 + i, true);

		// the office sprinkles the recruit class; the suite pins the dice
		// to the melee pick
		stubGlobal("pickRandom", (list: string[]) => list[1]);
		try
		{
			hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

			const queues = world.ai.queues as unknown as
				Record<string, { plans: Array<{ type: string }> }>;
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_spearman_b");
			assert.equal(queues.villager.plans.length, 0);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("fields under the walls: the same roster still asks for civilians", async () =>
	{
		// the same 8/22 census with a field template on offer: the full 0.3
		// share applies and 8 supports stand below 18·(1 − e^−0.85·30/18) =
		// 13.6, so the villager line books the next order
		const { world, hq } = seat();
		trainerTown(world);
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Economic", "Field"] });
		for (let i = 0; i < 8; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 22; ++i)
			hand(world, 600 + i, true);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ type: string }> }>;
		assert.equal(queues.villager.plans.length, 1);
		assert.equal(queues.villager.plans[0].type, "units/athen/support_civilian");
	});

	it("a dozen-plus on the books: the town books two at a time", async () =>
	{
		// thirteen standing workers: once the workforce crosses a dozen
		// the batch doubles (ceil(13/10)), and the ordered bill reads two
		const { world, hq } = seat();
		trainerTown(world);
		for (let i = 0; i < 13; ++i)
			hand(world, 500 + i, false);
		await trainingOrder(world, "villager", "units/athen/support_civilian", 9,
			{ "role": "worker", "base": 0, "support": true });

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ number: number }> }>;
		assert.equal(queues.villager.plans[0].number, 2);
	});

	it("a large city: the batch never tops five hands", async () =>
	{
		// seventy workers out: ceil(70/10) = 7, but the order never books
		// more than five at once
		const { world, hq } = seat();
		trainerTown(world);
		for (let i = 0; i < 70; ++i)
			hand(world, 500 + i, false);
		await trainingOrder(world, "villager", "units/athen/support_civilian", 9,
			{ "role": "worker", "base": 0, "support": true });

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ number: number }> }>;
		assert.equal(queues.villager.plans[0].number, 5);
	});

	it("purse saved past the phase-two budget: no new bill is booked", async () =>
	{
		// the pop budget for the phase-two day sits at popPhase2 (150 in
		// the real economy; 1 here — an annotated shrink that keeps the
		// census a village). Past budget + 10 hands the office orders
		// nothing while its purse is in save mode
		const { world, hq } = seat();
		trainerTown(world);
		(hq.Config.Economy as Record<string, number>).popPhase2 = 1;
		for (let i = 0; i < 12; ++i)
			hand(world, 500 + i, false);
		hq.saveResources = true;

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: unknown[] }>;
		assert.equal(queues.villager.plans.length, 0);
		assert.equal(queues.citizenSoldier.plans.length, 0);
	});

	it("the same census with the purse open and phase two reached: it resumes", async () =>
	{
		// identical census, purse open, town phase done (currentPhase 2
		// reads the phase-two stop): the halt was the saved purse alone,
		// not the headcount — the office books again, and the twelve
		// standing supports dwarf the no-field share (0.1·60 = 6 hands',
		// share on 12 total ≈ 6·(1 − e^−1.7) ≈ 4.9), so the barracks answers
		const { world, hq } = seat();
		trainerTown(world);
		(hq.Config.Economy as Record<string, number>).popPhase2 = 1;
		for (let i = 0; i < 12; ++i)
			hand(world, 500 + i, false);
		hq.currentPhase = 2;

		// pin the office's recruit-class dice to the melee pick
		stubGlobal("pickRandom", (list: string[]) => list[1]);
		try
		{
			hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

			const queues = world.ai.queues as unknown as
				Record<string, { plans: Array<{ type: string }> }>;
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_spearman_b");
			assert.equal(queues.villager.plans.length, 0);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("phase two still in research: the halt relaxes for the research days", async () =>
	{
		// currentPhase 1 but the city tech is on the researchers' desks
		// (the researching list): the popPhase2 stop applies only while no
		// phase tech is being researched, so a town of 5 supports and 7
		// soldiers keeps booking — 5 supports stand below the share
		// 18·(1 − e^−0.85·12/18) ≈ 7.8 with a field on offer
		const { world, hq } = seat({
			"researching": ["phase_city"],
			// the city tech exists, and sits being researched
			"phaseName": "phase_city"
		});
		trainerTown(world);
		(hq.Config.Economy as Record<string, number>).popPhase2 = 1;
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Economic", "Field"] });
		for (let i = 0; i < 5; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 7; ++i)
			hand(world, 600 + i, true);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: Array<{ number: number; type: string }> }>;
		assert.equal(queues.villager.plans.length, 1);
		assert.equal(queues.villager.plans[0].type, "units/athen/support_civilian");
		// the batch reads ceil(12/10) = 2
		assert.equal(queues.villager.plans[0].number, 2);
	});

	it("sixteen hands still on the training ground: any new order waits", async () =>
	{
		// sixteen hands mid-training at the civic centre: above fifteen
		// anywhere in the train the office adds no more
		const { world, hq } = seat();
		const { civicCentre, barracks } = trainerTown(world);
		assert.ok(civicCentre && barracks);
		// one live sixteen-hand order, shaped as the engine lists it
		// (entity.js: unitTemplate, count, metadata)
		civicCentre.trainingQueue = () => [
			{ "count": 16, "unitTemplate": "units/athen/support_civilian",
				"metadata": { "role": "worker", "support": true } }
		];

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: unknown[] }>;
		assert.equal(queues.villager.plans.length, 0);
		assert.equal(queues.citizenSoldier.plans.length, 0);
	});

	it("both lines hold orders above twenty: neither gets another", async () =>
	{
		// four ten-hand bills queued on each line (the first two of each
		// trim to one, leaving 22 + 22 = 44, under the fifty cap but past
		// twenty on both): neither line takes a further order
		const { world, hq } = seat();
		const { civicCentre, barracks } = trainerTown(world);
		assert.ok(civicCentre && barracks);
		await trainingOrder(world, "villager", "units/athen/support_civilian", 10,
			{ "role": "worker", "base": 0, "support": true }, 4);
		await trainingOrder(world, "citizenSoldier", "units/athen/infantry_spearman_b", 10,
			{ "role": "worker", "base": 0 }, 4);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: unknown[] }>;
		assert.equal(queues.villager.plans.length, 4);
		assert.equal(queues.citizenSoldier.plans.length, 4);
	});

	it("a facility with no trainer cards: nobody gets hired", async () =>
	{
		// the town's only trainer keeps an empty card list (a barracks
		// mid-foundations trains nothing): the office has no villager and
		// no soldier to order, and both queues stand still
		const { world, hq } = seat();
		world.addEntity(makeHqEntity({
			"id": 400, "owner": PLAYER, "position": [104, 140],
			"classes": ["Structure", "Barracks"], "templateName": "structures/athen/barracks",
		}, { "trainingQueue": () => [] }));
		for (let i = 0; i < 3; ++i)
			hand(world, 500 + i, false);

		hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

		const queues = world.ai.queues as unknown as
			Record<string, { plans: unknown[] }>;
		assert.equal(queues.villager.plans.length, 0);
		assert.equal(queues.citizenSoldier.plans.length, 0);
	});
});

describe("headquarters and the recruit choice: what the weights pick", () => {
	// the comparator the office runs on its two recruit bills: value =
	// 0.1 + Σ param·weight, then every resource the card costs multiplies
	// that value by its costsResource weight, and the order divides by
	// 1 + costSum. The bookkeeping appends the same costsResource weight
	// for every resource the town can neither stock (available ≤ 800) nor
	// still gather (remaining ≤ 400 books 0.2; remaining ≤ 800 books 0.6).
	it("no trainer to house them: the choice returns nothing", () =>
	{
		const { world, hq } = seat();
		// no facility anywhere on the plain — the camp answers no card
		const best = hq.findBestTrainableUnit(world.gameState, ["Support+Worker"],
			[["costsResource", 1, "food"]]);

		assert.equal(best, undefined);
	});

	it("the honest speeds: at equal cost the quicker recruit leads", () =>
	{
		// the two first-line infantry cards of a real game: the melee
		// hoplite walks 9.5 (template_unit_infantry_melee), the ranged
		// archer 9 (the template_unit base). Costs equal at 50 food +
		// 50 wood, so the [speed 0.5] sweep picks the hoplite —
		// (0.1 + 0.5·9.5)/101 = 0.0480 stands above (0.1 + 0.5·9)/101 = 0.0455
		const { world, hq } = seat({ "stock": { "food": 1000, "wood": 1000 } });
		trainerTown(world);

		const best = hq.findBestTrainableUnit(world.gameState,
			[["CitizenSoldier", "Infantry", "Melee"]], [["speed", 0.5]]);

		assert.equal(best, "units/athen/infantry_spearman_b");
	});

	it("a city of forty-five hands: the office judges recruits by their arms", async () =>
	{
		// past forty-five paid workers the recruit sweep swaps from the
		// walk-speed and discount weights to the strength table:
		// getMaxStrength weighs every Attack/<type>/Damage entry with the
		// config's DamageTypeImportance (Hack .075, Pierce .085, Crush
		// .045, Fire .001 — four types), adds range and timing at
		// 0.0125·MaxRange and ±time/100000, adds the resistance Damage the
		// same way, then multiplies by Health/Max / 100. The real cards:
		// the spear strikes 4.5 Hack + 4 Pierce at range 4, rests
		// 3/3, on 100 health — 0.1 + 0.344 = 0.444; the bow pierces 7.2 at
		// range 60, rests 1/1, on 50 health — 0.1 + 0.474 = 0.574. At
		// equal 50-food + 50-wood bills the bow's reach and damage out-
		// weigh the spear's sturdier frame (the Slaughter all units carry
		// is skipped by the sweep)
		const { world, hq } = seat({ "stock": { "food": 1000, "wood": 1000 } });
		trainerTown(world);
		// the two recruit cards carry their real attack blocks
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b",
			{
				"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry",
					"Melee", "Spearman", "Worker", "Citizen"],
				"cost": { "food": 50, "wood": 50 }, "walkSpeed": 9.5,
				"getPaths": { "Cost": { "Population": 1 } },
				"attackTypes": ["Melee", "Slaughter"],
				"attackStrengths": { "Melee": { "Hack": 4.5, "Pierce": 4 } },
				"attackRanges": { "Melee": { "max": 4 } },
				"attackTimes": { "Melee": { "prepare": 500, "repeat": 1000 } },
				"resistanceStrengths": { "Hack": 3, "Pierce": 3 },
				"maxHitpoints": 100
			});
		world.templates["units/athen/infantry_archer_b"] = makeTemplate("units/athen/infantry_archer_b",
			{
				"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry",
					"Ranged", "Archer", "Worker", "Citizen"],
				"cost": { "food": 50, "wood": 50 }, "walkSpeed": 9,
				"getPaths": { "Cost": { "Population": 1 } },
				"attackTypes": ["Ranged", "Slaughter"],
				"attackStrengths": { "Ranged": { "Pierce": 7.2 } },
				"attackRanges": { "Ranged": { "max": 60 } },
				"attackTimes": { "Ranged": { "prepare": 800, "repeat": 1250 } },
				"resistanceStrengths": { "Hack": 1, "Pierce": 1 },
				"maxHitpoints": 50
			});
		// eighteen supports and twenty-seven hoplites on the payroll: the
		// support share 18·(1 − e^−0.85·45/18) = 15.9 stands below the
		// standing supports, so the barracks answers, and 45 in total
		// pushes the sweep to the strength table
		for (let i = 0; i < 18; ++i)
			hand(world, 500 + i, false);
		for (let i = 0; i < 27; ++i)
			hand(world, 600 + i, true);

		// pin the class dice to Infantry so both cards face the sweep
		stubGlobal("pickRandom", (list: string[]) => list[2]);
		try
		{
			hq.trainMoreWorkers(world.gameState, world.ai.queues as never);

			const queues = world.ai.queues as unknown as
				Record<string, { plans: Array<{ number: number; type: string }> }>;
			assert.equal(queues.citizenSoldier.plans.length, 1);
			assert.equal(queues.citizenSoldier.plans[0].type, "units/athen/infantry_archer_b");
			// the batch reads ceil(45/10), capped at five
			assert.equal(queues.citizenSoldier.plans[0].number, 5);
		}
		finally
		{
			restoreEngine();
		}
	});

	// the two swing cards for the weight stories: no real recruit card
	// costs stone, so the suite hands a synthetic stone-flavoured one
	// (annotate-facing stand-in) to face the real artisan (cost food 50)
	// — what both worlds share: available food 1000 books the food slot
	// over the sweep's 800 shelf, so the artisan pays no gathered-wealth
	// discount at all
	it("a card whose only cost rides above the shelf: it pays nothing", () =>
	{
		// a fresh town with food in hand (1000): the sweep skips food
		// entirely (available > 800) and weights the rest at 0.2 — the
		// artisan reads 0.1/51 = 0.00196 and the stone card
		// 0.1·0.2/21 = 0.00095: the untouched card leads
		const { world, hq } = seat({ "stock": { "food": 1000 } });
		trainerTown(world);
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b",
			{
				"classes": ["Unit", "Infantry"], "cost": { "stone": 20 }, "walkSpeed": 9.5
			});

		const best = hq.findBestTrainableUnit(world.gameState, ["Unit"],
			[["costsResource", 1, "food"]]);

		assert.equal(best, "units/athen/support_civilian");
	});

	it("a stone hill behind the walls: the stone-flavoured card wins instead", () =>
	{
		// the same pair, but the town's central dropsite bookkeeps 600
		// gatherable stone: remaining > 400 books the 0.6 weight, and the
		// stone card reads 0.1·0.6/21 = 0.00286 above the artisan's
		// 0.00196 — the discount bookkeeping flips the choice
		const { world, hq } = seat({ "stock": { "food": 1000, "stone": 200, "metal": 200 } });
		const { civicCentre } = trainerTown(world);
		assert.ok(civicCentre);
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b",
			{
				"classes": ["Unit", "Infantry"], "cost": { "stone": 20 }, "walkSpeed": 9.5
			});
		civicCentre.resourceDropsiteTypes = () => ["food", "wood", "stone", "metal"];
		// two stone mines of 300 next to the civic centre; the ledger loop
		// is the storehouse test's (it walks assignResourceToDropsite)
		world.addEntity(makeGaiaSupply({ "id": 2, "position": [140, 100],
			"generic": "stone", "specific": "stone", "classes": ["Stone"], "amount": 300 }));
		world.addEntity(makeGaiaSupply({ "id": 3, "position": [146, 96],
			"generic": "stone", "specific": "stone", "classes": ["Stone"], "amount": 300 }));
		hq.updateTerritories(world.gameState);
		hq.basesManager.baseManagers[0].assignResourceToDropsite(world.gameState,
			civicCentre as never);

		const best = hq.findBestTrainableUnit(world.gameState, ["Unit"],
			[["costsResource", 1, "food"]]);

		assert.equal(best, "units/athen/infantry_spearman_b");
	});

	it("an unexpected parameter token is logged and refused, not crashed", () =>
	{
		// the requirement lists are data the callers build; a token the
		// comparator does not carry must refuse the sweep (the value stays
		// at its base) and log the surprise instead of throwing
		const { world, hq } = seat();
		trainerTown(world);
		// unequal bills so the compared order stays deterministic
		world.templates["units/athen/infantry_spearman_b"] = makeTemplate("units/athen/infantry_spearman_b",
			{
				"classes": ["Unit", "Human", "CitizenSoldier", "Soldier", "Infantry",
					"Melee", "Worker", "Citizen"],
				"cost": { "food": 50, "wood": 30 }, "walkSpeed": 9.5,
				"getPaths": { "Cost": { "Population": 1 } }
			});

		resetRecorder();
		const best = hq.findBestTrainableUnit(world.gameState,
			[["CitizenSoldier", "Infantry"]], [["magnetism", 1]]);

		assert.ok(logs.some((entry) => /trainMoreUnits avec non prevu/.test(entry)),
			"the unexpected parameter was logged");
		// both cards read the same 0.1 base, so the cheaper bill leads
		assert.equal(best, "units/athen/infantry_spearman_b");
	});
});
