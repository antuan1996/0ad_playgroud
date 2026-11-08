/**
 * Our territory and the enemies' (world/territory.ts): what the AI's model of
 * the territories says of a foundation or a line across the map.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity, placed } from "./harness/fakes.ts";
import { PLAYER, makeWorld } from "./harness/world.ts";

import { isNotWorthBuilding } from "../world/territory.ts";

describe("isNotWorthBuilding: foundations outside our territory", () =>
{
	it("an own-territory-only foundation on lost ground is not worth finishing; one that may stand anywhere is", () =>
	{
		const world = makeWorld();
		world.territory.set("100,100", 0);
		const house = makeEntity({ id: 100, owner: PLAYER, position: [100, 100], classes: ["Structure"] }, {
			buildTerritories: () => ["own"],
		});
		const camp = makeEntity({ id: 101, owner: PLAYER, position: [100, 100], classes: ["Structure"] }, {
			buildTerritories: () => ["own", "neutral"],
		});
		assert.equal(isNotWorthBuilding(world.gameState, placed(house)), true);
		assert.equal(isNotWorthBuilding(world.gameState, placed(camp)), false);
		// in our territory the house is fine
		const home = makeEntity({ id: 102, owner: PLAYER, position: [10, 10], classes: ["Structure"] }, {
			buildTerritories: () => ["own"],
		});
		assert.equal(isNotWorthBuilding(world.gameState, placed(home)), false);
	});
});
