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
import {
	makeGaiaSupply, makeHqEntity, makeHQConfig, makeHqWorld, seatHQ, structureTemplate, centerOfCell, PLAYER, ENEMY, GAIA,
	type HqSeatOptions, type HqWorldOptions
} from "./harness/hqWorld.ts";
import { emptyEvents, restoreEngine, stubGlobal, type World } from "./harness/attackWorld.ts";
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
