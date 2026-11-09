/**
 * The map as the AI understands it (world/geography.ts): where ships may land
 * on each land from each sea (findLandingZones), worked out when the map is
 * analysed and again when a game is loaded.
 *
 * The board is the naval suites' (harness/navalWorld.ts): our land (region 2)
 * west of x = 160, the sea (region 5) beyond it, an island (region 3) from
 * x = 240; the strips 152-160 and 240-248 are shallows, both land and sea.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAP_CELLS } from "./harness/hqWorld.ts";
import { ISLAND, SEA, WEST, navalWorld } from "./harness/navalWorld.ts";

import { findLandingZones, restoreGeography } from "../world/geography.ts";

/** Passability cells per row on the naval board */
const WIDTH = MAP_CELLS * 4;

describe("where ships may land: the landing zones", () =>
{
	it("maps where units can board and land: the shallows of each land on each sea", () =>
	{
		const { hq } = navalWorld();

		for (const [land, from, to] of [[WEST, 152, 160], [ISLAND, 240, 248]])
		{
			const zone = hq.geography.landingZones[land]?.[SEA];
			assert.ok(zone && zone.size > 0, `land ${land} has landing spots`);
			for (const i of zone)
			{
				const x = 2 * (i % WIDTH);
				assert.ok(x >= from && x < to, `in the shallows, got x = ${x}`);
			}
		}
	});

	it("leaves out a lone shallow cell with no room around it", () =>
	{
		const { world } = navalWorld();
		// a single flooded cell inside our land: land 2 and sea 5 at once
		const lone = 20 + 80 * WIDTH;
		world.map.navalPassMap[lone] = SEA;

		const zones = findLandingZones(world.gameState);

		assert.equal(zones[WEST][SEA].has(lone), false);
		assert.ok(zones[WEST][SEA].size > 0, "the shore keeps its spots");
	});

	it("a loaded game maps the same landing spots again, its map being the same", () =>
	{
		const { world, hq } = navalWorld();

		const loaded = restoreGeography(world.gameState, {
			landRegions: hq.geography.landRegions,
			navalRegions: hq.geography.navalRegions,
			navalMap: hq.geography.navalMap,
		});

		assert.deepEqual(loaded.landingZones, hq.geography.landingZones);
		assert.notEqual(loaded.landingZones, hq.geography.landingZones, "worked out anew, not shared");
	});
});
