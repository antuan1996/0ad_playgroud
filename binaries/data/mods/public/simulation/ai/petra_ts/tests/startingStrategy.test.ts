/**
 * The opening of a game (startingStrategy): how Petra reads the map it was
 * dropped on, hands out the units it starts with, and what it does when it
 * starts without a civil centre.
 *
 * configFirstBase — the day-one economy policy of the first town — is
 * verified by the headquarters suite ("headquarters and first arrival"); this
 * suite drives gameAnalysis, the entry point the bot calls on its first turn,
 * and buildFirstBase, which the HQ also calls when every centre fell.
 *
 * Maps: the HQ world's passability board is 160x160 cells of 2x2 map units
 * (25600 cells: a land region needs 2560 cells, a water region 5120, to count
 * as "big"). Region ids are the common-api's: land and water share one id
 * space, 0 and 1 are inaccessible, and a cell of a land region reads 1 on the
 * naval map (CommonAccessibility.floodFill marks it impassable for ships).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logs, resetRecorder } from "./harness/engine.ts";
import {
	doorCalls, doorManagers, GAIA, type HqWorld, type HqWorldOptions, makeHQConfig, makeHqEntity,
	makeHqWorld, MAP_CELLS, PASS_RATIO, PLAYER, seatHQ, structureTemplate
} from "./harness/hqWorld.ts";

import type { Headquarters } from "../decision/headquarters.ts";
import { buildFirstBase, gameAnalysis } from "../decision/startingStrategy.ts";
import { entityId, landRegion } from "../adapter/brands.ts";

const PASS_WIDTH = MAP_CELLS * PASS_RATIO;
const ALLY = 3;
interface StartOptions extends HqWorldOptions
{
	/** the regions terrain analysis found, keyed by id: their type and cell count */
	regions?: Record<number, { type: "land" | "water"; size: number }>;
	/** the naval region of a passability cell; default 1 (land: impassable for ships) */
	navalPassMap?: (px: number, pz: number) => number;
	/** keep the seed civil centre at [10,10]; default true */
	cc?: boolean;
}

/** A map at game start, with the accessibility the common-api computes for it. */
function startWorld(options: StartOptions = {}): HqWorld
{
	const world = makeHqWorld({ "stock": { "food": 300, "wood": 300, "stone": 300, "metal": 300 }, ...options });
	if (options.cc === false)
		world.removeEntity(1000);
	const accessibility = world.ai.accessibility as unknown as Record<string, unknown> & {
		landPassMap: Uint8Array; navalPassMap: Uint8Array; width: number;
		gamePosToMapPos(pos: [number, number]): [number, number];
	};
	const naval = new Uint8Array(PASS_WIDTH * PASS_WIDTH);
	for (let k = 0; k < naval.length; ++k)
		naval[k] = options.navalPassMap?.(k % PASS_WIDTH, Math.floor(k / PASS_WIDTH)) ?? 1;
	accessibility.navalPassMap = naval;
	// as CommonAccessibility.getAccessValue: the region of the cell under the position
	accessibility.getAccessValue = (pos: [number, number], onWater?: boolean) =>
	{
		const [x, z] = accessibility.gamePosToMapPos(pos);
		return (onWater === true ? accessibility.navalPassMap : accessibility.landPassMap)[x + z * accessibility.width];
	};
	// the region tables are arrays indexed by region id, as terrain analysis fills them
	const regions = options.regions ?? { 2: { "type": "land", "size": 20000 } };
	const top = Math.max(...Object.keys(regions).map(Number));
	const regionSize: number[] = [];
	const regionType: string[] = [];
	for (let i = 0; i <= top; ++i)
	{
		regionSize.push(regions[i]?.size ?? 0);
		regionType.push(regions[i]?.type ?? "inaccessible");
	}
	accessibility.regionSize = regionSize;
	accessibility.regionType = regionType;
	return world;
}

/** Seat a fresh HQ the way the bot holds it before its first turn: no region known yet. */
function freshHQ(world: HqWorld, config = makeHQConfig()): Headquarters
{
	const hq = seatHQ(world, { "stubs": doorManagers, "seatBases": false, config });
	hq.landRegions = {};
	hq.navalRegions = {};
	hq.navalMap = false;
	// as constructed: gameAnalysis decides whether the AI builds and expands
	Reflect.deleteProperty(hq, "canBuildUnits");
	Reflect.deleteProperty(hq, "canExpand");
	// the naval manager's docks, as its init collects them
	hq.navalManager.docks = world.gameState.getOwnEntitiesByClass("Dock", false);
	return hq;
}

/** the answers a starting unit gives the base that takes it on */
const unitAnswers = {
	"isIdle": () => false,
	"unitAIState": () => "INDIVIDUAL.IDLE",
	"currentGatherRate": () => 0,
	"canGather": () => true,
	"isGatherer": () => true,
	"isBuilder": () => true,
	"stopMoving": () => undefined,
	"canAttackClass": () => false,
	"isGarrisonHolder": () => false,
	"isTreasureCollector": () => true
};

/** a starting villager; without a position it is garrisoned somewhere */
function villager(world: HqWorld, id: number, position: [number, number] | undefined,
	methods: Record<string, unknown> = {}): CommonEntity
{
	return world.addEntity(makeHqEntity({
		id, "owner": PLAYER, position,
		"classes": ["Unit", "Support", "Civilian", "Worker", "Female"],
		"templateName": "units/athen/support_female_citizen"
	}, {
		...unitAnswers,
		"buildableEntities": () => ["structures/athen/civil_centre", "structures/athen/dock"],
		...methods
	}));
}

/** a citizen soldier of the given classes */
function soldier(world: HqWorld, id: number, position: [number, number] | undefined, classes: string[],
	methods: Record<string, unknown> = {}): CommonEntity
{
	return world.addEntity(makeHqEntity({
		id, "owner": PLAYER, position,
		"classes": ["Unit", "CitizenSoldier", "Worker", ...classes],
		"templateName": "units/athen/" + classes.join("_").toLowerCase()
	}, { ...unitAnswers, "buildableEntities": () => [], ...methods }));
}

/** the civil centre and dock templates as the game ships them (both may stand outside our land) */
function addFoundingTemplates(world: HqWorld, ccCost = { "wood": 500, "stone": 500, "metal": 500 }): void
{
	world.templates["structures/athen/civil_centre"] = structureTemplate("structures/athen/civil_centre", {
		"classes": ["Structure", "CivCentre", "Defensive"], "cost": ccCost,
		"territories": ["own", "neutral"], "placement": "land"
	});
	world.templates["structures/athen/dock"] = structureTemplate("structures/athen/dock", {
		"classes": ["Structure", "Dock", "Naval"], "cost": { "wood": 200 },
		"territories": ["own", "neutral"], "placement": "shore"
	});
}

/** the moves recorded on a unit sent to defend an ally */
function moverAnswers(moves: Array<[number, unknown[]]>, id: number): Record<string, unknown>
{
	return { "moveToRange": (...args: unknown[]) => moves.push([id, args]) };
}

//
// reading the map
//

describe("game start: which regions of the map Petra plays on", () =>
{
	it("a civil centre on the main land makes that land home; a big coast across a strait joins it", () =>
	{
		const world = startWorld({
			"regions": {
				2: { "type": "land", "size": 12000 },
				3: { "type": "water", "size": 3000 },
				4: { "type": "land", "size": 4000 }
			},
			"trajectories": { "2,4": [2, 3, 4] }
		});
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), true);

		assert.deepEqual(hq.landRegions, { 2: true, 4: true });
		// the strait is the sea the fleet must hold to reach the other coast
		assert.deepEqual(hq.navalRegions, { 3: true });
		assert.equal(hq.navalMap, true);
	});

	it("a small islet across a pond stays off the map; the pond is still worth a fishing boat", () =>
	{
		const world = startWorld({
			"regions": {
				2: { "type": "land", "size": 20000 },
				// 1500 cells of water (6000 square map units): fishable, not a sea lane
				3: { "type": "water", "size": 1500 },
				// 500 cells of land behind it: under 10% of the map
				4: { "type": "land", "size": 500 },
				// a rock of 50 cells (200 square map units) and a puddle of 500 (2000)
				5: { "type": "land", "size": 50 },
				6: { "type": "water", "size": 500 }
			},
			"trajectories": { "2,4": [2, 3, 4], "2,5": [2, 6, 5] }
		});
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.landRegions, { 2: true });
		assert.deepEqual(hq.navalRegions, { 3: true });
		assert.equal(hq.navalMap, false);
	});

	it("an open sea makes a naval map, and any sizable land across it is worth settling", () =>
	{
		const world = startWorld({
			"regions": {
				2: { "type": "land", "size": 12000 },
				// over 20% of the board
				3: { "type": "water", "size": 8000 },
				// small, but reached over the open sea
				4: { "type": "land", "size": 500 },
				// land that no single sea connects to us (a lake island behind the coast)
				5: { "type": "land", "size": 4000 }
			},
			"trajectories": { "2,4": [2, 3, 4], "2,5": [2, 3, 4, 7, 5] }
		});
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.landRegions, { 2: true, 4: true });
		assert.deepEqual(hq.navalRegions, { 3: true });
		assert.equal(hq.navalMap, true);
	});

	it("a nomad start: no civil centre, the villagers' land is home", () =>
	{
		const world = startWorld({
			"cc": false,
			// every board cell is land 3
			"landPassMap": () => 3,
			"regions": {
				3: { "type": "land", "size": 12000 },
				5: { "type": "water", "size": 3000 },
				4: { "type": "land", "size": 6000 }
			},
			"trajectories": { "3,4": [3, 5, 4] }
		});
		// a house first in the list: buildings that train nobody do not say where home is
		world.addEntity(makeHqEntity({
			"id": 30, "owner": PLAYER, "position": [200, 200], "classes": ["Structure", "House"],
			"templateName": "structures/athen/house"
		}, { "trainableEntities": () => undefined, "isGarrisonHolder": () => false,
			"resourceDropsiteTypes": () => undefined, "decaying": () => false }));
		villager(world, 31, [100, 100]);
		villager(world, 32, [102, 100]);
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), true);

		assert.deepEqual(hq.landRegions, { 3: true, 4: true });
		assert.deepEqual(hq.navalRegions, { 5: true });
	});

	it("a start at sea: the ship's waters are home and every coast it touches is land to settle", () =>
	{
		const world = startWorld({
			"cc": false,
			// the west half is sea 5, the east half land 2
			"landPassMap": (px) => px < 80 ? 1 : 2,
			"navalPassMap": (px) => px < 80 ? 5 : 1,
			"regions": {
				2: { "type": "land", "size": 12800 },
				5: { "type": "water", "size": 12800 },
				// a land two seas away: not reachable straight from the ship's sea
				6: { "type": "land", "size": 4000 }
			},
			"trajectories": { "5,2": [5, 2], "5,6": [5, 7, 6] }
		});
		// the villagers ride inside the ship
		villager(world, 41, undefined);
		villager(world, 42, undefined);
		world.addEntity(makeHqEntity({
			"id": 40, "owner": PLAYER, "position": [40, 40], "classes": ["Unit", "Ship", "Warship"],
			"templateName": "units/athen/ship_trireme"
		}, { ...unitAnswers, "isGarrisonHolder": () => true, "garrisoned": () => [41, 42],
			"canGather": () => false, "isGatherer": () => false, "isBuilder": () => false }));
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), true);

		assert.deepEqual(hq.landRegions, { 2: true });
		assert.deepEqual(hq.navalRegions, { 5: true });
		assert.equal(hq.navalMap, true);
		// a ship keeps its passengers aboard (the fake has no unload: a call would throw);
		// they land when a construction needs them (createTransportIfNeeded)
	});

	it("a map with nothing it can stand on: the bot gives up before touching any manager", () =>
	{
		resetRecorder();
		const world = startWorld({
			"cc": false,
			// everything reads impassable for both land units and ships
			"landPassMap": () => 0,
			"navalPassMap": () => 0,
			"regions": {}
		});
		villager(world, 51, [100, 100]);
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), false);

		assert.ok(logs.some((line) => line.includes("it does not know how to interpret this map")));
		// gameAnalysis stopped before initialising the staff: nothing was assigned
		assert.notEqual(hq.firstBaseConfig, true);
		assert.equal(hq.canBuildUnits, undefined);
		assert.deepEqual(doorCalls(hq.tradeManager), []);
	});
});

//
// the first turn's bookkeeping
//

describe("game start: what the first turn books", () =>
{
	it("the civilization's extra buildings are the ones its templates offer", () =>
	{
		const world = startWorld();
		// athen lists gymnasium, prytaneion and theater; this game has no prytaneion
		for (const name of ["gymnasium", "theater"])
			world.templates[`structures/athen/${name}`] = structureTemplate(`structures/athen/${name}`,
				{ "classes": ["Structure"] });
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.bAdvanced, ["structures/athen/gymnasium", "structures/athen/theater"]);
	});

	it("a civilization the config does not list gets the default (empty) list", () =>
	{
		const world = startWorld();
		world.gameState.playerData.civ = "mod_civ";
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.bAdvanced, []);
	});

	it("sandbox never expands; every other level does", () =>
	{
		for (const [difficulty, expands] of [[0, false], [1, true], [3, true], [5, true]] as const)
		{
			const world = startWorld();
			const hq = freshHQ(world, makeHQConfig({ difficulty }));
			gameAnalysis(hq, world.gameState);
			assert.equal(hq.canExpand, expands, `difficulty ${difficulty}`);
		}
	});

	it("with a civil centre the bot can train, and its first town gets its day-one policy", () =>
	{
		const world = startWorld();
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.equal(hq.canBuildUnits, true);
		assert.equal(hq.baseManagers().length, 1);
		assert.equal(hq.firstBaseConfig, true);
		// the land is 20000 cells of 4 square map units: a big start, no field cap
		assert.equal(hq.maxFields, false);
	});

	it("a land of 25000 to 60000 square map units caps the town at two fields", () =>
	{
		const world = startWorld({ "regions": { 2: { "type": "land", "size": 10000 } } });
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.equal(hq.maxFields, 2);
		assert.notEqual(hq.saveSpace, true);
	});

	it("land traders go to the trade manager at once; merchant ships wait (they may carry troops)", () =>
	{
		const world = startWorld();
		world.addEntity(makeHqEntity({
			"id": 60, "owner": PLAYER, "position": [100, 100], "classes": ["Unit", "Trader"],
			"templateName": "units/athen/support_trader"
		}, { ...unitAnswers, "canGather": () => false, "isGatherer": () => false, "isBuilder": () => false }));
		world.addEntity(makeHqEntity({
			"id": 61, "owner": PLAYER, "position": [104, 100], "classes": ["Unit", "Trader", "Ship"],
			"templateName": "units/athen/ship_merchant"
		}, { ...unitAnswers, "canGather": () => false, "isGatherer": () => false, "isBuilder": () => false }));
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		const assigned = doorCalls(hq.tradeManager)
			.filter(([name]) => name === "assignTrader")
			.map(([, args]) => (args[0] as CommonEntity).id());
		assert.deepEqual(assigned, [60]);
	});

	it("units starting inside a building are let out", () =>
	{
		const world = startWorld();
		const unloaded: number[] = [];
		villager(world, 71, undefined);
		villager(world, 72, undefined);
		world.addEntity(makeHqEntity({
			"id": 70, "owner": PLAYER, "position": [100, 100], "classes": ["Structure", "Tower", "Defensive"],
			"templateName": "structures/athen/sentry_tower"
		}, { "isGarrisonHolder": () => true, "garrisoned": () => [71, 72],
			"unload": (id: number) => unloaded.push(id),
			"resourceDropsiteTypes": () => undefined, "decaying": () => false }));
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(unloaded, [71, 72]);
	});

	it("a garrisoned holder inside another holder is not supported: Petra warns and moves on", () =>
	{
		resetRecorder();
		const world = startWorld();
		// a ram (holding a soldier) carried inside a ship
		soldier(world, 82, undefined, ["Infantry", "Melee"]);
		world.addEntity(makeHqEntity({
			"id": 81, "owner": PLAYER, "position": undefined, "classes": ["Unit", "Siege", "Ram"],
			"templateName": "units/athen/siege_ram"
		}, { ...unitAnswers, "isGarrisonHolder": () => true, "garrisoned": () => [82],
			"canGather": () => false, "isGatherer": () => false, "isBuilder": () => false }));
		world.addEntity(makeHqEntity({
			"id": 80, "owner": PLAYER, "position": [100, 100], "classes": ["Unit", "Ship", "Warship"],
			"templateName": "units/athen/ship_trireme"
		}, { ...unitAnswers, "isGarrisonHolder": () => true, "garrisoned": () => [81],
			"canGather": () => false, "isGatherer": () => false, "isBuilder": () => false }));
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), true);

		assert.ok(logs.some((line) => line.includes("garrisoned units inside garrisoned holders")));
	});

	it("a unit standing on a small island keeps that island on the map", () =>
	{
		const world = startWorld({
			// a 4x4-cell islet (region 7) in the corner of the board
			"landPassMap": (px, pz) => px >= 150 && pz >= 150 ? 7 : 2,
			"regions": {
				2: { "type": "land", "size": 20000 },
				7: { "type": "land", "size": 16 }
			}
		});
		villager(world, 90, [305, 305]);
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.landRegions, { 2: true, 7: true });
	});
	it("a fishing boat starting on a lake too small to count keeps that lake on the map", () =>
	{
		const world = startWorld({
			// a 10x10-cell lake (region 6) in the corner of the board
			"landPassMap": (px, pz) => px >= 150 && pz >= 150 ? 1 : 2,
			"navalPassMap": (px, pz) => px >= 150 && pz >= 150 ? 6 : 1,
			"regions": {
				2: { "type": "land", "size": 25500 },
				// 100 cells, 400 square map units: under the 3600 a fishing lake needs
				6: { "type": "water", "size": 100 }
			}
		});
		world.addEntity(makeHqEntity({
			"id": 95, "owner": PLAYER, "position": [310, 310], "classes": ["Unit", "Ship", "FishingBoat"],
			"templateName": "units/athen/ship_fishing"
		}, { ...unitAnswers, "isBuilder": () => false }));
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(hq.navalRegions, { 6: true });
		assert.equal(hq.navalMap, false);
	});
});

//
// no civil centre at start
//

describe("game start without a civil centre", () =>
{
	it("a civ that cannot build a civil centre cannot train; with no ally to guard, its units stay free", () =>
	{
		const world = startWorld({ "cc": false });
		const moves: Array<[number, unknown[]]> = [];
		soldier(world, 101, [100, 100], ["Infantry", "Ranged"], moverAnswers(moves, 101));
		const hq = freshHQ(world);

		assert.equal(gameAnalysis(hq, world.gameState), true);

		assert.equal(hq.canBuildUnits, false);
		assert.deepEqual(moves, []);
		assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		// no town: no day-one policy either
		assert.notEqual(hq.firstBaseConfig, true);
	});

	it("an army without a base sends a share to guard the allied civil centre, ranged and melee first, all support with them", () =>
	{
		const world = startWorld({ "cc": false });
		world.gameState.playerData.isMutualAlly[ALLY] = true;
		world.addEntity(makeHqEntity({
			"id": 100, "owner": ALLY, "position": [200, 200], "classes": ["Structure", "CivCentre"],
			"templateName": "structures/athen/civil_centre"
		}, { "footprintRadius": () => 20 }));
		const moves: Array<[number, unknown[]]> = [];
		// ten units on our land: three archers, three spearmen, two horsemen, two women
		for (const id of [101, 102, 103])
			soldier(world, id, [100, 100], ["Infantry", "Ranged"], moverAnswers(moves, id));
		for (const id of [104, 105, 106])
			soldier(world, id, [100, 100], ["Infantry", "Melee"], moverAnswers(moves, id));
		for (const id of [107, 108])
			soldier(world, id, [100, 100], ["Cavalry", "Melee"], moverAnswers(moves, id));
		for (const id of [109, 110])
			villager(world, id, [100, 100], moverAnswers(moves, id));
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.equal(hq.canBuildUnits, false);
		// max(min(round(0.08 * (1 + 0.5) * 10), 20), 5) = 5 fighters: two archers,
		// two spearmen, then the next fighter in line (the third archer); both women follow
		const sent = moves.map(([id]) => id);
		assert.deepEqual(sent, [101, 102, 104, 105, 103, 109, 110]);
		// each walks to 1.5 footprint radii of the ally's centre
		assert.deepEqual(moves[0][1], [200, 200, 30, 35]);
		for (const id of sent)
			assert.equal(world.ents.get(id)!.getMetadata(PLAYER, "allied"), true);
		assert.equal(world.ents.get(106)!.getMetadata(PLAYER, "allied"), undefined);
	});

	it("units on another island than the allied civil centre stay where they are", () =>
	{
		const world = startWorld({
			"cc": false,
			// the ally sits on land 4 in the east, we are on land 2
			"landPassMap": (px) => px < 80 ? 2 : 4,
			"regions": { 2: { "type": "land", "size": 12800 }, 4: { "type": "land", "size": 12800 } }
		});
		world.gameState.playerData.isMutualAlly[ALLY] = true;
		world.addEntity(makeHqEntity({
			"id": 100, "owner": ALLY, "position": [250, 250], "classes": ["Structure", "CivCentre"],
			"templateName": "structures/athen/civil_centre"
		}, { "footprintRadius": () => 20 }));
		// the common-api books a structure's access in its metadata
		world.ents.get(100)!.setMetadata(PLAYER, "access", landRegion(4));
		const moves: Array<[number, unknown[]]> = [];
		soldier(world, 101, [100, 100], ["Infantry", "Ranged"], moverAnswers(moves, 101));
		soldier(world, 102, [100, 100], ["Infantry", "Melee"], moverAnswers(moves, 102));
		villager(world, 103, [100, 100], moverAnswers(moves, 103));
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.deepEqual(moves, []);
	});

	it("a civ that can build one plans its first civil centre where most of its villagers stand", () =>
	{
		const world = startWorld({ "cc": false, "stock": { "food": 500, "wood": 1000, "stone": 1000, "metal": 1000 } });
		addFoundingTemplates(world);
		villager(world, 111, [100, 100]);
		villager(world, 112, [110, 100]);
		villager(world, 113, [100, 110]);
		villager(world, 114, [250, 250]);
		villager(world, 115, [255, 250]);
		const hq = freshHQ(world);

		gameAnalysis(hq, world.gameState);

		assert.equal(hq.canBuildUnits, true);
		const plans = world.ai.queues.civilCentre.plans;
		assert.equal(plans.length, 1);
		assert.equal(plans[0].type, "structures/athen/civil_centre");
		assert.deepEqual(plans[0].metadata, { "base": -1, "resource": "wood", "proximity": [100, 100] });
	});
});

//
// buildFirstBase
//

/** A world with no civil centre left, and an HQ that has run its first turn. */
function homeless(options: StartOptions = {}): { world: HqWorld; hq: Headquarters }
{
	const world = startWorld({ "cc": false, ...options });
	addFoundingTemplates(world);
	return { world, hq: freshHQ(world) };
}

/** builders known to the build manager, as its init counts them */
function initBuilders(world: HqWorld, hq: Headquarters): void
{
	hq.buildManager.init(world.gameState);
}

describe("buildFirstBase: founding a town from nothing", () =>
{
	it("rich enough: the centre goes where the largest group of villagers stands; cavalry is not counted", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 600, "stone": 600, "metal": 600 } });
		villager(world, 201, [250, 250]);
		villager(world, 202, [252, 250]);
		villager(world, 203, [100, 100]);
		villager(world, 204, [130, 100]);
		villager(world, 205, [100, 130]);
		// four horsemen far off: fast movers do not settle a town
		for (const id of [206, 207, 208, 209])
			soldier(world, id, [60, 280], ["Cavalry", "FastMoving"]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		const plans = world.ai.queues.civilCentre.plans;
		assert.equal(plans.length, 1);
		// 203-205 are within 50 map units of the first of them
		assert.deepEqual(plans[0].metadata?.proximity, [100, 100]);
		assert.equal(world.ai.queues.dock.plans.length, 0);
	});

	it("villagers on two lands are two groups, however close", () =>
	{
		const { world, hq } = homeless({
			// a river: cells with px < 50 are land 2, the others land 4
			"landPassMap": (px) => px < 50 ? 2 : 4,
			"regions": { 2: { "type": "land", "size": 8000 }, 4: { "type": "land", "size": 17600 } },
			"stock": { "food": 0, "wood": 600, "stone": 600, "metal": 600 }
		});
		villager(world, 211, [96, 100]);
		villager(world, 212, [104, 100]);
		villager(world, 213, [106, 100]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.deepEqual(world.ai.queues.civilCentre.plans[0].metadata?.proximity, [104, 100]);
	});

	it("villagers aboard a ship count where the ship floats", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 600, "stone": 600, "metal": 600 } });
		villager(world, 221, undefined);
		villager(world, 222, undefined);
		villager(world, 223, [280, 280]);
		world.addEntity(makeHqEntity({
			"id": 220, "owner": PLAYER, "position": [60, 60], "classes": ["Unit", "Ship"],
			"templateName": "units/athen/ship_merchant"
		}, { ...unitAnswers, "isGarrisonHolder": () => true, "garrisoned": () => [221, 222] }));
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.deepEqual(world.ai.queues.civilCentre.plans[0].metadata?.proximity, [60, 60]);
	});

	it("a centre already queued is not doubled", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 2000, "stone": 2000, "metal": 2000 } });
		villager(world, 231, [100, 100]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);
		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.civilCentre.plans.length, 1);
	});

	it("nothing is planned when the centre is disabled, or nobody can build it", () =>
	{
		{
			const { world, hq } = homeless({ "stock": { "food": 0, "wood": 2000, "stone": 2000, "metal": 2000 },
				"disabledTemplates": ["structures/athen/civil_centre"] });
			villager(world, 241, [100, 100]);
			initBuilders(world, hq);
			buildFirstBase(hq, world.gameState);
			assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		}
		{
			const { world, hq } = homeless({ "stock": { "food": 0, "wood": 2000, "stone": 2000, "metal": 2000 } });
			villager(world, 242, [100, 100], { "buildableEntities": () => ["structures/athen/house"] });
			initBuilders(world, hq);
			buildFirstBase(hq, world.gameState);
			assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		}
	});

	it("nothing is planned when only horsemen are left", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 2000, "stone": 2000, "metal": 2000 } });
		soldier(world, 251, [100, 100], ["Cavalry", "FastMoving"],
			{ "buildableEntities": () => ["structures/athen/civil_centre"] });
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.civilCentre.plans.length, 0);
	});

	it("too poor, but a treasure in reach pays the difference: the villager goes for it and the town waits", () =>
	{
		const world = startWorld({ "cc": false, "stock": { "food": 0, "wood": 300, "stone": 500, "metal": 500 } });
		addFoundingTemplates(world);
		// the treasure lies on the map before the bot's first turn
		world.addEntity(makeHqEntity({
			"id": 260, "owner": GAIA, "position": [120, 100], "classes": ["Treasure"],
			"templateName": "gaia/treasure/wood"
		}, { "isTreasure": () => true, "treasureResources": () => ({ "wood": 300 }) }));
		const collected: unknown[] = [];
		villager(world, 261, [100, 100], { "isIdle": () => true, "collectTreasure": (t: CommonEntity) => collected.push(t.id()) });
		const hq = freshHQ(world);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.deepEqual(collected, [260]);
		assert.equal(world.ents.get(261)!.getMetadata(PLAYER, "treasure"), 260);
		assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		assert.equal(world.ai.queues.dock.plans.length, 0);
	});

	it("too poor and no treasure that pays enough: a dock first, to fish and trade the money in", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 } });
		villager(world, 271, [100, 100]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		const docks = world.ai.queues.dock.plans;
		assert.equal(docks.length, 1);
		assert.equal(docks[0].type, "structures/athen/dock");
		// the villager stands on dry land (naval region 1): no sea is named
		assert.deepEqual(docks[0].metadata, { "sea": undefined, "proximity": [100, 100] });
	});

	it("villagers wading in the shallows name the sea the dock is for", () =>
	{
		const { world, hq } = homeless({
			"navalPassMap": (px) => px < 60 ? 3 : 1,
			"regions": { 2: { "type": "land", "size": 20000 }, 3: { "type": "water", "size": 3000 } },
			"stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 }
		});
		villager(world, 281, [100, 100]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.dock.plans[0].metadata?.sea, 3);
	});

	it("too poor even for a dock, or a dock already queued: wait", () =>
	{
		{
			const { world, hq } = homeless({ "stock": { "food": 0, "wood": 100, "stone": 0, "metal": 0 } });
			villager(world, 291, [100, 100]);
			initBuilders(world, hq);
			buildFirstBase(hq, world.gameState);
			assert.equal(world.ai.queues.dock.plans.length, 0);
			assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		}
		{
			const { world, hq } = homeless({ "stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 } });
			villager(world, 292, [100, 100]);
			initBuilders(world, hq);
			buildFirstBase(hq, world.gameState);
			buildFirstBase(hq, world.gameState);
			assert.equal(world.ai.queues.dock.plans.length, 1);
		}
		{
			const { world, hq } = homeless({ "stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 },
				"disabledTemplates": ["structures/athen/dock"] });
			villager(world, 293, [100, 100]);
			initBuilders(world, hq);
			buildFirstBase(hq, world.gameState);
			assert.equal(world.ai.queues.dock.plans.length, 0);
		}
	});

	it("a civilization without a civil centre template plans nothing", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 2000, "stone": 2000, "metal": 2000 } });
		delete world.templates["structures/athen/civil_centre"];
		villager(world, 245, [100, 100]);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.civilCentre.plans.length, 0);
		assert.equal(world.ai.queues.dock.plans.length, 0);
	});

	it("counting treasures: villagers aboard a ship cannot fetch one, and a treasure already picked up counts for nothing", () =>
	{
		const world = startWorld({ "cc": false, "stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 } });
		addFoundingTemplates(world);
		// a villager rides in the ship; another was sent last turn to a treasure
		// someone else has picked up since (the entity is gone)
		villager(world, 266, undefined);
		world.addEntity(makeHqEntity({
			"id": 265, "owner": PLAYER, "position": [60, 60], "classes": ["Unit", "Ship"],
			"templateName": "units/athen/ship_merchant"
		}, { ...unitAnswers, "isGarrisonHolder": () => true, "garrisoned": () => [266] }));
		villager(world, 267, [100, 100]);
		world.ents.get(267)!.setMetadata(PLAYER, "treasure", entityId(999));
		const hq = freshHQ(world);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		// nothing to wait for: the dock comes first
		assert.equal(world.ai.queues.dock.plans.length, 1);
	});

	it("too poor with a dock already standing: the centre is planned anyway and waits for the money", () =>
	{
		const { world, hq } = homeless({ "stock": { "food": 0, "wood": 300, "stone": 0, "metal": 0 } });
		world.addEntity(makeHqEntity({
			"id": 300, "owner": PLAYER, "position": [40, 100], "classes": ["Structure", "Dock", "Naval"],
			"templateName": "structures/athen/dock"
		}));
		villager(world, 301, [100, 100]);
		hq.navalManager.docks = world.gameState.getOwnEntitiesByClass("Dock", false);
		initBuilders(world, hq);

		buildFirstBase(hq, world.gameState);

		assert.equal(world.ai.queues.civilCentre.plans.length, 1);
		assert.equal(world.ai.queues.dock.plans.length, 0);
	});
});
