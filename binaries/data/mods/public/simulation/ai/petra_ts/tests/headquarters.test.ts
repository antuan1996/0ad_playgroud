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

// the two constants the emergency suite reads off the modules
const { GarrisonManager } = await loadPetraModule<{ GarrisonManager: { TYPE_PROTECTION: string } }>("garrisonManager");
const { Worker } = await loadPetraModule<{ Worker: { ROLE_WORKER: string } }>("worker");

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

/** The templates of this campaign carry the game's own sizes, so the
 * obstruction radii, the half sizes and the territory lists are the real
 * engine's numbers: the civic centre digs a 32x32 footprint over a 30x30
 * static obstruction (radius max 21.2, min 15), the market a 33x29 footprint
 * (max 21.96, min 13) and a Town trader card, the fortress 30x30 and the
 * stone tower 13x13. Every footprint walk needs the "@"-prefixed attribute
 * leaves the template walk reads, otherwise halfSize turns NaN and silently
 * disables the enemy-fire checks. */
const ccTemplate = () => structureTemplate("structures/athen/civil_centre", {
	"classes": ["Structure", "CivCentre"],
	"territories": ["own", "neutral"],
	"getPaths": { "Footprint": { "Square": { "@width": 32, "@depth": 32 } } },
	"obstruction": { "min": 15, "max": 21.2 }
});
const marketTemplate = () => structureTemplate("structures/athen/market", {
	"classes": ["Structure", "Trade", "Town", "Market"],
	"getPaths": { "Footprint": { "Square": { "@width": 33, "@depth": 29 } } },
	"obstruction": { "min": 13, "max": 21.96 }
});
const fortressTemplate = () => structureTemplate("structures/athen/fortress", {
	"classes": ["Structure", "Fortress", "Defensive"],
	"getPaths": { "Footprint": { "Square": { "@width": 30, "@depth": 30 } } },
	"obstruction": { "min": 15, "max": 21.2 }
});
const towerTemplate = () => structureTemplate("structures/athen/defense_tower", {
	"classes": ["Structure", "Tower", "Defensive"],
	"getPaths": { "Footprint": { "Square": { "@width": 13, "@depth": 13 } } },
	"obstruction": { "min": 6, "max": 9.2 }
});

/** the ally trade cards: getTraderTemplatesGains only quotes a gain when the
 * trader templates exist (a real game always has them, so a market suite that
 * wants a counted route must seat the two cards). */
function seatTraders(world: HqWorld): void
{
	world.templates["units/{civ}/support_trader"] = makeTemplate("units/{civ}/support_trader",
		{ "classes": ["Unit", "Support", "Trader"] });
	world.templates["units/{civ}/ship_merchant"] = makeTemplate("units/{civ}/ship_merchant",
		{ "classes": ["Unit", "Ship", "Trader"] });
}

describe("findStrategicCCLocation: the ground the next town claims", () =>
{
	// parity: on an empty search both implementations answer just `undefined`
	// (the port used to answer the bogus position [-1, -1], which the caller's
	// truthiness check at queueplanBuilding.ts:165 consumed as a real position;
	// fixed to mirror petra/headquarters.js, which returns undefined)
	it("ends without a claim when no ground can be reached", () =>
	{
		const { world, hq } = seat();
		// the board is settled: a second allied town takes the far corner and
		// every territory cell stayed ours, so no gaia ground is left to claim
		world.addEntity(makeHqEntity({
			"id": 2100, "owner": PLAYER, "position": [308, 308],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));

		const result = hq.findStrategicCCLocation(world.gameState, ccTemplate());
		assert.equal(result, undefined, "no position is claimed");
		// and the transport question was never asked of a positionless base
		assert.ok(!hq.navalManagerCalls.some(([call]: [string, unknown[]]) =>
			call === "setMinimalTransportShips"),
			"no ships were budgeted for a positionless base");
	});

	it("a border town rises between two allied towns", () =>
	{
		// two scraps of unclaimed ground across the border line the towns
		// straddle; the geometry (map 320 wide, both towns 298 apart) makes the
		// north-west scrap the nearest-to-both legal claim
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) =>
				(ix === 7 && iy === 32) || (ix === 33 && iy === 32) ? 0 : PLAYER
		});
		world.addEntity(makeHqEntity({
			"id": 2100, "owner": PLAYER, "position": [308, 308],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));

		assert.deepEqual(hq.findStrategicCCLocation(world.gameState, ccTemplate()), [57, 257],
			"the claim sits on the diagonal between the towns");
	});

	it("with one allied town the search becomes an economic one", () =>
	{
		// the single unclaimed lot sits 240+ units from the town: far enough to
		// lose the ally-favouring term, so plain economics would refuse it at
		// cut 60 - but a strategic expansion settles for cut 30
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => ix === 24 && iy === 20 ? 0 : PLAYER
		});

		// the plain economics call answers the ground not worth a town (cut 60)
		assert.equal(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			false, "a town for its own sake is too dear there");
		// the strategic call delegates with the cheaper cut and takes the lot
		assert.deepEqual(hq.findStrategicCCLocation(world.gameState, ccTemplate()), [193, 161],
			"expansion settles for the lot plain economics refused");
	});
});

describe("findEconomicCCLocation: where the next village feeds", () =>
{
	it("the first settlement rises next to the launch party", () =>
	{
		// every cell of the board is unclaimed and the launch party stands at
		// [100,100]: the proximity term dominates the flat resource sheets, so
		// the village plants beside the party rather than in the far country
		const { world, hq } = seat({ "territoryOwner": () => 0 });

		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", [100, 100], false),
			[97, 97], "the first act of founding likes company");
	});

	it("the river bends the choice to the east bank", () =>
	{
		// a north-south river (passibility band 44..59) separates the west bank,
		// where the launch party camps, from open country: the cc's clearance
		// radius (21.2 + 8 proximity = 15 cells) keeps the party clear of the
		// water and the first buildable ground past the current ...
		const { world, hq } = seat({ "territoryOwner": () => 0 });
		for (let pz = 0; pz < 160; ++pz)
			for (let px = 44; px <= 59; ++px)
				world.map.setPassData(px, pz, 0xB);

		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", [72, 72], false),
			[151, 81], "the settlement stays on the water's edge");
	});

	it("no town grows in the yard of a storehouse", () =>
	{
		// two unclaimed scraps: one next to the storehouse at [196,148], one
		// across the estate. Dropsites keep their working-yard radius of 80
		// (and ban their own 60); near the storehouse the lot loses half its
		// sheet and beyond 60 units the second lot stands
		const gaia = new Set([24 + 20 * 40, 29 + 29 * 40]);
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER
		});
		world.addEntity(makeHqEntity({
			"id": 606, "owner": PLAYER, "position": [196, 148],
			"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
		}, {
			"resourceDropsiteTypes": () => ["wood"],
			"isResourceDropsite": (resource: string) =>
				resource === undefined || resource === "" || resource === "wood"
		}));

		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			[233, 233], "the yard is kept for the carts");
	});

	it("between two free lots the richer wood decides", () =>
	{
		// two unclaimed lots equal in every other respect; the wood sheet of
		// (29,29) is lifted to 60 (the denser stand behind the hill) and the
		// val formula 2*wood + wood + stone + metal reads the richer valley
		const gaia = new Set([29 + 15 * 40, 29 + 29 * 40]);
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER
		});
		world.map.ccResourceMaps.wood.map[29 + 29 * 40] = 60;
		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			[233, 233], "the denser stand pulls the village");
		// and the sheet moved south, the village follows the wood
		world.map.ccResourceMaps.wood.map[29 + 29 * 40] = 40;
		world.map.ccResourceMaps.wood.map[29 + 15 * 40] = 60;
		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			[233, 121], "the sheet moved, the village moved");
	});

	it("a raiding army pushes the new town across the map", () =>
	{
		// two unclaimed lots, one of which the raiding party camps on: the
		// invading-army term (12000 = 110 units) strikes the west lot and the
		// village plants on the far side
		const gaia = new Set([15 + 28 * 40, 29 + 28 * 40]);
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER
		});
		hq.defenseManager.armies.push({ "foePosition": [124, 228] } as never);

		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			[233, 225], "the village plants beyond the raid");
	});

	it("towns are not built under an enemy tower's fire", () =>
	{
		// the enemy stone tower at [124,228] shoots 60; with the cc's half size
		// (16) the danger band is 76 around the tower, so the west lot burns
		// and the east lot stands
		const gaia = new Set([15 + 28 * 40, 29 + 28 * 40]);
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => gaia.has(ix + iy * 40) ? 0 : PLAYER
		});
		world.addEntity(makeHqEntity({
			id: 2200, "owner": ENEMY, "position": [124, 228],
			"classes": ["Structure", "Tower"],
		}, {
			"hasDefensiveFire": () => true,
			"attackRange": (type: string) => type === "Ranged" ? { "min": 0, "max": 60 } : undefined
		}));

		assert.deepEqual(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			[233, 225], "the village keeps out of range");
	});

	it("ground too far from every town is refused", () =>
	{
		// only the far-border corner stayed unclaimed: 260+ units from town
		// (the disfavour band halves the sheet) and inside the map's border
		// ring (another half) drops the sheet under the 60 cut
		const { world, hq } = seat({
			"territoryOwner": (ix: number, iy: number) => ix >= 35 && iy >= 35 ? 0 : PLAYER
		});

		assert.equal(hq.findEconomicCCLocation(world.gameState, ccTemplate(), "wood", undefined, false),
			false, "a town that far out never pays");
		// (the oversea arm needs distances beyond 500, which a 320-wide board
		// cannot produce, so its lift is not exercisable on this harness)
	});
});

describe("findMarketLocation: where the trade route settles", () =>
{
	it("the first market is left to the construction plan", () =>
	{
		const { world, hq } = seat({ "territoryOwner": () => PLAYER });

		assert.deepEqual(hq.findMarketLocation(world.gameState, marketTemplate()),
			[-1, -1, -1, 0], "no partner, no geometry - the plan places it");
	});

	it("the second market opens the route as far from its partner as it can", () =>
	{
		// the town and its market stand at [244,76]; the trade cards are seated
		// because a real game always trades and the route values gain*distSq {
		const { world, hq } = seat({ "territoryOwner": () => PLAYER });
		seatTraders(world);
		world.addEntity(makeHqEntity({
			"id": 3000, "owner": PLAYER, "position": [244, 76],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market"
		}));
		hq.updateTerritories(world.gameState);

		const result = hq.findMarketLocation(world.gameState, marketTemplate()) as [number, number, number, number];
		assert.deepEqual(result, [23, 297, 2, 56310],
			"the new market clings to the far south-west corner");
		// the trade record is booked under the town's base; base ids start at
		// 2 because the anchorless manager consumes id 1 at territory time
		assert.equal(result[2], 2);
	});

	// artificial fixture: minimalGain is raised to 10^9 so the route could
	// never pay; in a real game the same refusal reads tradeManager's cut
	it("a second market the route cannot pay for is refused", () =>
	{
		const { world, hq } = seat({ "territoryOwner": () => PLAYER });
		seatTraders(world);
		world.addEntity(makeHqEntity({
			"id": 3000, "owner": PLAYER, "position": [244, 76],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market"
		}));
		hq.updateTerritories(world.gameState);
		hq.tradeManager.minimalGain = 10 ** 9;

		assert.equal(hq.findMarketLocation(world.gameState, marketTemplate()), false,
			"the route is too poor, and one market already stands");
	});

	// a mod scenario: Resources.GetTradableCodes answers [] when the
	// tradable property is stripped, which no vanilla data does
	it("with nothing tradable the route stops with mods", () =>
	{
		const { world, hq } = seat({ "territoryOwner": () => PLAYER });
		// the partner market belongs to the neighbouring empire, whose market
		// makes the trade arithmetic certain but never our own
		world.addEntity(makeHqEntity({
			"id": 3001, "owner": ENEMY, "position": [100, 200],
			"classes": ["Structure", "Trade", "Town", "Market"],
			"templateName": "structures/athen/market"
		}));
		(world.gameState.playerData as unknown as Record<string, boolean[]>).isMutualAlly[ENEMY] = true;
		const engine = globalThis as Record<string, unknown>;
		const realCodes = (engine.Resources as { GetTradableCodes: () => string[] }).GetTradableCodes;
		(engine.Resources as { GetTradableCodes: () => string[] }).GetTradableCodes = () => [];
		try
		{
			assert.equal(hq.findMarketLocation(world.gameState, marketTemplate()), false,
				"no tradable goods, no second route");
		}
		finally
		{
			(engine.Resources as { GetTradableCodes: () => string[] }).GetTradableCodes = realCodes;
		}
	});
});

describe("findDefensiveLocation: where the walls face", () =>
{
	/** the enemy's town over the southern march; the enemy strip keeps
	 * territory rows 26+ so frontier rows 16..25 carry narrow (20..25) and
	 * large (16..19) frontier bits alike */
	function seatMarch(worldOptions: Partial<HqWorldOptions> = {})
	{
		const seatOut = seat({
			"territoryOwner": (ix: number, iy: number) => iy >= 26 ? ENEMY : PLAYER,
			...worldOptions
		});
		seatOut.hq.updateTerritories(seatOut.world.gameState);
		return seatOut;
	}
	const enemyTown = (world: HqWorld, pos: [number, number] = [204, 220]) =>
		world.addEntity(makeHqEntity({
			"id": 4000, "owner": ENEMY, "position": pos,
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));

	it("fortress and tower brace the frontier nearest the foe's town", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);

		// cell (33,21) is the frontier cell nearest the enemy town and 80 units
		// from it (the not-under-80 rule's exact boundary is allowed)
		assert.deepEqual(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			[265, 169, 2], "the fortress presses the frontier");
		assert.deepEqual(hq.findDefensiveLocation(world.gameState, towerTemplate()),
			[265, 169, 2],
			// row 21 is narrow, so the tower's large-frontier exclusion never
			// bites and the stone tower takes the same post
			"the tower takes the same post");
	});

	it("a fort in the way turns the walls to the far side", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);
		world.addEntity(makeHqEntity({
			id: 4050, "owner": PLAYER, "position": [265, 169],
			"classes": ["Structure", "Fortress", "Defensive"],
			"templateName": "structures/athen/fortress"
		}));

		assert.deepEqual(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			[137, 169, 2], "the walls spread out to the mirror post");
	});

	it("walls stand out of the enemy tower's reach", () =>
	{
		const { world, hq } = seatMarch();
		enemyTown(world);
		// the enemy tower by its town shoots 120; with the fortress half size
		// (15) the danger band is 135, so the nearest posts fall inside and
		// the walls retreat past 135
		world.addEntity(makeHqEntity({
			id: 4100, "owner": ENEMY, "position": [268, 172],
			"classes": ["Structure", "Tower"],
		}, {
			"hasDefensiveFire": () => true,
			"attackRange": (type: string) => type === "Ranged" ? { "min": 0, "max": 120 } : undefined
		}));

		assert.deepEqual(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			[129, 177, 2], "the walls stand clear of the fire");
	});

	it("at peace everywhere the walls wait — except facing a neutral", () =>
	{
		const { world, hq } = seatMarch();
		// nobody is an enemy yet: no wall is worth raising
		assert.equal(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			undefined, "no walls against everyone");
		// ... unless a third empire is met but not war-declared — we may be in
		// cease fire, and Petra still braces toward the neutral town
		enemyTown(world);
		(world.gameState.playerData as unknown as Record<string, boolean[]>).isEnemy[ENEMY] = false;
		(world.gameState.playerData as unknown as Record<string, boolean[]>).isNeutral[ENEMY] = true;
		assert.deepEqual(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			[265, 169, 2], "the walls face the neutral town all the same");
	});

	it("a rising wonder draws the fortifications", () =>
	{
		// the wonder victor builds its forts around the wonder, not the frontier
		const { world, hq } = seatMarch({ "victoryConditions": ["wonder"] });
		enemyTown(world, [20, 300]);
		world.addEntity(makeHqEntity({
			id: 5000, "owner": PLAYER, "position": [160, 160],
			"classes": ["Structure", "Wonder"],
		}, { "footprintRadius": () => 22.6 }));

		assert.deepEqual(hq.findDefensiveLocation(world.gameState, fortressTemplate()),
			[89, 129, 2], "the fort guards the wonder first");
		// (the wonder-without-position arm the port guards differently is a
		// resiliency note, not a counted deviation: the ref would crash on the
		// missing position, the port skips the cell)
	});
});

describe("canBuild: which stones the office will book", () =>
{
	// the questions canBuild answers in the order it asks them: the parked
	// holds of the buildManager, the disabled-template list the game ships per
	// civ, the engine's template store, the template's own requirements, the
	// builders on the payroll, the room a baseless board has for gaia
	// ground, and the census the EntityLimits keep

	/** the house the canBuild matrix books: the game's own EntityLimits
	 * category and the template's inherited own-only territory */
	const houseTemplate = (overrides: {
		available?: boolean;
	} = {}) => structureTemplate("structures/athen/house", {
		"classes": ["Structure", "House", "Economic", "City"],
		"buildCategory": "House",
		...overrides
	});

	/** a support builder on the payroll: one unit whose Builder/Entities
	 * template names the structures it can raise, {civ} expanded as the
	 * common-api does before the office sees the list */
	function seatBuilder(world: HqWorld, buildables: string[]): void
	{
		world.addEntity(makeHqEntity({
			"id": 2201, "owner": PLAYER, "position": [151, 151],
			"classes": ["Unit", "Support", "Worker"]
		}, {
			buildableEntities: (civ: string) => buildables.map(name => name.replace("{civ}", civ))
		}));
	}

	it("a house rises where a builder stands and the census allows", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), true);
		assert.equal(hq.buildManager.unbuildables.size, 0,
			"a buildable template parks nothing");
	});

	it("the census caps the town at its counted houses and parks the attempt", () =>
	{
		const { world, hq } = seat({ "entityLimits": { "House": 5 }, "entityCounts": { "House": 5 } });
		world.templates["structures/athen/house"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);
		assert.deepEqual(
			[...hq.buildManager.unbuildables.entries()],
			[["structures/athen/house", { "reason": "limit", "time": 190 }]],
			"a capped build parks for the default 90 seconds from the turn's time");
	});

	it("one room short of the census cap the office still books", () =>
	{
		const { world, hq } = seat({ "entityLimits": { "House": 5 }, "entityCounts": { "House": 4 } });
		world.templates["structures/athen/house"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), true);
	});

	it("a category the census does not count is capped by nobody", () =>
	{
		const { world, hq } = seat({ "entityCounts": { "House": 99 } });
		world.templates["structures/athen/house"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), true,
			"no limit row for the category means the count is ignored");
	});

	it("a template the game disabled per civ parks forever", () =>
	{
		const { world, hq } = seat({ "disabledTemplates": ["structures/athen/storehouse"] });
		world.templates["structures/athen/storehouse"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/storehouse"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/storehouse"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/storehouse"),
			{ "reason": "disabled", "time": Infinity });
	});

	it("a template name disabled without a template still parks as disabled", () =>
	{
		// the disabled check runs ahead of the template store: the game ships
		// the disabled list per civ, and Petra trusts it before ever asking
		// the store
		const { world, hq } = seat({ "disabledTemplates": ["structures/athen/dock"] });
		world.templates["structures/athen/house"] = houseTemplate();

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/dock"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/dock"),
			{ "reason": "disabled", "time": Infinity },
			"a `notemplate` row would mean the disabled list was consulted second");
	});

	it("a template the engine never shipped parks forever", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate();

		assert.equal(hq.canBuild(world.gameState, "structures/athen/missing"), false
			, "no template in the store, no stone to book under it");
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/missing"),
			{ "reason": "notemplate", "time": Infinity });
	});

	it("a template whose requirements are unmet parks one season", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate({ "available": false });
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/house"),
			{ "reason": "requirements", "time": 130 }, "requirements park for 30 seconds");
	});

	it("nobody on the payroll to raise it parks for two seasons", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate();

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/house"),
			{ "reason": "nobuilder", "time": 220 }, "no builder parks for 120 seconds");
	});

	it("the hold answers on the cache long after the site changed hands", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate();

		// the first ask parks the house: no builder stood on the payroll
		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);

		// the season rolls on and a builder walks in with the template in hand
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);
		world.ai.elapsedTime = 150;
		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false,
			"hold is on for 120 seconds, and the office trusts it");

		// past the hold the office asks the site again — and now books
		world.ai.elapsedTime = 221;
		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), true,
			"the reopened ask re-walks the checks from the top");
	});

	it("the refused call answers the first refusal in ask order", () =>
	{
		// the ask order is the same as the branches: a template whose own
		// requirements refuse parks first even when the census is full
		const { world, hq } = seat({ "entityLimits": { "House": 5 }, "entityCounts": { "House": 5 } });
		world.templates["structures/athen/house"] = houseTemplate({ "available": false });

		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/house"),
			{ "reason": "requirements", "time": 130 }, "requirements before the census");
	});

	it("a townless board cannot book a house in gaia ground", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/house"] = houseTemplate();
		seatBuilder(world, ["structures/{civ}/house"]);
		hq.buildManager.init(world.gameState);
		// the town's civic centre still standing: a foundation is a potential
		// base, not a working one (the territory board answers all the same,
		// so the territorial walk in the office hears identical rows)
		(world.ents.get(1000) as unknown as { foundationProgress(): number | undefined }).foundationProgress =
			() => 0;
		hq.basesManager.resetBaseCache();

		assert.equal(hq.hasActiveBase(), false);
		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/house"), false);
		assert.deepEqual(hq.buildManager.unbuildables.get("structures/athen/house"),
			{ "reason": "room", "time": 280 }, "own-only territory parks for 180 seconds");
	});

	it("a townless board books beyond own ground where its charter reaches", () =>
	{
		const { world, hq } = seat();
		world.templates["structures/athen/civil_centre"] = ccTemplate();
		seatBuilder(world, ["structures/{civ}/civil_centre"]);
		hq.buildManager.init(world.gameState);
		(world.ents.get(1000) as unknown as { foundationProgress(): number | undefined }).foundationProgress =
			() => 0;
		hq.basesManager.resetBaseCache();

		assert.equal(hq.hasActiveBase(), false);
		assert.equal(hq.canBuild(world.gameState, "structures/{civ}/civil_centre"), true,
			"the civ centre plants outside mere rows: neutral ground answers its charter");
	});
});

describe("findBestBaseForMilitary: where the army stands", () =>
{
	/** one of our towns: an own civ centre carrying the roster id of its base */
	function ownTown(world: HqWorld, id: number, position: [number, number], baseId: number): void
	{
		world.addEntity(makeHqEntity({
			id, "owner": PLAYER, position,
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "base": baseId }));
	}

	/** a hostile town on the plain */
	function enemyTownAt(world: HqWorld, id: number, position: [number, number]): void
	{
		world.addEntity(makeHqEntity({
			id, "owner": ENEMY, position,
			"classes": ["Structure", "CivCentre"], "templateName": "structures/spart/civil_centre"
		}));
	}

	it("the town closest to the hostile one keeps the first call", () =>
	{
		// no base seating: the raw CC walk is all the function reads; the roster
		// numbers wear the campaign's own base ids, starting at 2
		const { world, hq } = seat({}, { "seatBases": false });
		ownTown(world, 1102, [105, 200], 2);
		ownTown(world, 1103, [155, 200], 3);
		enemyTownAt(world, 2202, [200, 200]);

		assert.equal(hq.findBestBaseForMilitary(world.gameState), 3);
	});

	it("a quiet board: with no hostile town in the walk, no post is named", () =>
	{
		// the walk hunts for the town our army should stand near, and the
		// garrison of a player counts as its own ally in the outer round:
		// our towns alone leave no target, and the call goes unanswered
		const { world, hq } = seat({}, { "seatBases": false });
		ownTown(world, 1102, [80, 80], 2);
		ownTown(world, 1103, [240, 240], 3);

		assert.equal(hq.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("an allied town stands in the walk but never carries the answer", () =>
	{
		// the ally lies inside the collection but skips the target round; the
		// own town beside it counts as its own ally all the same
		const { world, hq } = seat({}, { "seatBases": false });
		ownTown(world, 1102, [80, 80], 2);
		world.addEntity(makeHqEntity({
			"id": 1104, "owner": GAIA + 1, "position": [90, 80],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/other/civil_centre"
		}));

		assert.equal(hq.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("a foe across the water raises no sound of the drum here", () =>
	{
		// the foe's town across the sea sits in an untouched land region,
		// getAccessValue answers 9 — no booked road, no post
		const { world, hq } = seat({}, { "seatBases": false });
		world.accessAt.set("200,200", 9);
		ownTown(world, 1102, [80, 80], 2);
		enemyTownAt(world, 2202, [200, 200]);

		assert.equal(hq.findBestBaseForMilitary(world.gameState), undefined);
	});

	it("a second foe numbers closer and revises the call", () =>
	{
		// the first foe at the east walls books the town near it; the second
		// foe in the far field lands nearer the other town and moves the post
		const { world, hq } = seat({}, { "seatBases": false });
		enemyTownAt(world, 2202, [300, 300]);
		ownTown(world, 1102, [260, 300], 2);
		ownTown(world, 1103, [180, 180], 3);
		enemyTownAt(world, 2203, [200, 200]);

		assert.equal(hq.findBestBaseForMilitary(world.gameState), 3);
	});
});

describe("trainEmergencyUnits: the last call for the wall", () =>
{
	/** the town's training cards, keyed by the template name the anchor lists */
	function seatCards(world: HqWorld): void
	{
		world.templates["units/athen/infantry_spearman"] = makeTemplate("units/athen/infantry_spearman",
			{
				"classes": ["Unit", "Infantry", "Melee", "CitizenSoldier"],
				"getPaths": { "Cost": { "Population": 1 } },
				"cost": { "food": 100 }
			});
		world.templates["units/athen/infantry_archer"] = makeTemplate("units/athen/infantry_archer",
			{
				"classes": ["Unit", "Infantry", "Ranged", "Archer", "CitizenSoldier"],
				"getPaths": { "Cost": { "Population": 1 } },
				"cost": { "wood": 100 }
			});
	}

	/** the base anchor dressed for the alarm: both queue views (the entity
	 * method the port's first pass reads and the raw sim view the counting
	 * step reads on both implementations), the card list, and the wall's
	 * garrison answers */
	function emergencyAnchor(hq: HqInstance, world: HqWorld, options: {
		trainables?: string[];
		queue?: Array<Record<string, unknown>> | undefined;
		garrisonMax?: number;
		arrowClasses?: string[];
		ejectedHealth?: number;
	} = {})
	{
		const anchor = hq.baseManagers()[0].anchor as FakeEnt & Record<string, any>;
		anchor.trainableEntities = () => options.trainables ?? [];
		anchor.trainingQueue = () => options.queue ?? false;
		(anchor as unknown as Record<string, unknown>)._entity =
			{ "trainingQueue": options.queue ?? undefined };
		if (options.garrisonMax !== undefined)
			anchor.garrisonMax = () => options.garrisonMax;
		if (options.arrowClasses !== undefined)
			anchor.getGarrisonArrowClasses = () => options.arrowClasses;
		if (options.ejectedHealth !== undefined)
			anchor.garrisonEjectHealth = () => options.ejectedHealth;
		return anchor;
	}

	/** the emergency account book after the call, peeked at its one resource */
	function accountOf(world: HqWorld, queue: string): number
	{
		return (world.ai.queueManager as unknown as
			{ accounts: Record<string, Record<string, number>> }).accounts[queue].food;
	}

	it("the call books a melee batch at the empty house straight away", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		// the wall has no garrison room at the default book: 0 max slots means
		// the melee card wins the ranged roll whatever the coin says
		stubGlobal("randBool", () => true);
		try
		{
			const anchor = emergencyAnchor(hq, world, {
				"trainables": ["units/athen/infantry_spearman", "units/athen/infantry_archer"]
			});

			assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);

			const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
			assert.equal(queue.plans.length, 1);
			const plan = queue.plans[0] as { type?: string; number?: number; metadata?: Record<string, unknown> };
			assert.equal(plan.type, "units/athen/infantry_spearman");
			assert.equal(plan.number, 1);
			assert.equal(plan.metadata?.trainer, anchor.id());

			assert.equal(accountOf(world, "emergency"), 100,
				"the cost was booked against the emergency account from the town's available stock");
		}
		finally
		{
			restoreEngine();
		}
	});

	it("so long as the emergency queue still holds the batch, no second book", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		emergencyAnchor(hq, world, { "trainables": ["units/athen/infantry_spearman"] });
		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), false,
			"the queue's own batch is the answer while it lasts");
		const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans.length, 1, "the second call books nothing");
	});

	it("a victim beyond the rescue cut is nobody's", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500 } });
		seatCards(world, hq);
		emergencyAnchor(hq, world, { "trainables": ["units/athen/infantry_spearman"] });

		// 390 cells out in both axes: ~304,200 square distance over the cut
		assert.equal(hq.trainEmergencyUnits(world.gameState, [[400, 400]]), false,
			"the town's guard cannot reach to respond in time");
	});

	it("no road on the victim's land — the office holds", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500 } });
		seatCards(world, hq);
		emergencyAnchor(hq, world, { "trainables": ["units/athen/infantry_spearman"] });
		world.accessAt.set("60,60", 9);

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[60, 60]]), false,
			"the anchor on land 2 cannot reach the calls from land 9");
	});

	it("a training house already brimming skips the call", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500 } });
		seatCards(world, hq);
		emergencyAnchor(hq, world, {
			"trainables": ["units/athen/infantry_spearman"],
			// 6 s of queued production, half under way, reads as a house at
			// work: only batches in progress or bound for the wall count the
			// wait, so this batch is what the clock looks at
			"queue": [{ "metadata": {}, "progress": 0.5, "id": 1, "timeRemaining": 6000 }]
		});

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), false,
			"the only anchor is occupied at its queue");
	});

	it("the wall's garrison book counts batches, and the lone fill makes the call ranged", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500, "wood": 500 } });
		seatCards(world, hq);
		const anchor = emergencyAnchor(hq, world, {
			"trainables": ["units/athen/infantry_spearman", "units/athen/infantry_archer"],
			"queue": [
				{ "metadata": { "garrisonType": "Tower" }, "count": 3, "progress": 0.2, "timeRemaining": 2000 },
				{ "id": 5, "metadata": {}, "progress": 0, "timeRemaining": 1000 }
			],
			"garrisonMax": 10,
			"arrowClasses": ["Archer"],
			"ejectedHealth": 0.5
		});
		const stops: number[] = [];
		anchor.stopProduction = (id: number) => { stops.push(id); return true; };
		stubGlobal("randBool", () => true);
		try
		{
			assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);

			// the quiet drain from the batches: 3 in the wall's book, and the
			// idle fill with no trainer attached is pulled from the queue
			assert.deepEqual(stops, [5]);
			const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
			const plan = queue.plans[0] as { type?: unknown; metadata?: Record<string, unknown> };
			assert.equal(plan.type, "units/athen/infantry_archer",
				"room in the wall means the ranged roll goes through");
			assert.equal(plan.metadata?.garrisonType, GarrisonManager.TYPE_PROTECTION);
			assert.equal(plan.metadata?.role, Worker.ROLE_WORKER);
		}
		finally
		{
			restoreEngine();
		}
	});

	it("a wounded wall keeps the melee hand even on the ranged roll", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500 } });
		seatCards(world, hq);
		// 40 hitpoints against the 50 eject floor: no room for arrows
		const anchor = emergencyAnchor(hq, world, {
			"trainables": ["units/athen/infantry_spearman", "units/athen/infantry_archer"],
			"garrisonMax": 10,
			"ejectedHealth": 0.5
		});
		(anchor as unknown as { hitpoints: () => number }).hitpoints = () => 40;
		stubGlobal("randBool", () => true);
		try
		{
			assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);

			const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
			const plan = queue.plans[0] as { type?: unknown; metadata?: Record<string, unknown> };
			assert.equal(plan.type, "units/athen/infantry_spearman");
			assert.equal(plan.metadata?.garrisonType, undefined,
				"a wall with no room for men takes plain trash troops");
		}
		finally
		{
			restoreEngine();
		}
	});

	it("an empty treasury calls the house off", () =>
	{
		const { world, hq } = seat();
		seatCards(world, hq);
		emergencyAnchor(hq, world, { "trainables": ["units/athen/infantry_spearman"] });

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), false);
		const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans.length, 0, "no card was affordable, nothing booked");
	});

	it("the disabled card is passed over and its teammate wins the call", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 500, "wood": 500 }, "disabledTemplates": ["units/athen/infantry_spearman"] });
		seatCards(world, hq);
		emergencyAnchor(hq, world, {
			"trainables": ["units/athen/infantry_spearman", "units/athen/infantry_archer"]
		});

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);
		const queue = world.ai.queues.emergency as unknown as { plans: Array<Record<string, unknown>> };
		const plan = queue.plans[0] as { type?: unknown };
		assert.equal(plan.type, "units/athen/infantry_archer",
			"the prohibition leaves the ranged answer standing in the melee roll");
	});

	it("when the emergency account falls short, the neighbour queue lends", () =>
	{
		const { world, hq } = seat({ "stock": { "food": 150 } });
		seatCards(world, hq);
		emergencyAnchor(hq, world, { "trainables": ["units/athen/infantry_spearman"] });
		// the villager queue held an account from a previous turn's distribution
		(world.ai.queueManager as unknown as
			{ accounts: Record<string, Record<string, number>> }).accounts.villager.food = 100;

		assert.equal(hq.trainEmergencyUnits(world.gameState, [[50, 50]]), true);

		// the shortfall 50 came over the villager account, and the batch books
		assert.equal(accountOf(world, "emergency"), 100);
		assert.equal(accountOf(world, "villager"), 50);
	});
});

describe("the headcount and the workforce: the queues' living tally", () =>
{
	/** a training house: an own structure whose queue carries a batch */
	function trainingHouse(world: HqWorld, id: number, items: Array<Record<string, unknown>>): void
	{
		world.addEntity(makeHqEntity({
			id, "owner": PLAYER, "position": centerOfCell(30, 30),
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, { "trainingQueue": () => items }));
	}

	it("the queued batches join their population to the town's headcount", () =>
	{
		const { world, hq } = seat({ "population": 10 });
		world.templates["units/athen/infantry_spearman"] = makeTemplate("units/athen/infantry_spearman",
			{ "classes": ["Unit", "Infantry"], "getPaths": { "Cost": { "Population": 2 } } });
		trainingHouse(world, 1120, [{ "unitTemplate": "units/athen/infantry_spearman", "count": 3 }]);

		assert.equal(hq.getAccountedPopulation(world.gameState), 16,
			"10 townsfolk on the ground, plus a batch of 3 twos in the queue");
		// the count is sealed per turn: the same question answers the same
		assert.equal(hq.getAccountedPopulation(world.gameState), 16);
	});

	it("a batch without named unit cards is passed over in the tally", () =>
	{
		const { world, hq } = seat({ "population": 10 });
		trainingHouse(world, 1120, [{ "count": 5 }]);

		assert.equal(hq.getAccountedPopulation(world.gameState), 10);
	});

	it("a population card with no template leaf adds nothing", () =>
	{
		const { world, hq } = seat({ "population": 10 });
		world.templates["units/athen/infantry_spearman"] = makeTemplate("units/athen/infantry_spearman",
			{ "classes": ["Unit", "Infantry"] });
		trainingHouse(world, 1120, [{ "unitTemplate": "units/athen/infantry_spearman", "count": 3 }]);

		// Cost/Population absent: the leaf is undefined in the walk
		assert.equal(hq.getAccountedPopulation(world.gameState), 10);
	});

	it("the queued worker batches join the workforce rolls", () =>
	{
		const { world, hq } = seat();
		world.addEntity(makeHqEntity({
			"id": 1121, "owner": PLAYER, "position": [100, 100], "classes": ["Unit", "Worker"]
		}, {}, { "role": "worker" }));
		world.addEntity(makeHqEntity({
			"id": 1122, "owner": PLAYER, "position": [110, 100], "classes": ["Unit", "Soldier"]
		}));
		world.templates["units/athen/infantry_spearman"] = makeTemplate("units/athen/infantry_spearman",
			{ "classes": ["Unit", "Infantry"] });
		trainingHouse(world, 1120, [
			{ "unitTemplate": "units/athen/infantry_spearman", "count": 4, "metadata": { "role": "worker" } },
			{ "unitTemplate": "units/athen/infantry_archer", "count": 2, "metadata": { "role": "soldier" } }
		]);

		assert.equal(hq.getAccountedWorkers(world.gameState), 5,
			"one worker on the ground, and only the worker batch of four belongs");
	});
});

describe("the danger lights: what keeps the office from building under fire", () =>
{
	/** an enemy tower with the ranged book of a watchtower: max range given */
	function firingTower(world: HqWorld, id: number, position: [number, number], range = 80): FakeEnt
	{
		return world.addEntity(makeHqEntity({
			id, "owner": ENEMY, position,
			"classes": ["Structure", "Tower"], "templateName": "structures/spart/watchtower"
		}, {
			// the common-api's own read of a ranged attack with a default
			// arrow (entity.js hasDefensiveFire): the tower shoots
			"get": (path: string) => path === "Attack/Ranged" ? { "MaxRange": range } : undefined,
			"getDefaultArrow": () => 1,
			"hasDefensiveFire": () => true,
			"attackRange": () => ({ "max": range, "min": 0 })
		}));
	}

	it("an invading column keeps a field of ground where nothing may rise", () =>
	{
		const { hq } = seat();
		(hq.defenseManager as unknown as { armies: Array<Record<string, unknown>> }).armies = [
			// the column at its field camp east of the river
			{ "foePosition": [100, 100] },
			// an army of stragglers, no position to its name yet
			{ "foePosition": undefined }
		];

		assert.equal(hq.isNearInvadingArmy([160, 100]), true,
			"under 12 000 square units of the column, refuse the spot");
		assert.equal(hq.isNearInvadingArmy([400, 400]), false,
			"far enough from the camp to build");
		assert.equal(hq.isNearInvadingArmy([100, 100]), true,
			"the army's own ground is of course invaded");
	});

	it("an enemy tower's fire will not reach past its own range", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);

		assert.equal(hq.isUnderEnemyFire(world.gameState, [150, 100]), true,
			"50 squares out, inside the 80 of the tower");
		assert.equal(hq.isUnderEnemyFire(world.gameState, [250, 100]), false,
			"150 squares out, past the tower's reach");
	});

	it("the caller's own radius adds to the tower's reach", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);

		// the radius stands for the ground a to-be structure occupies
		assert.equal(hq.isUnderEnemyFire(world.gameState, [230, 100], 60), true,
			"the 140 of range and radius reaches the 130-square mark");
		assert.equal(hq.isUnderEnemyFire(world.gameState, [230, 100], 40), false,
			"the 120 of the pair does not reach the 130-square mark");
	});

	it("a dangerous ground either sees a column or stands inside a tower's fire", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);

		assert.equal(hq.isDangerousLocation(world.gameState, [250, 100], 0), false,
			"no column, no fire: the meadow is free");
		assert.equal(hq.isDangerousLocation(world.gameState, [150, 100], 0), true,
			"no column, but the tower's fire reaches it");
		(hq.defenseManager as unknown as { armies: Array<Record<string, unknown>> }).armies = [
			{ "foePosition": [340, 150] }
		];
		assert.equal(hq.isDangerousLocation(world.gameState, [250, 100], 0), true,
			"the column stands within reach of the field's edge");
	});

	it("the tower's book stays sealed for the whole turn", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);
		assert.equal(hq.isUnderEnemyFire(world.gameState, [150, 100]), true);

		// the tower demolished after the question: the turn's sealed book
		// still answers with what the map held when it was written
		world.ents.delete(2201);
		assert.equal(hq.isUnderEnemyFire(world.gameState, [150, 100]), true,
			"the same turn answers the same firing book");
	});
});

describe("the capture ledger: who may storm the tokens of ground", () =>
{
	// typing resiliency the port carries and the ref does not, all dead under
	// this filter's reality (canCapture() gates the Attack/Capture leaf that
	// captureStrength() reads, unitAIState is defined for any unit, and a
	// target in the ledger cannot vanish mid-walk): the missing-template and
	// undefined-strength guards here never flip an answer, so no test pins
	// them — the same convention every batch follows
	/** a capturable town building: the enemy civil centre over the hill */
	function captureTarget(world: HqWorld, opts: {
		id?: number;
		owner?: number;
		points?: number[];
		garrisoned?: FakeEnt[];
		decaying?: boolean;
		invulnerable?: boolean;
		defenseFire?: boolean;
	} = {}): FakeEnt
	{
		const target = world.addEntity(makeHqEntity({
			id: opts.id ?? 2601, "owner": opts.owner ?? ENEMY, "position": centerOfCell(50, 50),
			"classes": ["Structure", "CivCentre"], "templateName": "structures/spart/civil_centre"
		}, {
			"isCapturable": () => true,
			"capturePoints": () => opts.points ?? [1000],
			"healthLevel": () => 1,
			"defaultRegenRate": () => 0,
			"decaying": () => opts.decaying ?? false,
			"isInvulnerable": () => opts.invulnerable ?? false,
			"isGarrisonHolder": () => !!opts.garrisoned,
			// garrisoned() lists entity ids, as the engine's queue does
			"garrisoned": () => (opts.garrisoned ?? []).map((e) => e.id()),
			"garrisonRegenRate": () => opts.garrisoned ? 1 : 0,
			"hasDefensiveFire": () => opts.defenseFire ?? false
		}, { "base": 2 }));
		return target;
	}

	/** one of our capturers at grips with the target, or idling */
	function capturer(world: HqWorld, id: number, opts: {
		strength: number;
		bonus?: Record<string, Record<string, unknown>>;
		state?: string;
		orderData?: Array<Record<string, unknown>>;
	} = {}): FakeEnt
	{
		return world.addEntity(makeHqEntity({
			id, "owner": PLAYER, "position": [150, 150],
			"classes": ["Unit", "Infantry", "CitizenSoldier"],
			"templateName": "units/athen/infantry_spearman_b"
		}, {
			// the Attack/Capture leaf, with optional keyed Bonuses: the
			// bonus read walks the leaf again one step deeper
			"get": (path: string) =>
				path === "Attack/Capture" ? { "Capture": opts.strength, "Bonuses": opts.bonus } :
				path === "Attack/Capture/Bonuses" ? opts.bonus : undefined,
			// canCapture() without a target asks only for the Capture attack,
			// which the template leaf answers; the target passed later stands
			// for the restricted-classes read, unmodeled here
			"canCapture": () => true,
			"captureStrength": () => opts.strength,
			"unitAIState": () => opts.state ?? "INDIVIDUAL.COMBAT.ATTACKING",
			"unitAIOrderData": () => opts.orderData ?? [{ "target": 2601, "attackType": "Capture" }]
		}));
	}

	/** the ledger's entry for a target, peeked two ways */
	function ledger(hq: HqInstance, targetId: number):
		{ strength: number; ents: Set<number> } | undefined
	{
		return (hq as unknown as { capturableTargets: Map<number, { strength: number; ents: Set<number> }> })
			.capturableTargets.get(targetId);
	}

	it("a batch at grips with a capturable target is let to carry it by capture", () =>
	{
		const { world, hq } = seat();
		captureTarget(world);
		const unit = capturer(world, 2611, { "strength": 20 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// 20 capture strength against a thousand capture points: quietly out
		// of the running, so the order that stands needs no correction
		assert.deepEqual(ledger(hq, 2601), { "strength": 20, "ents": new Set([2611]) });
		assert.equal((hq as unknown as { capturableTargetsTime: number }).capturableTargetsTime, 100,
			"the ledger stamps the turn it was last raised");
		assert.deepEqual(commands, [],
			"the order already rides capture; nothing to correct");
	});

	it("a batch too thin outright becomes a plain assault", () =>
	{
		const { world, hq } = seat();
		captureTarget(world);
		const unit = capturer(world, 2611, { "strength": 10 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// ten against the 1000/80 = 12.5 floor: the capture cannot carry, and
		// the unit is ordered off capture to plain attack
		assert.deepEqual(commands, [[2601, false]]);
	});

	it("two thin batches together still make the capture count", () =>
	{
		const { world, hq } = seat();
		captureTarget(world);
		const first = capturer(world, 2611, { "strength": 8 });
		const second = capturer(world, 2612, { "strength": 9 });
		const commands: Array<[number, boolean]> = [];
		first.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };
		second.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		assert.deepEqual(ledger(hq, 2601), { "strength": 17, "ents": new Set([2611, 2612]) });
		assert.deepEqual(commands, [], "seventeen over the floor carries; no correction");
	});

	it("a class bonus weights the book the floor reads", () =>
	{
		const { world, hq } = seat();
		captureTarget(world);
		const unit = capturer(world, 2611, {
			"strength": 5,
			"bonus": { "siege": { "Classes": "Structure", "Multiplier": 2 } }
		});
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// five strength doubled against a structure: ten booked, under floor
		assert.deepEqual(ledger(hq, 2601), { "strength": 10, "ents": new Set([2611]) });
		assert.deepEqual(commands, [[2601, false]]);
	});

	it("the ledger only books units truly at grips with a target", () =>
	{
		const { world, hq } = seat();
		captureTarget(world, { "id": 2601 });
		// an idle capturer
		capturer(world, 2611, { "strength": 30, "state": "INDIVIDUAL.IDLE" });
		// a capturer with no order on record
		capturer(world, 2612, { "strength": 30, "orderData": [] });
		// a capturer aimed at ground nobody holds
		capturer(world, 2613, { "strength": 30, "orderData": [{ "target": 2699, "attackType": "Capture" }] });
		// a capturer whose order carries no target at all
		capturer(world, 2614, { "strength": 30, "orderData": [{ "attackType": "Capture" }] });

		hq.updateCaptureStrength(world.gameState);

		assert.equal(ledger(hq, 2601), undefined,
			"no unit among them faces the target in combat");
		assert.equal((hq as unknown as { capturableTargetsTime: number }).capturableTargetsTime, 100,
			"the walk still stamps its time even with an empty book");
	});

	it("a garrisoned wall buys time for its capture points", () =>
	{
		const { world, hq } = seat();
		// the wall's regen of 1 times the crew's 6 capture strength holds it
		const crew = world.addEntity(makeHqEntity({
			"id": 2701, "owner": ENEMY, "position": centerOfCell(50, 50),
			"classes": ["Unit", "Soldier"], "templateName": "units/spart/infantry_spearman_e"
		}, { "captureStrength": () => 6 }));
		captureTarget(world, { "garrisoned": [crew] });
		const unit = capturer(world, 2611, { "strength": 17 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// 17 falls under the 6 regen + 12.5 floor, so the capture is dropped
		assert.deepEqual(commands, [[2601, false]]);
	});

	it("a wall firing arrows demands a heavier batch still", () =>
	{
		const { world, hq } = seat();
		const crew = world.addEntity(makeHqEntity({
			"id": 2701, "owner": ENEMY, "position": centerOfCell(50, 50),
			"classes": ["Unit", "Soldier"], "templateName": "units/spart/infantry_spearman_e"
		}, { "captureStrength": () => 6 }));
		captureTarget(world, { "garrisoned": [crew], "defenseFire": true });
		const unit = capturer(world, 2611, { "strength": 25 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// firing walls halve the grace: 6 + 1000/50 = 26 over the 25
		assert.deepEqual(commands, [[2601, false]]);
	});

	it("ground held by an ally is taken back whatever the numbers", () =>
	{
		const { world, hq } = seat();
		const players = world.gameState.playerData as { isAlly: boolean[] };
		// the seat's paper diplomacy: player 2 rides as our ally for this call
		players.isAlly[2] = true;
		captureTarget(world, { "owner": 2 });
		const unit = capturer(world, 2611, { "strength": 1 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		assert.deepEqual(ledger(hq, 2601), { "strength": 1, "ents": new Set([2611]) });
		assert.deepEqual(commands, [], "allied ground is always charged for recapture");
	});

	it("decaying allied ground is left to fall", () =>
	{
		const { world, hq } = seat();
		const players = world.gameState.playerData as { isAlly: boolean[] };
		players.isAlly[2] = true;
		captureTarget(world, { "owner": 2, "decaying": true });
		const unit = capturer(world, 2611, { "strength": 1 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		// recapture is the standing order, but decaying ground is not worth it
		assert.deepEqual(commands, [[2601, false]]);
	});

	it("an invulnerable target is charged all the same", () =>
	{
		const { world, hq } = seat();
		captureTarget(world, { "invulnerable": true });
		const unit = capturer(world, 2611, { "strength": 1 });
		const commands: Array<[number, boolean]> = [];
		unit.attack = (target: number, capture: boolean) => { commands.push([target, capture]); };

		hq.updateCaptureStrength(world.gameState);

		assert.deepEqual(ledger(hq, 2601), { "strength": 1, "ents": new Set([2611]) });
		assert.deepEqual(commands, [], "no anti-capture read against a shielded target");
	});
});

describe("planting a new ground: buildNewBase's template cards", () =>
{
	/** the military colony, the outpost card smaller towns plant first */
	function colonyTemplate(): FakeTemplateLike
	{
		return structureTemplate("structures/athen/military_colony", {
			"classes": ["Structure", "Military"],
			"territories": ["own", "neutral"],
			"getPaths": { "Footprint": { "Square": { "@width": 28, "@depth": 28 } } }
		});
	}

	/** both builders booked, so canBuild holds nothing but template choice */
	function seatCards(world: HqWorld, hq: HqInstance): void
	{
		world.templates["structures/athen/military_colony"] = colonyTemplate();
		world.templates["structures/athen/civil_centre"] = ccTemplate();
		world.addEntity(makeHqEntity({
			"id": 2202, "owner": PLAYER, "position": [152, 152],
			"classes": ["Unit", "Support", "Worker"]
		}, {
			"buildableEntities": (civ: string) =>
				["structures/{civ}/military_colony", "structures/{civ}/civil_centre"]
					.map((name) => name.replace("{civ}", civ))
		}));
		hq.buildManager.init(world.gameState);
	}

	it("the office plants the colony card where its towns keep the cc ways", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		// our town hall: a built CC carrying the civ's own applied template,
		// the walk `hasOwnCC` reads
		world.addEntity(makeHqEntity({
			"id": 1102, "owner": PLAYER, "position": [80, 80],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		seatCards(world, hq);

		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), true);

		const queue = world.ai.queues.civilCentre as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans.length, 1);
		const plan = queue.plans[0] as { type?: string; metadata?: Record<string, unknown> };
		assert.equal(plan.type, "structures/athen/military_colony");
		assert.equal(plan.metadata?.base, -1, "base -1 marks the plan: no base yet, any ground may serve");
	});

	it("without the colony's own card, our civil centre rises again", () =>
	{
		const { world, hq } = seat({
			"phase": 2,
			"stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 },
			"disabledTemplates": ["structures/athen/military_colony"]
		});
		seatCards(world, hq);

		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), true);

		const queue = world.ai.queues.civilCentre as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans[0]?.type, "structures/athen/civil_centre");
	});

	it("a first town awaiting its phase holds every second ground still", () =>
	{
		// phase 1 on the seat: the town hall waits for the phase's word and
		// the office plants nothing new meanwhile
		const { world, hq } = seat({
			"stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 }
		});
		seatCards(world, hq);

		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), false);
		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: unknown[] }).plans.length, 0);
	});

	it("but the phase's research on the books frees the laying", () =>
	{
		const { world, hq } = seat({
			"phase": 1,
			"phaseName": "phaseTown",
			"researching": ["phaseTown"],
			"stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 }
		});
		seatCards(world, hq);

		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), true);
		const queue = world.ai.queues.civilCentre as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans.length, 1, "the laying goes up while the research walks");
	});

	it("a civil-centre foundation holds any second ground waiting", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		// the block next door is ours: a civil centre rising from the ground
		world.addEntity(makeHqEntity({
			id: 1220, "owner": PLAYER, "position": [220, 120],
			"classes": ["Structure", "CivCentre"],
			"templateName": "structures/athen/civil_centre"
		}, { "foundationProgress": () => 0.5 }));

		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), false,
			"one town already rises; the office waits for it");
	});

	it("a civil-centre plan already queued holds the laying too", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		// the office already books one; a second call holds on its side
		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), true);
		assert.equal(hq.buildNewBase(world.gameState, world.ai.queues as never), false,
			"one plan at a time holds the civil-centre queue");
		const queue = world.ai.queues.civilCentre as unknown as { plans: Array<Record<string, unknown>> };
		assert.equal(queue.plans.length, 1);
	});
});

describe("asking for another ground: checkBaseExpansion's thinking", () =>
{
	/** the colony card registered and booked, as the office keeps its cards */
	function seatCards(world: HqWorld, hq: HqInstance): void
	{
		world.templates["structures/athen/military_colony"] = structureTemplate(
			"structures/athen/military_colony", {
			"classes": ["Structure", "Military"],
			"territories": ["own", "neutral"],
			"getPaths": { "Footprint": { "Square": { "@width": 28, "@depth": 28 } } }
		});
		world.addEntity(makeHqEntity({
			"id": 1102, "owner": PLAYER, "position": [80, 80],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		world.addEntity(makeHqEntity({
			"id": 2202, "owner": PLAYER, "position": [152, 152],
			"classes": ["Unit", "Support", "Worker"]
		}, {
			"buildableEntities": (civ: string) =>
				["structures/{civ}/military_colony"].map((name) => name.replace("{civ}", civ))
		}));
		hq.buildManager.init(world.gameState);
	}

	/** our swelling town: `count` own worker-capable units standing idle */
	function seatPopulation(world: HqWorld, count: number): void
	{
		for (let i = 0; i < count; ++i)
			world.addEntity(makeHqEntity({
				id: 4100 + i, "owner": PLAYER, position: [100 + i, 100],
				"classes": ["Unit", "Worker"], "templateName": "units/athen/support_female_citizen"
			}));
	}

	it("the civil-centre queue's own batch holds every expansion hint", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		seatPopulation(world, 80);
		// one ground already booked
		hq.buildNewBase(world.gameState, world.ai.queues as never);

		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);

		const plans = (world.ai.queues.civilCentre as unknown as
			{ plans: unknown[] }).plans;
		assert.equal(plans.length, 1, "the queue's batch is the whole answer while it lasts");
	});

	it("a ground roomless twice over asks for its own base", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		// two buildable candidates turned away for want of room: the site
		// walk's book (a barracks near the yard and a tower on the wall)
		hq.buildManager.setUnbuildable(world.gameState, "structures/athen/barracks", 90, "room");
		hq.buildManager.setUnbuildable(world.gameState, "structures/athen/watchtower", 90, "room");

		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);

		const plans = (world.ai.queues.civilCentre as unknown as
			{ plans: Array<Record<string, unknown>> }).plans;
		assert.equal(plans.length, 1, "the missing room asks a ground of its own");
		assert.equal(plans[0]?.type, "structures/athen/military_colony");
	});

	it("a phasing office holds its swelling town", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		seatPopulation(world, 80);
		hq.phasing = 1;

		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);

		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: unknown[] }).plans.length, 0,
			"while the town's phase is up in the air, no second ground is opened");
	});

	it("the swelling town asks past the aggressive threshold, not before it", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		// one town on the board over the default personality (0.5): the floor
		// is 65 + 5 + 15 * 0 = 70 souls, so 70 callers hold, 71 ask
		seatPopulation(world, 70);
		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);
		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: unknown[] }).plans.length, 0, "exactly the threshold holds");

		world.addEntity(makeHqEntity({
			id: 4170, "owner": PLAYER, position: [250, 100],
			"classes": ["Unit", "Worker"], "templateName": "units/athen/support_female_citizen"
		}));
		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);
		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: Array<Record<string, unknown>> }).plans.length, 1,
			"the caller over the floor breaks the wait");
	});

	it("the retiring manager asks from fewer callers when the funds stretch", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		seatCards(world, hq);
		hq.saveResources = true;
		seatPopulation(world, 55);

		hq.checkBaseExpansion(world.gameState, world.ai.queues as never);

		const plans = (world.ai.queues.civilCentre as unknown as
			{ plans: Array<Record<string, unknown>> }).plans;
		assert.equal(plans.length, 1, "holding funds, fifty and one callers ask a ground");
	});
});

describe("the office's turn on the clock: update's schedule", () =>
{
	it("the turn's books are wiped before any walk", () =>
	{
		const { world, hq } = seat();
		// a stale cache from a previous turn's question
		hq.turnCache.accountedPopulation = 999 as never;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		// the wipe may already have been recomputed by one of the update's
		// own walks: the point is the stale 999 never rides again
		assert.notEqual(hq.turnCache.accountedPopulation, 999,
			"the headcount of yesterday is not the headcount of today");
		assert.equal(hq.getAccountedPopulation(world.gameState), 0,
			"the recount answers from today's town, not yesterday's book");
	});

	it("the town hall advancing marks the office's phase and clears the flag", () =>
	{
		const { world, hq } = seat({ "phase": 2 });
		// the office still books itself at the earlier phase with a live flag
		hq.currentPhase = 1;
		hq.phasing = 1;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal(hq.currentPhase, 2, "the read of the town hall is the office's now");
		assert.equal(hq.phasing, 0, "the advance closes the phasing question");
	});

	it("when the town hall has not moved, the office holds its own count", () =>
	{
		const { world, hq } = seat();
		hq.currentPhase = 1;
		hq.phasing = 0;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal(hq.currentPhase, 1);
		assert.equal(hq.phasing, 0, "no advance recorded, no flag disturbed");
	});

	it("a market built turns the office's barter lantern on", () =>
	{
		const { world, hq } = seat();
		world.addEntity(makeHqEntity({
			id: 2501, "owner": PLAYER, "position": centerOfCell(30, 30),
			"classes": ["Structure", "Market"], "templateName": "structures/athen/market"
		}));

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal(hq.canBarter, true, "a built market of ours is the licence to buy and sell");
	});

	it("the stale capture ledger is re-walked after three seconds of silence", () =>
	{
		const { world, hq } = seat();
		hq.capturableTargetsTime = 95;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal(hq.capturableTargetsTime, 100,
			"the walk stamped itself again at the town's own clock");
	});

	it("but a ledger still fresh with the town's clock waits its turn", () =>
	{
		const { world, hq } = seat();
		hq.capturableTargetsTime = 98;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal(hq.capturableTargetsTime, 98,
			"under three seconds of silence, the book stays as it was");
	});

	it("the expansion hint rides the seventh turn of ten through the update", () =>
	{
		const { world, hq } = seat({
			"phase": 2,
			"stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 }
		});
		world.templates["structures/athen/military_colony"] = structureTemplate(
			"structures/athen/military_colony", {
			"classes": ["Structure", "Military"],
			"territories": ["own", "neutral"]
		});
		world.addEntity(makeHqEntity({
			id: 1102, "owner": PLAYER, position: [80, 80],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		world.addEntity(makeHqEntity({
			"id": 2202, "owner": PLAYER, "position": [152, 152],
			"classes": ["Unit", "Support", "Worker"]
		}, {
			"buildableEntities": (civ: string) =>
				["structures/{civ}/military_colony"].map((name) => name.replace("{civ}", civ))
		}));
		hq.buildManager.init(world.gameState);
		for (let i = 0; i < 71; ++i)
			world.addEntity(makeHqEntity({
				id: 4100 + i, "owner": PLAYER, position: [100 + i, 100],
				"classes": ["Unit", "Worker"], "templateName": "units/athen/support_female_citizen"
			}));
		world.ai.playedTurn = 7;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: Array<Record<string, unknown>> }).plans.length, 1,
			"the seventh turn carries the expansion hint to the colony book");
		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: Array<Record<string, unknown>> }).plans[0]?.type,
			"structures/athen/military_colony");
	});

	it("but a turn off the seventh rides without the hint", () =>
	{
		const { world, hq } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		world.templates["structures/athen/military_colony"] = structureTemplate(
			"structures/athen/military_colony", {
			"classes": ["Structure", "Military"],
			"territories": ["own", "neutral"]
		});
		world.addEntity(makeHqEntity({
			id: 1102, "owner": PLAYER, position: [80, 80],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		world.addEntity(makeHqEntity({
			"id": 2202, "owner": PLAYER, "position": [152, 152],
			"classes": ["Unit", "Support", "Worker"]
		}, {
			"buildableEntities": (civ: string) =>
				["structures/{civ}/military_colony"].map((name) => name.replace("{civ}", civ))
		}));
		hq.buildManager.init(world.gameState);
		for (let i = 0; i < 71; ++i)
			world.addEntity(makeHqEntity({
				id: 4100 + i, "owner": PLAYER, position: [100 + i, 100],
				"classes": ["Unit", "Worker"], "templateName": "units/athen/support_female_citizen"
			}));
		world.ai.playedTurn = 8;

		hq.update(world.gameState, world.ai.queues as never, eventsWith({}));

		assert.equal((world.ai.queues.civilCentre as unknown as
			{ plans: unknown[] }).plans.length, 0,
			"the eighth turn carries no expansion hint, the card unbooked");
	});
});

describe("the first town's landing and the later ground: handleNewBase", () =>
{
	it("the first landing dresses the office for a tight start", () =>
	{
		const { world, hq } = seat();
		// the office has not yet seen its first town's ground
		hq.firstBaseConfig = false;

		hq.handleNewBase(world.gameState);

		assert.equal(hq.firstBaseConfig, true, "the landing is configured once");
		assert.equal(hq.saveSpace, true,
			"the small starting ground of a fresh town keeps the buildings packed");
		assert.equal(hq.maxFields, 1, "and its fields stay few");
	});

	it("but a later ground clears the thrift of the early town", () =>
	{
		const { world, hq } = seat();
		// stale thrift carried from the first town's landing
		hq.firstBaseConfig = true;
		hq.saveResources = true;
		hq.saveSpace = true;
		hq.maxFields = 1;

		hq.handleNewBase(world.gameState);

		assert.equal(hq.saveResources, undefined,
			"the funds are spent freely again: the new ground may fix the shortage");
		assert.equal(hq.saveSpace, undefined, "the buildings spread again");
		assert.equal(hq.maxFields, false, "the fields are not numbered anymore");
	});
});

