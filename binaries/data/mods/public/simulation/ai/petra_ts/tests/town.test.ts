/**
 * The town (execution/town.ts), as the plans and workers ask it: the gather
 * rates the queues want and the resource most needed, whether units may be
 * trained, the danger of a spot (an invading column, a tower's fire), and the
 * sea between two lands. The town is a real office's (tests/harness/hqSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fake } from "./harness/fakes.ts";

import { seat } from "./harness/hqSeat.ts";
import { ENEMY, doorManagers, makeHqEntity, makeHqWorld, seatHQ, type HqWorld } from "./harness/hqWorld.ts";

import { landRegion, worldPos } from "../adapter/brands.ts";
import type { DefenseArmy } from "../execution/defenseArmy.ts";

describe("headquarters and the queues: what the workers should gather", () =>
{
	it("reads the wanted rates the queue manager books", async () =>
	{
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// on turn 0 the wanted rates are the config's first-turn table
		const rates = hq.town.GetWantedGatherRates(world.gameState);
		assert.deepEqual(rates, { food: 10, wood: 10, stone: 0, metal: 0 });
		assert.equal(hq.town.GetWantedGatherRates(world.gameState), rates); // cached
	});
});

describe("headquarters and the next worker: the resource that starves first", () =>
{
	it("orders the resources by how far the gatherers fall short", async () =>
	{
		const world = makeHqWorld();
		const hq = seatHQ(world, { stubs: doorManagers });

		// the gather-rate roll is the bases manager's ledger; the suite hands
		// HQ current rates and records that it asked for them (the roll itself
		// is the basesManager campaign's business)
		let asked = 0;
		hq.basesManager.GetCurrentGatherRates = () =>
		{
			++asked;
			return { food: 1, wood: 0, stone: 0, metal: 0 };
		};

		const needed = hq.town.pickMostNeededResources(world.gameState);
		assert.equal(asked, 1);
		// the two shortfalls order first: wood (no gatherer at all) before food
		assert.deepEqual(needed.map((item: { type: string; }) => item.type).slice(0, 2), ["wood", "food"]);
		// the wanted table the office compared against
		assert.equal(needed[0].wanted, 10);
		assert.equal(needed[2].wanted, 0); // stone fills its nothing
	});

	it("of two resources both short, the one furthest below its wanted rate per gatherer goes first", () =>
	{
		const { world, hq } = seat();
		// the queues want 10 food and 6 wood; food is gathered at 2, wood at 3:
		// food is five times short of its want, wood only twice
		hq.town.GetWantedGatherRates = () => ({ food: 10, wood: 6, stone: 0, metal: 0 });
		hq.basesManager.GetCurrentGatherRates = () => ({ food: 2, wood: 3, stone: 0, metal: 0 });

		const needed = hq.town.pickMostNeededResources(world.gameState, ["wood", "food"]);

		assert.deepEqual(needed.map((item) => item.type), ["food", "wood"]);
	});

	it("a short resource with gatherers waits behind one nobody gathers yet", () =>
	{
		const { world, hq } = seat();
		hq.town.GetWantedGatherRates = () => ({ food: 10, wood: 6, stone: 0, metal: 0 });
		hq.basesManager.GetCurrentGatherRates = () => ({ food: 2, wood: 0, stone: 0, metal: 0 });

		assert.deepEqual(hq.town.pickMostNeededResources(world.gameState, ["food", "wood"]).map((item) => item.type), [
			"wood",
			"food",
		]);
		assert.deepEqual(hq.town.pickMostNeededResources(world.gameState, ["wood", "food"]).map((item) => item.type), [
			"wood",
			"food",
		]);
	});

	it("a resource the queues want, though fed, goes before one they do not want", () =>
	{
		const { world, hq } = seat();
		// stone is gathered above its want; nothing queued needs metal
		hq.town.GetWantedGatherRates = () => ({ food: 0, wood: 0, stone: 2, metal: 0 });
		hq.basesManager.GetCurrentGatherRates = () => ({ food: 0, wood: 0, stone: 3, metal: 1 });

		assert.deepEqual(
			hq.town.pickMostNeededResources(world.gameState, ["metal", "stone"]).map((item) => item.type),
			["stone", "metal"],
		);
		assert.deepEqual(
			hq.town.pickMostNeededResources(world.gameState, ["stone", "metal"]).map((item) => item.type),
			["stone", "metal"],
		);
	});

	it("the town tells the plans whether units may be trained, as its headquarters decided", () =>
	{
		const { hq } = seat();
		hq.canBuildUnits = false;
		assert.equal(hq.town.canBuildUnits, false, "a town without a trainer: attacks bring what they have");
		hq.canBuildUnits = true;
		assert.equal(hq.town.canBuildUnits, true);
	});
});

describe("a strait between two shores: getSeaBetweenIndices", () =>
{
	it("names the water region a crossing passes through", () =>
	{
		const { world, hq } = seat({
			trajectories: { "2,3": [2, 8, 3] },
			regionTypes: { 2: "land", 3: "land", 8: "water" },
		});

		assert.equal(hq.town.getSeaBetweenIndices(world.gameState, landRegion(2), landRegion(3)), 8);
	});

	it("a land bridge between the shores names no sea", () =>
	{
		const { world, hq } = seat({ trajectories: { "2,3": [2, 3] }, regionTypes: { 2: "land", 3: "land" } });

		assert.equal(hq.town.getSeaBetweenIndices(world.gameState, landRegion(2), landRegion(3)), undefined);
	});

	it("a route through land in the middle is not a sea crossing", () =>
	{
		const { world, hq } = seat({
			trajectories: { "2,3": [2, 8, 3] },
			regionTypes: { 2: "land", 3: "land", 8: "land" },
		});

		assert.equal(hq.town.getSeaBetweenIndices(world.gameState, landRegion(2), landRegion(3)), undefined);
	});

	it("no known route between the two regions names no sea", () =>
	{
		const { world, hq } = seat({ regionTypes: { 2: "land", 3: "land", 8: "water" } });

		assert.equal(
			hq.town.getSeaBetweenIndices(world.gameState, landRegion(2), landRegion(3)),
			undefined,
			"the engine answers no trajectory at all, so nothing to cross",
		);
	});
});

describe("the danger lights: what keeps the plans from building under fire", () =>
{
	/** an enemy tower with the ranged book of a watchtower: max range given */
	function firingTower(world: HqWorld, id: number, position: [number, number], range = 80): CommonEntity
	{
		return world.addEntity(
			makeHqEntity({
				id,
				owner: ENEMY,
				position,
				classes: ["Structure", "Tower"],
				templateName: "structures/spart/watchtower",
			}, {
				// the common-api's own read of a ranged attack with a default
				// arrow (entity.js hasDefensiveFire): the tower shoots
				get: (path: string) => path === "Attack/Ranged" ? { MaxRange: range } : undefined,
				getDefaultArrow: () => 1,
				hasDefensiveFire: () => true,
				attackRange: () => ({ max: range, min: 0 }),
			}),
		);
	}

	it("an enemy tower's fire will not reach past its own range", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);

		assert.equal(
			hq.town.isUnderEnemyFire(world.gameState, worldPos(150, 100)),
			true,
			"50 squares out, inside the 80 of the tower",
		);
		assert.equal(
			hq.town.isUnderEnemyFire(world.gameState, worldPos(250, 100)),
			false,
			"150 squares out, past the tower's reach",
		);
	});

	it("the caller's own radius adds to the tower's reach", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);

		// the radius stands for the ground a to-be structure occupies
		assert.equal(
			hq.town.isUnderEnemyFire(world.gameState, worldPos(230, 100), 60),
			true,
			"the 140 of range and radius reaches the 130-square mark",
		);
		assert.equal(
			hq.town.isUnderEnemyFire(world.gameState, worldPos(230, 100), 40),
			false,
			"the 120 of the pair does not reach the 130-square mark",
		);
	});

	it("a dangerous ground either sees a column or stands inside a tower's fire", () =>
	{
		// the defense seated for real: its armies are what the town asks of it
		const { world, hq } = seat({}, { stubs: doorManagers.filter((name) => name !== "defenseManager") });
		firingTower(world, 2201, [100, 100]);

		assert.equal(
			hq.town.isDangerousLocation(world.gameState, worldPos(250, 100), 0),
			false,
			"no column, no fire: the meadow is free",
		);
		assert.equal(
			hq.town.isDangerousLocation(world.gameState, worldPos(150, 100), 0),
			true,
			"no column, but the tower's fire reaches it",
		);
		hq.defenseManager.armies = [fake<DefenseArmy>({ foePosition: worldPos(340, 150) })];
		assert.equal(
			hq.town.isDangerousLocation(world.gameState, worldPos(250, 100), 0),
			true,
			"the column stands within reach of the field's edge",
		);
	});

	it("the tower's book stays sealed for the whole turn", () =>
	{
		const { world, hq } = seat();
		firingTower(world, 2201, [100, 100]);
		assert.equal(hq.town.isUnderEnemyFire(world.gameState, worldPos(150, 100)), true);

		// the tower demolished after the question: the turn's sealed book
		// still answers with what the map held when it was written
		world.ents.delete(2201);
		assert.equal(
			hq.town.isUnderEnemyFire(world.gameState, worldPos(150, 100)),
			true,
			"the same turn answers the same firing book",
		);
	});
});
