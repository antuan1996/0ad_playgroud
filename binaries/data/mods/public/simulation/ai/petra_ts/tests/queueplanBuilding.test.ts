/**
 * ConstructionPlan: one building the town has queued, from the moment the
 * queue asks whether it may start to the foundation laid on the map. The
 * suites seat a real Headquarters on the engine-truthful board (see
 * tests/harness/hqWorld.ts), so the placement maps, the territory and the
 * obstruction grid are the real ones the plan reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake, type Methods, override } from "./harness/fakes.ts";
import {
	doorCalls, doorManagers, ENEMY, type HqWorld, type HqWorldOptions, layNavalPassMap, makeHqEntity,
	makeHqWorld, MAP_CELLS, PASS_RATIO, passLand, passShore, passWater, PLAYER, seatHQ,
	structureTemplate, TERRITORY_CELL, territoryCellAt
} from "./harness/hqWorld.ts";

import { landRegion, seaRegion, worldPos } from "../adapter/brands.ts";
import { BaseManager } from "../decision/baseManager.ts";
import type { Headquarters } from "../decision/headquarters.ts";
import type { DefenseArmy } from "../execution/defenseArmy.ts";
import { type BuildingPosition, ConstructionPlan } from "../execution/queueplanBuilding.ts";
import * as mapMask from "../world/mapMask.ts";

/** a town seated on the plain, its territory read once */
function seat(worldOptions: Partial<HqWorldOptions> = {})
{
	const world = makeHqWorld(worldOptions);
	const hq = seatHQ(world, { "stubs": doorManagers });
	hq.updateTerritories(world.gameState);
	// as GameState.findBuilder (common-api gamestate.js 846): the first unit of
	// ours whose buildable list holds the card
	(world.gameState as unknown as { findBuilder(t: string): unknown }).findBuilder = (template: string) =>
		[...world.ents.values()].find((e) => e.owner() === PLAYER && e.hasClass("Unit") &&
			((e as unknown as { buildableEntities(civ: string): string[] | undefined }).buildableEntities("athen") ?? [])
				.includes(template));
	return { world, hq };
}

/** a structure card the civ owns, under its {civ}-applied name */
function card(world: HqWorld, name: string, detail: Parameters<typeof structureTemplate>[1] = {}): string
{
	const full = "structures/athen/" + name;
	// a common-api Template also answers its own name (and keeps it raw, as
	// _templateName, which the original reads) and its generic name
	world.templates[full] = fake<CommonTemplate>({ ...structureTemplate(full, { "classes": ["Structure"], ...detail }),
		"templateName": () => full, "_templateName": full, "genericName": () => name });
	return full;
}

/** a builder of ours who knows the named cards and records what it lays */
function builder(world: HqWorld, hq: Headquarters, buildable: string[], laid: unknown[][] = [])
{
	const ent = world.addEntity(makeHqEntity({
		"id": 9001, "owner": PLAYER, "position": [30, 30], "classes": ["Unit", "Support", "Worker"]
	}, {
		"buildableEntities": () => buildable,
		"construct": (...args: unknown[]) => laid.push(args)
	}));
	hq.buildManager.init(world.gameState);
	return { ent, laid };
}

/** a standing structure of ours */
function structure(world: HqWorld, id: number, position: [number, number], classes: string[],
	methods: Methods = {}, templateName = "structures/athen/" + classes[classes.length - 1].toLowerCase())
{
	return world.addEntity(makeHqEntity({ id, "owner": PLAYER, position, "classes": ["Structure", ...classes], templateName },
		methods));
}

const distance = (pos: BuildingPosition | false, to: [number, number]): number =>
	pos ? Math.hypot(pos.x - to[0], pos.z - to[1]) : NaN;

/** the territory cell under a map position */
describe("a building plan asked whether it may start: canStart", () =>
{
	it("waits while another building already started this turn", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		builder(world, hq, [barracks]);
		hq.turnCache.buildingBuilt = true;

		assert.equal(new ConstructionPlan(world.gameState, barracks).canStart(world.gameState), false);
	});

	it("waits while the civ cannot build the card", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"], "available": false });
		builder(world, hq, [barracks]);

		assert.equal(new ConstructionPlan(world.gameState, barracks).canStart(world.gameState), false);
	});

	it("waits while the town does not need the house yet", () =>
	{
		const { world, hq } = seat({ "population": 20, "populationLimit": 40 });
		const house = card(world, "house", { "classes": ["Structure", "House"] });
		builder(world, hq, [house]);
		const plan = new ConstructionPlan(world.gameState, house);
		plan.goRequirement = "houseNeeded";

		assert.equal(plan.canStart(world.gameState), false, "20 free slots");
	});

	it("waits while no builder of ours knows the card, and starts once one does", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		hq.buildManager.init(world.gameState);
		const plan = new ConstructionPlan(world.gameState, barracks);
		assert.ok(!plan.canStart(world.gameState), "no builder yet");

		builder(world, hq, [barracks]);
		assert.equal(plan.canStart(world.gameState), true);
	});
});

describe("a house plan asked whether the town needs it: isGo", () =>
{
	/** a town where houses can be built, at the given population and cap */
	function town(population: number, populationLimit: number, populationMax = 300)
	{
		const s = seat({ population, populationLimit, populationMax });
		const house = card(s.world, "house", { "classes": ["Structure", "House", "Village"], "popBonus": 10 });
		builder(s.world, s.hq, [house]);
		const plan = new ConstructionPlan(s.world.gameState, house);
		plan.goRequirement = "houseNeeded";
		return { ...s, house, plan };
	}

	it("any plan without a house requirement is always wanted", () =>
	{
		const { world } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		assert.equal(new ConstructionPlan(world.gameState, barracks).isGo(world.gameState), true);
	});

	it("a town that can build no house waits", () =>
	{
		const { world } = seat({ "population": 20, "populationLimit": 25 });
		const plan = new ConstructionPlan(world.gameState, card(world, "house", { "classes": ["Structure", "House"] }));
		plan.goRequirement = "houseNeeded";

		assert.equal(plan.isGo(world.gameState), false, "no builder knows a house or an apartment");
	});

	it("a town whose houses already reach the map's population cap waits", () =>
	{
		const { world, plan } = town(150, 200, 200);
		assert.equal(plan.isGo(world.gameState), false);
	});

	it("a small town builds when ten slots or fewer are free, not before", () =>
	{
		assert.equal(town(20, 25).plan.isGo(town(20, 25).world.gameState), true, "5 free");
		const roomy = town(20, 40);
		assert.equal(roomy.plan.isGo(roomy.world.gameState), false, "20 free");
	});

	it("a house already rising counts its slots as free", () =>
	{
		const { world, plan, house } = town(20, 25);
		world.addEntity(makeHqEntity({
			"id": 9101, "owner": PLAYER, "position": [80, 80],
			"classes": ["Structure", "House"], "templateName": "foundation|" + house
		}, { "foundationProgress": () => 0.2 }));

		assert.equal(plan.isGo(world.gameState), false, "5 free plus the rising house's 10");
	});

	it("a growing town builds ahead: up to 15 free past 30 people, up to 21 past 55", () =>
	{
		const mid = town(40, 54);
		assert.equal(mid.plan.isGo(mid.world.gameState), true, "14 free past 30");
		const midRoomy = town(40, 56);
		assert.equal(midRoomy.plan.isGo(midRoomy.world.gameState), false, "16 free past 30");
		const big = town(60, 80);
		assert.equal(big.plan.isGo(big.world.gameState), true, "20 free past 55");
		const bigRoomy = town(60, 82);
		assert.equal(bigRoomy.plan.isGo(bigRoomy.world.gameState), false, "22 free past 55");
	});

	it("a town saving its resources holds back to ten free slots", () =>
	{
		const { world, hq, plan } = town(60, 75);
		hq.saveResources = true;
		assert.equal(plan.isGo(world.gameState), false, "15 free is enough while saving");
	});
});

describe("a building plan laying its foundation: start", () =>
{
	it("lays the foundation where the town has room, and books the turn", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		const { laid } = builder(world, hq, [barracks]);
		const plan = new ConstructionPlan(world.gameState, barracks);

		plan.start(world.gameState);

		assert.equal(laid.length, 1);
		const [type, x, z, angle, metadata] = laid[0] as [string, number, number, number, Record<string, unknown>];
		assert.equal(type, barracks);
		assert.ok(x > 0 && z > 0);
		assert.equal(angle, 3 * Math.PI / 4);
		assert.deepEqual(metadata, { "base": hq.baseAtIndex(territoryCellAt([x, z])), "access": 2 },
			"the foundation answers to the town it stands in, on its land");
		assert.equal(hq.turnCache.buildingBuilt, true, "no other building starts this turn");
	});

	it("keeps the town the plan was made for", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		const { laid } = builder(world, hq, [barracks]);
		const plan = new ConstructionPlan(world.gameState, barracks, { "base": 2, "role": "keep" });

		plan.start(world.gameState);

		assert.deepEqual(laid[0][4], { "base": 2, "role": "keep", "access": 2 });
	});

	it("does nothing when no unit of ours can lay it", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		hq.buildManager.init(world.gameState);

		new ConstructionPlan(world.gameState, barracks).start(world.gameState);

		assert.notEqual(hq.turnCache.buildingBuilt, true, "another building may still start");
	});

	it("marks the card unbuildable for a while when the town has no room for it", () =>
	{
		const { world, hq } = seat();
		// wider than the whole town
		const wonder = card(world, "wonder", { "classes": ["Structure", "Wonder"], "obstruction": { "min": 300, "max": 400 } });
		const { laid } = builder(world, hq, [wonder]);

		new ConstructionPlan(world.gameState, wonder).start(world.gameState);

		assert.deepEqual(laid, []);
		assert.equal(hq.buildManager.isUnbuildable(world.gameState, wonder), true);
	});

	it("gives a queue its priority back once the building it waited for starts", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		builder(world, hq, [barracks]);
		const queueManager = world.ai.queueManager;
		const usual = queueManager.priorities.villager;
		queueManager.changePriority("villager", 0);
		const plan = new ConstructionPlan(world.gameState, barracks);
		plan.queueToReset = "villager";

		plan.start(world.gameState);

		assert.equal(queueManager.priorities.villager, usual);
		void hq;
	});

	it("drops a second market that a market built since has made pointless", () =>
	{
		const { world, hq } = seat();
		const market = card(world, "market", { "classes": ["Structure", "Trade", "Market"] });
		const { laid } = builder(world, hq, [market]);
		structure(world, 9201, [200, 200], ["Trade", "Market"]);
		hq.tradeManager.isNewMarketWorth = () => false;
		const plan = new ConstructionPlan(world.gameState, market, { "expectedGain": 12 });

		plan.start(world.gameState);

		assert.deepEqual(laid, []);
		assert.ok(doorCalls(hq.tradeManager).some(([m]) => m === "checkRoutes"), "the routes are reckoned anew");
	});

	it("builds a first market without second-guessing its gain", () =>
	{
		const { world, hq } = seat();
		const market = card(world, "market", { "classes": ["Structure", "Trade", "Market"] });
		const { laid } = builder(world, hq, [market]);
		hq.tradeManager.isNewMarketWorth = () => false;

		new ConstructionPlan(world.gameState, market, { "expectedGain": 12 }).start(world.gameState);

		assert.equal(laid.length, 1);
	});

	it("asks the fleet for a passage when the building stands near a far landing", () =>
	{
		const { world, hq } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });
		builder(world, hq, [barracks]);

		new ConstructionPlan(world.gameState, barracks, { "proximity": worldPos(300, 300) }).start(world.gameState);

		assert.ok(doorCalls(hq.navalManager).some(([m]) => m === "createTransportIfNeeded"));
	});
});

describe("where the special buildings go: findGoodPosition", () =>
{
	it("a storehouse for a town goes where the town's best wood is", () =>
	{
		const { world, hq } = seat();
		const store = card(world, "storehouse", { "classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood", "stone", "metal"] });
		builder(world, hq, [store]);
		const wood = world.gameState.sharedScript
			.resourceMaps.wood.map;
		for (const dx of [-8, 0, 8])
			for (const dz of [-8, 0, 8])
				wood[territoryCellAt([200 + dx, 200 + dz])] = 100;

		const pos = new ConstructionPlan(world.gameState, store, { "base": 2, "type": "wood" }).findGoodPosition(world.gameState);

		assert.ok(distance(pos, [200, 200]) < 40, `by the trees, got ${JSON.stringify(pos)}`);
		assert.equal(pos && pos.base, 2);
	});

	it("a civic centre goes where the office claims new ground, for no town yet", () =>
	{
		const { world, hq } = seat();
		const cc = card(world, "civil_centre", { "classes": ["Structure", "CivCentre"] });
		hq.findStrategicCCLocation = () => worldPos(120, 240);

		assert.deepEqual(new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState),
			{ "x": 120, "z": 240, "angle": 3 * Math.PI / 4, "base": 0 });
	});

	it("a civic centre for a resource goes where the office finds that resource", () =>
	{
		const { world, hq } = seat();
		const cc = card(world, "civil_centre", { "classes": ["Structure", "CivCentre"] });
		const asked: unknown[] = [];
		hq.findEconomicCCLocation = (_g: unknown, _t: unknown, resource: unknown, proximity: unknown) =>
		{
			asked.push([resource, proximity]);
			return worldPos(250, 60);
		};

		const pos = new ConstructionPlan(world.gameState, cc, { "resource": "stone", "proximity": worldPos(240, 70) })
			.findGoodPosition(world.gameState);

		assert.deepEqual(asked, [["stone", [240, 70]]]);
		assert.deepEqual(pos, { "x": 250, "z": 60, "angle": 3 * Math.PI / 4, "base": 0 });
	});

	it("a civic centre with no ground left, and no dock to reach more, is not placed", () =>
	{
		const { world, hq } = seat();
		const cc = card(world, "civil_centre", { "classes": ["Structure", "CivCentre"] });
		hq.findStrategicCCLocation = () => undefined;

		assert.equal(new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState), false);
	});

	it("a tower goes where the office wants it defended, for the town there", () =>
	{
		const { world, hq } = seat();
		const tower = card(world, "defense_tower", { "classes": ["Structure", "Tower"] });
		hq.findDefensiveLocation = () => [96, 160, 2];

		assert.deepEqual(new ConstructionPlan(world.gameState, tower).findGoodPosition(world.gameState),
			{ "x": 96, "z": 160, "angle": 3 * Math.PI / 4, "base": 2 });
	});

	it("a tower with nowhere worth defending is not placed", () =>
	{
		const { world, hq } = seat();
		const tower = card(world, "defense_tower", { "classes": ["Structure", "Tower"] });
		hq.findDefensiveLocation = () => undefined;

		assert.equal(new ConstructionPlan(world.gameState, tower).findGoodPosition(world.gameState), false);
	});

	it("a first fortress with nowhere to defend still goes up inside the town", () =>
	{
		const { world, hq } = seat();
		const fortress = card(world, "fortress", { "classes": ["Structure", "Fortress"] });
		hq.findDefensiveLocation = () => undefined;

		const pos = new ConstructionPlan(world.gameState, fortress).findGoodPosition(world.gameState);
		assert.ok(pos, "the standard placement finds room");

		structure(world, 9301, [250, 250], ["Fortress"]);
		assert.equal(new ConstructionPlan(world.gameState, fortress).findGoodPosition(world.gameState), false,
			"a second one waits for a spot worth defending");
	});

	it("a market goes where the office expects the best trade, remembering the gain", () =>
	{
		const { world, hq } = seat();
		const market = card(world, "market", { "classes": ["Structure", "Trade", "Market"] });
		hq.findMarketLocation = () => [280, 40, 2, 17];
		const plan = new ConstructionPlan(world.gameState, market);

		assert.deepEqual(plan.findGoodPosition(world.gameState), { "x": 280, "z": 40, "angle": 3 * Math.PI / 4, "base": 2 });
		assert.equal(plan.metadata?.expectedGain, 17);
	});

	it("a market with no trade spot found is not placed, and one outside every town goes inside one", () =>
	{
		const { world, hq } = seat();
		const market = card(world, "market", { "classes": ["Structure", "Trade", "Market"] });
		hq.findMarketLocation = () => false;
		assert.equal(new ConstructionPlan(world.gameState, market).findGoodPosition(world.gameState), false);

		hq.findMarketLocation = () => [280, 40, 0, 17];
		const pos = new ConstructionPlan(world.gameState, market).findGoodPosition(world.gameState);
		assert.ok(pos && pos.base === 2, "the standard placement puts it in the town");
	});
});

/**
 * A board where the home town holds only the west half, and a colony founded
 * in the far corner whose ground became ours when its centre went up — as the
 * territory map changes in a game, so the office hands the new cells to the
 * colony.
 */
function colonyBoard()
{
	const s = seat({ "territoryOwner": (ix: number) => ix < MAP_CELLS / 2 ? PLAYER : 0 });
	const cc = s.world.addEntity(makeHqEntity({
		"id": 9501, "owner": PLAYER, "position": [260, 260],
		"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
	}));
	const colony = s.hq.basesManager.createBase(s.world.gameState, cc, BaseManager.STATE_WITH_ANCHOR);
	for (let ix = 28; ix < MAP_CELLS; ++ix)
		for (let iz = 28; iz < MAP_CELLS; ++iz)
			s.world.map.setTerritoryOwner(ix, iz, PLAYER);
	s.hq.updateTerritories(s.world.gameState);
	return { ...s, colony };
}

describe("where the town puts an ordinary building: findGoodPosition", () =>
{
	it("a building with a wanted spot goes as near it as there is room", () =>
	{
		const { world } = seat();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks, undefined, worldPos(200, 120)).findGoodPosition(world.gameState);

		assert.ok(distance(pos, [200, 120]) < 2 * TERRITORY_CELL, JSON.stringify(pos));
	});

	it("a house goes up among the houses already standing", () =>
	{
		const { world } = seat();
		structure(world, 9401, [200, 200], ["House"]);
		const house = card(world, "house", { "classes": ["Structure", "House"] });

		const pos = new ConstructionPlan(world.gameState, house).findGoodPosition(world.gameState);

		assert.ok(distance(pos, [200, 200]) < 60, JSON.stringify(pos));
	});

	it("a field goes up beside a farmstead", () =>
	{
		const { world } = seat();
		structure(world, 9411, [220, 100], ["Farmstead"], {
			"resourceDropsiteTypes": () => ["food"], "isResourceDropsite": (r?: string) => !r || r === "food"
		});
		const field = card(world, "field", { "classes": ["Structure", "Field"] });

		const pos = new ConstructionPlan(world.gameState, field).findGoodPosition(world.gameState);

		assert.ok(distance(pos, [220, 100]) < 80, JSON.stringify(pos));
	});

	it("a farmstead stays out of the woods", () =>
	{
		const { world } = seat();
		const wood = world.gameState.sharedScript
			.resourceMaps.wood.map;
		// woods cover the whole west half, where it would otherwise stand
		for (let j = 0; j < wood.length; ++j)
			if (j % MAP_CELLS < MAP_CELLS / 2)
				wood[j] = 300;
		const farmstead = card(world, "farmstead", { "classes": ["Structure", "Farmstead"], "dropsiteTypes": ["food"] });

		const pos = new ConstructionPlan(world.gameState, farmstead).findGoodPosition(world.gameState);

		assert.ok(pos && pos.x >= MAP_CELLS * TERRITORY_CELL / 2, JSON.stringify(pos));
	});

	it("a building for one town is placed inside that town", () =>
	{
		const { world, hq, colony } = colonyBoard();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks, { "base": colony.ID }).findGoodPosition(world.gameState);

		assert.ok(pos, "the colony has room");
		assert.equal(hq.baseAtIndex(territoryCellAt([pos.x, pos.z])), colony.ID);
	});

	it("a building with a favoured town goes there when it can", () =>
	{
		const { world, hq, colony } = colonyBoard();
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks, { "favoredBase": colony.ID }).findGoodPosition(world.gameState);

		assert.ok(pos && hq.baseAtIndex(territoryCellAt([pos.x, pos.z])) === colony.ID, JSON.stringify(pos));
	});

	it("a military building goes to the town the office picks for its army", () =>
	{
		const { world, hq, colony } = colonyBoard();
		hq.findBestBaseForMilitary = () => colony.ID;
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks, { "militaryBase": true }).findGoodPosition(world.gameState);

		assert.ok(pos && hq.baseAtIndex(territoryCellAt([pos.x, pos.z])) === colony.ID, JSON.stringify(pos));
	});

	it("a market is pushed to the town's border, to stretch the trade route", () =>
	{
		// past the first phase, where other buildings keep off the border
		const { world, hq } = seat({ "phase": 2 });
		const market = card(world, "market", { "classes": ["Structure", "Trade", "Market"] });
		hq.findMarketLocation = () => [280, 40, 0, 17];

		const pos = new ConstructionPlan(world.gameState, market, { "base": 2 }).findGoodPosition(world.gameState);

		assert.ok(pos && hq.borderMap.map[territoryCellAt([pos.x, pos.z])] & mapMask.border, JSON.stringify(pos));
	});

	it("past the first phase, a building with no arrows keeps off the town's border", () =>
	{
		const { world, hq } = seat({ "phase": 2 });
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks).findGoodPosition(world.gameState);

		assert.ok(pos && !(hq.borderMap.map[territoryCellAt([pos.x, pos.z])] & mapMask.fullBorder), JSON.stringify(pos));
	});

	it("a building is kept away from an invading army", () =>
	{
		const { world, hq } = seat();
		const foe: [number, number] = [60, 20];
		hq.defenseManager.armies.push(fake<DefenseArmy>({ "foePosition": foe }));
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks).findGoodPosition(world.gameState);

		assert.ok(distance(pos, foe) > Math.sqrt(12000) - TERRITORY_CELL, JSON.stringify(pos));
	});

	it("a building for one town is kept away from an invading army too", () =>
	{
		const { world, hq } = seat();
		const foe: [number, number] = [60, 20];
		hq.defenseManager.armies.push(fake<DefenseArmy>({ "foePosition": foe }));
		const barracks = card(world, "barracks", { "classes": ["Structure", "Military"] });

		const pos = new ConstructionPlan(world.gameState, barracks, { "base": 2 }).findGoodPosition(world.gameState);

		assert.ok(distance(pos, foe) > Math.sqrt(12000) - TERRITORY_CELL, JSON.stringify(pos));
	});

	it("a temple leaves the ground around a farmstead to the fields", () =>
	{
		const { world } = seat();
		structure(world, 9421, [20, 20], ["Farmstead"], {
			"resourceDropsiteTypes": () => ["food"], "isResourceDropsite": (r?: string) => !r || r === "food"
		});
		const temple = card(world, "temple", { "classes": ["Structure", "Temple"] });

		const pos = new ConstructionPlan(world.gameState, temple, { "base": 2 }).findGoodPosition(world.gameState);

		// with no farmstead the temple takes the corner (7, 7)
		assert.ok(distance(pos, [20, 20]) > 60, JSON.stringify(pos));
	});

	it("a first fortress keeps away from the houses", () =>
	{
		const { world, hq } = seat();
		structure(world, 9431, [60, 60], ["House"]);
		// the game's fortress template carries the GarrisonFortress class
		const fortress = card(world, "fortress", { "classes": ["Structure", "Fortress", "GarrisonFortress"] });
		hq.findDefensiveLocation = () => undefined;

		const pos = new ConstructionPlan(world.gameState, fortress).findGoodPosition(world.gameState);

		assert.ok(distance(pos, [60, 60]) > 100, JSON.stringify(pos));
	});

	it("a first house in a cramped town settles for an ordinary spot", () =>
	{
		// only a strip 16 m wide is buildable: no room for the extra space a
		// first house looks for, room enough for the house itself
		const { world } = seat({ "passabilityData": (px: number) => px >= 20 && px < 28 ? passLand : passWater });
		const house = card(world, "house", { "classes": ["Structure", "House"], "obstruction": { "min": 2, "max": 4 } });

		const pos = new ConstructionPlan(world.gameState, house).findGoodPosition(world.gameState);

		assert.ok(pos && pos.x >= 40 && pos.x < 56, JSON.stringify(pos));
	});
});

/**
 * A coast: our land in the west (land region 2), the sea from x = 160
 * eastwards (sea region 5). Docks stand on the shore strip, 16 m either side
 * of the waterline (144 <= x < 176): the only tiles whose building-shore bit is
 * clear, as the engine leaves it for land and shallows near a shore. `island`
 * adds a second land (region 3) east of x = 240, across the sea.
 */
function coast(options: { island?: boolean; phase?: number; territoryOwner?: (ix: number, iz: number) => number } = {})
{
	const islandAt = options.island ? 120 : Infinity;	// passability cells: x = 240
	const landOf = (px: number): number => px < 80 ? 2 : px >= islandAt ? 3 : 0;
	const s = seat({
		"phase": options.phase ?? 2,
		"territoryOwner": options.territoryOwner,
		"landPassMap": landOf,
		"passabilityData": (px: number) => px >= 72 && px < 88 || px >= islandAt - 8 && px < islandAt + 8 ? passShore :
			landOf(px) >= 2 ? passLand : passWater,
		"regionTypes": { 2: "land", 3: "land", 5: "water" },
		"trajectories": { "2,3": [2, 5, 3], "3,2": [3, 5, 2] }
	});
	const width = MAP_CELLS * PASS_RATIO;
	const naval = new Uint8Array(width * width);
	for (let k = 0; k < naval.length; ++k)
	{
		const px = k % width;
		naval[k] = landOf(px) < 2 ? 5 : 0;
	}
	layNavalPassMap(s.world, naval);
	Object.assign(s.world.ai.accessibility, { "height": width, "regionSize": { 2: 20000, 3: 6000, 5: 20000 } });
	s.hq.landRegions = options.island ? { 2: true, 3: true } : { 2: true };
	s.hq.navalMap = true;
	const dock = card(s.world, "dock", {
		"classes": ["Structure", "Dock"], "placement": "shore", "territories": ["own", "ally", "neutral"],
		"dropsiteTypes": ["food", "wood", "stone", "metal"], "obstruction": { "min": 9, "max": 12.7 },
		"getPaths": { "Footprint": { "Square": { "@width": "18", "@depth": "18" } } }
	});
	return { ...s, dock };
}

/** a dock plan as the naval manager queues one: for a land of ours, on a sea */
const navalDock = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
	({ "land": { 2: true }, "sea": 5, ...extra });

describe("where a dock goes: findDockPosition", () =>
{
	it("a dock goes on our coast, facing the open sea", () =>
	{
		const { world, dock } = coast();

		const pos = new ConstructionPlan(world.gameState, dock, navalDock()).findGoodPosition(world.gameState);

		assert.ok(pos, "the coast has room");
		assert.ok(pos.x >= 150 && pos.x < 170, `on the shore strip, got ${JSON.stringify(pos)}`);
		assert.equal(pos.access, 2, "reached from our land");
		// the dock's front points along +x, into the sea
		assert.ok(Math.abs(Math.sin(pos.angle) - 1) < 0.3, `facing east, got angle ${pos.angle}`);
	});

	it("a dock is laid along the shore, the foundation nudged until one fits", () =>
	{
		const { world, hq, dock } = coast();
		const { laid } = builder(world, hq, [dock]);

		new ConstructionPlan(world.gameState, dock, navalDock()).start(world.gameState);

		// the shift goes to the cell size (8) in steps of 2, both ways
		assert.equal(laid.length, 9);
		assert.ok(laid.every((args) => (args[4] as { access: number }).access === 2), "the dock answers to our land");
	});

	it("a land with no coast gets no dock", () =>
	{
		const { world } = seat();
		const dock = card(world, "dock", {
			"classes": ["Structure", "Dock"], "placement": "shore", "territories": ["own", "ally", "neutral"],
			"obstruction": { "min": 9, "max": 12.7 },
			"getPaths": { "Footprint": { "Square": { "@width": "18", "@depth": "18" } } }
		});

		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock()).findGoodPosition(world.gameState), false);
	});

	it("a dock waits for a coast within reach of our frontier", () =>
	{
		// our ground stops at x = 40, 120 m short of the coast
		const far = coast({ "territoryOwner": (ix: number) => ix < 5 ? PLAYER : 0 });
		assert.equal(new ConstructionPlan(far.world.gameState, far.dock, navalDock()).findGoodPosition(far.world.gameState), false);

		// our ground stops at x = 120, 40 m short of it
		const near = coast({ "territoryOwner": (ix: number) => ix < 15 ? PLAYER : 0 });
		assert.ok(new ConstructionPlan(near.world.gameState, near.dock, navalDock()).findGoodPosition(near.world.gameState));
	});

	it("a dock goes by the trees along the coast", () =>
	{
		const { world, dock } = coast();
		const wood = world.gameState.sharedScript
			.resourceMaps.wood.map;
		for (let ix = 16; ix < 20; ++ix)
			for (let iz = 30; iz < 34; ++iz)
				wood[ix + iz * MAP_CELLS] = 200;

		const pos = new ConstructionPlan(world.gameState, dock, navalDock()).findGoodPosition(world.gameState);

		assert.ok(pos && pos.z >= 200 && pos.z < 300, `by the woods at z 240-272, got ${JSON.stringify(pos)}`);
	});

	it("a first-phase town waits rather than build a dock on a narrow inlet", () =>
	{
		const inlet = (phase: number) =>
		{
			const s = coast({ phase });
			// the sea is only 24 m wide: land again from x = 184
			const width = MAP_CELLS * PASS_RATIO;
			for (let k = 0; k < s.world.map.landPassMap.length; ++k)
				if (k % width >= 92)
				{
					s.world.map.landPassMap[k] = 3;
					s.world.map.navalPassMap[k] = 0;
				}
			return s;
		};
		const early = inlet(1);
		assert.equal(new ConstructionPlan(early.world.gameState, early.dock, navalDock()).findGoodPosition(early.world.gameState), false);
		const later = inlet(2);
		assert.ok(new ConstructionPlan(later.world.gameState, later.dock, navalDock()).findGoodPosition(later.world.gameState));
	});

	it("a dock for a given sea is not put on another", () =>
	{
		const { world, dock } = coast();
		assert.ok(new ConstructionPlan(world.gameState, dock, navalDock({ "sea": 5 })).findGoodPosition(world.gameState));
		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock({ "sea": 6 })).findGoodPosition(world.gameState), false);
	});

	// the opening strategy queues it with a sea and the landing point, no land
	it("a first dock with no ships yet goes as near the landing point as it can", () =>
	{
		const { world, dock } = coast();
		override(world.ai.accessibility, { "getAccessValue": (p: [number, number]) => p[0] < 160 ? 2 : 0 });

		const north = new ConstructionPlan(world.gameState, dock, { "sea": seaRegion(5), "proximity": worldPos(100, 280) }).findGoodPosition(world.gameState);
		const south = new ConstructionPlan(world.gameState, dock, { "sea": seaRegion(5), "proximity": worldPos(100, 40) }).findGoodPosition(world.gameState);

		// (the map's edge costs a little, so neither reaches the corner itself)
		assert.ok(north && south && north.z - south.z > 120, `${JSON.stringify(north)} vs ${JSON.stringify(south)}`);
	});

	it("a first dock is not put on a land too small to settle", () =>
	{
		const { world, dock } = coast();
		override(world.ai.accessibility, { "getAccessValue": (p: [number, number]) => p[0] < 160 ? 2 : 0 });
		world.ai.accessibility.regionSize[2] = 3000;

		assert.equal(new ConstructionPlan(world.gameState, dock, { "sea": seaRegion(5), "proximity": worldPos(100, 280) })
			.findGoodPosition(world.gameState), false);
	});

	it("no dock is put where enemy arrows reach", () =>
	{
		const { world, dock } = coast();
		// an enemy tower covering the whole coast
		world.addEntity(makeHqEntity({
			"id": 9601, "owner": ENEMY, "position": [200, 160], "classes": ["Structure", "Tower"]
		}, { "attackRange": () => ({ "max": 400 }), "attackTypes": () => ["Ranged"], "hasDefensiveFire": () => true }));

		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock()).findGoodPosition(world.gameState), false);
	});
});

describe("which way a dock faces: getDockAngle", () =>
{
	// coast(): our land west of x = 160, the sea east of it to the map's edge
	// at x = 320. A dock of size 9 looks at 16 points around its spot, then at
	// 2, 3 and 4 times that distance, for the longest run of water.

	it("a dock on the shore faces the open sea", () =>
	{
		const { world, dock } = coast();
		const plan = new ConstructionPlan(world.gameState, dock, navalDock());

		// at x = 162 the points to the east and straight north and south are
		// water (8 of 16, then the one at angle 0): the run 8..15, 0 centres
		// on point 12, so the angle is -(12/16)·2π, the dock facing +x
		const angle = plan.getDockAngle(world.gameState, 162, 100, 9);
		assert.equal(angle, -3 * Math.PI / 2);
	});

	it("a spot on dry land gets no angle", () =>
	{
		const { world, dock } = coast();
		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock()).getDockAngle(world.gameState, 100, 100, 9), false);
	});

	it("open water with no shore within four times the dock's size gets no angle", () =>
	{
		const { world, dock } = coast();
		// every point is water out to 36 from x = 240: no shoreline to face
		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock()).getDockAngle(world.gameState, 240, 160, 9), false);
	});

	it("at the map's edge the edge counts as the shore", () =>
	{
		const { world, dock } = coast();
		// at x = 318 the points east of x = 320 are off the map and skipped:
		// the water left runs over points 0..8 and the dock faces west, -π/2
		const angle = new ConstructionPlan(world.gameState, dock, navalDock()).getDockAngle(world.gameState, 318, 160, 9);
		assert.equal(angle, -Math.PI / 2);
	});

	it("a puddle with no water around it gets no angle", () =>
	{
		const { world, dock } = coast();
		const accessibility = world.ai.accessibility;
		// one cell of the sea's region inland, at (100, 100), with land all around
		world.map.navalPassMap[50 + 50 * accessibility.width] = 5;
		assert.equal(new ConstructionPlan(world.gameState, dock, navalDock()).getDockAngle(world.gameState, 100, 100, 9), false);
	});
});

describe("a town out of ground sends a dock to an island: buildOverseaDock", () =>
{
	/**
	 * The coast with an island across the sea that no one holds: our own
	 * ground stops at the island's shore, our one dock already stands on our
	 * coast, and the office finds no more ground for a civic centre on our land.
	 */
	function islandWorld(withDock = true)
	{
		const s = coast({ "island": true, "territoryOwner": (ix: number) => ix < 28 ? PLAYER : 0 });
		Object.assign(s.world.ai.accessibility, {
			// the engine's per-region sizes, an array indexed by region
			"regionSize": [0, 0, 20000, 6000, 0, 20000]
		});
		s.world.gameState.sharedScript.playersData ??= [];
		if (withDock)
			structure(s.world, 9701, [160, 160], ["Dock"], {}, "structures/athen/dock").setMetadata(PLAYER, "sea", seaRegion(5));
		const cc = card(s.world, "civil_centre", { "classes": ["Structure", "CivCentre"] });
		s.hq.findStrategicCCLocation = () => undefined;
		const { laid } = builder(s.world, s.hq, [s.dock]);
		return { ...s, cc, laid };
	}

	it("lays a dock on the island's shore, and keeps the civic-centre plan as it was", () =>
	{
		const { world, cc, dock, laid } = islandWorld();
		const plan = new ConstructionPlan(world.gameState, cc, { "role": "expansion" });

		assert.equal(plan.findGoodPosition(world.gameState), false, "the civic centre itself waits");

		assert.equal(laid.length, 9, "the dock, nudged along the shore");
		for (const [type, x, , , metadata] of laid as Array<[string, number, number, number, Record<string, unknown>]>)
		{
			assert.equal(type, dock);
			assert.ok(x >= 224 && x < 256, `on the island's shore, got x = ${x}`);
			assert.deepEqual(metadata.land, { 3: true });
			assert.equal(metadata.oversea, true);
		}
		assert.equal(plan.template.templateName(), cc);
		assert.deepEqual(plan.metadata, { "role": "expansion" });
	});

	it("sends no dock oversea before the town has a dock of its own", () =>
	{
		const { world, cc, laid } = islandWorld(false);
		new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState);
		assert.deepEqual(laid, []);
	});

	it("sends no dock to an island an enemy already holds", () =>
	{
		const { world, cc, laid } = islandWorld();
		world.addEntity(makeHqEntity({
			"id": 9711, "owner": ENEMY, "position": [290, 160],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "access": 3 }));

		new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState);

		assert.deepEqual(laid, []);
	});

	it("sends no dock to an island where we already have one", () =>
	{
		const { world, cc, laid } = islandWorld();
		structure(world, 9721, [250, 300], ["Dock"], {}, "structures/athen/dock").setMetadata(PLAYER, "access", landRegion(3));

		new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState);

		assert.deepEqual(laid, []);
	});

	it("sends a dock to an island an ally holds", () =>
	{
		const { world, cc, laid } = islandWorld();
		const pd = world.gameState.playerData;
		pd.isAlly[3] = true;
		pd.isMutualAlly[3] = true;
		pd.isEnemy[3] = false;
		world.addEntity(makeHqEntity({
			"id": 9741, "owner": 3, "position": [290, 160],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "access": 3 }));

		new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState);

		assert.equal(laid.length, 9);
	});

	it("puts the island's dock on the side nearer our town than the enemy's", () =>
	{
		const { world, cc, laid } = islandWorld();
		// an enemy town on our own land, up the coast
		world.addEntity(makeHqEntity({
			"id": 9731, "owner": ENEMY, "position": [130, 310],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "access": 2 }));

		new ConstructionPlan(world.gameState, cc).findGoodPosition(world.gameState);

		assert.ok(laid.length > 0);
		const z = (laid[0] as number[])[2];
		assert.ok(z < 200, `away from the enemy's corner, got z = ${z}`);
	});

	// only the port passes: the builder registry the office trusts can still
	// list a dock builder whose last unit died this turn. The original then
	// calls construct on no builder and throws, with the plan still wearing the
	// dock's template; the port gives the civic-centre plan its template and
	// metadata back and lays nothing
	it("keeps the civic-centre plan intact when no unit is left to lay the island's dock", () =>
	{
		const { world, cc, laid } = islandWorld();
		world.removeEntity(9001);	// the builder dies; the registry has not heard yet
		const plan = new ConstructionPlan(world.gameState, cc, { "role": "expansion" });

		assert.equal(plan.findGoodPosition(world.gameState), false);

		assert.deepEqual(laid, []);
		assert.equal(plan.template.templateName(), cc);
		assert.deepEqual(plan.metadata, { "role": "expansion" });
	});
});
