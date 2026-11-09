/**
 * Where fish may be caught (world/fishing.ts): the sea a shoal lies in, noted
 * on it once with whether it lies in open sea, and whether no enemy territory
 * reaches it. The suites count the fish with a real naval manager on the
 * naval board (tests/harness/navalSeat.ts), as a game's start does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placed } from "./harness/fakes.ts";
import { ENEMY, MAP_CELLS, PLAYER } from "./harness/hqWorld.ts";
import { fish, init, seat } from "./harness/navalSeat.ts";
import { SEA, WEST } from "./harness/navalWorld.ts";

import { seaRegion } from "../adapter/brands.ts";
import { fishIsSafe, fishSea } from "../world/fishing.ts";

const PlayerID = PLAYER;

describe("where fish can be caught: fishSea and fishIsSafe", () =>
{
	it("a shoal far from any shore is in the open sea, safe from everyone", () =>
	{
		const s = seat({ island: false });
		const shoal = fish(s.world, 400, [300, 160]);
		init(s);

		assert.equal(fishSea(s.world.gameState, placed(shoal)), SEA);
		assert.equal(shoal.getMetadata(PlayerID, "opensea"), true);
		assert.equal(fishIsSafe(s.world.gameState, placed(shoal)), true);
	});

	it("a shoal by rocks, or by the edge of a round map, is still in the open sea; by land it is not", () =>
	{
		const access = (s: ReturnType<typeof seat>) =>
			s.world.ai.accessibility as unknown as { landPassMap: Uint8Array; navalPassMap: Uint8Array; };
		// the farthest sample north of the shoal, 120 m off: passability cell (150, 140)
		const sample = 150 + 140 * MAP_CELLS * 4;

		const rocks = seat({ island: false });
		const byRocks = fish(rocks.world, 400, [300, 160]);
		access(rocks).landPassMap[sample] = 1; // neither land nor sea: region 1 on both grids
		access(rocks).navalPassMap[sample] = 1;
		init(rocks); // counting the fish measures each shoal's sea
		assert.equal(byRocks.getMetadata(PlayerID, "opensea"), true, "the next sample inward is open water");

		const islet = seat({ island: false });
		const byLand = fish(islet.world, 400, [300, 160]);
		access(islet).landPassMap[sample] = WEST; // a scrap of land there instead
		init(islet);
		assert.equal(byLand.getMetadata(PlayerID, "opensea"), undefined);
	});

	it("a shoal near a shore is not in the open sea, and its sea is remembered", () =>
	{
		const s = seat();
		const shoal = fish(s.world, 400, [200, 160]);
		init(s);

		assert.equal(fishSea(s.world.gameState, placed(shoal)), SEA);
		assert.equal(shoal.getMetadata(PlayerID, "opensea"), undefined);
		assert.equal(shoal.getMetadata(PlayerID, "sea"), SEA);
		shoal.setMetadata(PlayerID, "sea", seaRegion(9));
		assert.equal(fishSea(s.world.gameState, placed(shoal)), 9, "read back, not measured again");
	});

	it("a shoal near enemy ground is not safe to fish", () =>
	{
		const s = seat();
		const shoal = fish(s.world, 400, [200, 160]);
		init(s);
		assert.equal(fishIsSafe(s.world.gameState, placed(shoal)), true, "our ground and the open water around it");

		s.world.map.setTerritoryOwner(33, 20, ENEMY); // on the island, 60 m east
		assert.equal(fishIsSafe(s.world.gameState, placed(shoal)), false);
	});
});
