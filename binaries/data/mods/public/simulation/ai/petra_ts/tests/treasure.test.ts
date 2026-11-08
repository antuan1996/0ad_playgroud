/**
 * Treasure (execution/treasure.ts): a collector sent to the nearest treasure
 * it may reach, on its land or its sea, in our territory or near it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity } from "./harness/fakes.ts";
import { ENEMY, GAIA, PLAYER, collectionOf, makeWorld, type World } from "./harness/world.ts";

import { seaRegion } from "../adapter/brands.ts";
import { isPlaced } from "../adapter/placed.ts";
import { gatherTreasure } from "../execution/treasure.ts";

describe("gatherTreasure: sending a unit for treasure", () =>
{
	/** a world with the given treasures on the map, and the HQ's treasure collection over them */
	function treasureWorld(
		spots: Array<{ id: number; position: [number, number]; lastGathered?: number; access?: number; }>,
	): World
	{
		const world = makeWorld();
		const treasures = spots.map((spot) =>
			world.addEntity(
				makeEntity({ id: spot.id, owner: GAIA, position: spot.position, classes: ["Treasure"] }, {}, {
					...(spot.lastGathered === undefined ? {} : { lastGathered: spot.lastGathered }),
				}),
			)
		);
		for (const spot of spots)
		{
			if (spot.access)
			{
				world.accessAt.set(`${spot.position[0]},${spot.position[1]}`, spot.access);
			}
		}
		world.ai.HQ.treasures = collectionOf(world, treasures).filter(isPlaced);
		return world;
	}
	function collector(
		world: World,
		id: number,
		position: [number, number] | undefined,
		collects = true,
	): { ent: CommonEntity; went: number[]; }
	{
		const went: number[] = [];
		const ent = world.addEntity(
			makeEntity({ id, owner: PLAYER, position, classes: ["Unit", "Cavalry"] }, {
				isTreasureCollector: () => collects,
				collectTreasure: (t: CommonEntity) => went.push(t.id()),
			}),
		);
		return { ent, went };
	}

	it("the nearest treasure in our land goes to the unit, and is booked for 20 seconds", () =>
	{
		const world = treasureWorld([{ id: 110, position: [150, 100] }, { id: 111, position: [120, 100] }, {
			id: 112,
			position: [200, 100],
		}]);
		const { ent, went } = collector(world, 113, [100, 100]);

		assert.equal(gatherTreasure(world.gameState, ent), true);
		assert.deepEqual(went, [111]);
		assert.equal(ent.getMetadata(PLAYER, "treasure"), 111);
		assert.equal(world.ents.get(111)!.getMetadata(PLAYER, "lastGathered"), world.ai.elapsedTime);

		// a second unit right after does not chase the same treasure
		const other = collector(world, 114, [100, 100]);
		gatherTreasure(world.gameState, other.ent);
		assert.deepEqual(other.went, [110]);
	});

	it("treasures across the water, in enemy land or too far out of sight are left alone", () =>
	{
		const world = treasureWorld([
			{ id: 120, position: [110, 100], access: 4 },
			{ id: 121, position: [130, 100] },
			// neutral ground at 130 map units: past the 14000 sight cut
			{ id: 122, position: [100, 230] },
			// a treasure booked 10 seconds ago
			{ id: 123, position: [105, 105], lastGathered: 90 },
		]);
		world.territory.set("130,100", ENEMY);
		world.territory.set("100,230", 0);
		const { ent, went } = collector(world, 124, [100, 100]);

		assert.equal(gatherTreasure(world.gameState, ent), false);
		assert.deepEqual(went, []);
	});

	it("in our own territory a treasure up to about 346 map units away is still worth it", () =>
	{
		const world = treasureWorld([{ id: 130, position: [100, 400] }, { id: 131, position: [100, 460] }]);
		const { ent, went } = collector(world, 132, [100, 100]);
		assert.equal(gatherTreasure(world.gameState, ent), true);
		assert.deepEqual(went, [130]);
	});

	it("a unit that cannot carry treasure, is garrisoned, or has no treasure on the map goes for nothing", () =>
	{
		const world = treasureWorld([{ id: 140, position: [110, 100] }]);
		assert.equal(gatherTreasure(world.gameState, collector(world, 141, [100, 100], false).ent), false);
		assert.equal(gatherTreasure(world.gameState, collector(world, 142, undefined).ent), false);
		assert.equal(gatherTreasure(world.gameState, undefined), false);
		const empty = treasureWorld([]);
		assert.equal(gatherTreasure(empty.gameState, collector(empty, 143, [100, 100]).ent), false);
	});

	it("a ship goes for treasure floating on its own sea only", () =>
	{
		const world = treasureWorld([{ id: 150, position: [110, 100] }, { id: 151, position: [130, 100] }]);
		world.ents.get(150)!.setMetadata(PLAYER, "sea", seaRegion(6));
		world.ents.get(151)!.setMetadata(PLAYER, "sea", seaRegion(5));
		const { ent, went } = collector(world, 152, [100, 100]);
		ent.setMetadata(PLAYER, "sea", seaRegion(5));
		assert.equal(gatherTreasure(world.gameState, ent, true), true);
		assert.deepEqual(went, [151]);
	});
});
