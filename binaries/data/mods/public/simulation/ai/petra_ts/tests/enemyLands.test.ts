/**
 * The enemies on each land (world/enemyLands.ts): which enemies keep our
 * soldiers beside them on a land (FINDINGS §34), counted once a turn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity } from "./harness/fakes.ts";
import { ENEMY, makeWorld } from "./harness/world.ts";

import { EnemyLands } from "../world/enemyLands.ts";

describe("the enemies on each land", () =>
{
	it("an enemy woman or trader alone keeps no one back; a soldier, a hero, a siege engine or a building on a land does", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		for (
			const [id, land, classes] of [
				[3000, 5, ["Unit", "Support", "FemaleCitizen"]],
				[3001, 6, ["Unit", "Trader"]],
				[3002, 7, ["Unit", "Soldier"]],
				[3003, 8, ["Unit", "Hero"]],
				[3004, 10, ["Unit", "Siege"]],
				[3005, 11, ["Structure", "House"]],
				[3006, 12, ["Unit", "Ship", "Soldier"]],
				[3007, 1, ["Unit", "Soldier"]],
			] as const
		)
		{ // on an impassable cell, a cliff's edge: no land
			world.accessAt.set(`${id},0`, land);
			world.addEntity(makeEntity({ id, owner: ENEMY, position: [id, 0], classes: [...classes] }));
		}
		world.accessAt.set("4000,0", 13);
		world.addEntity(makeEntity({ id: 4000, owner: 0, position: [4000, 0], classes: ["Unit", "Soldier"] }));

		assert.deepEqual([...new EnemyLands().byLand(world.gameState).keys()].sort((a, b) => a - b), [7, 8, 10, 11]);
	});

	it("counts once a turn: the same turn answers the same count, the next one counts again", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		world.accessAt.set("3000,0", 7);
		world.addEntity(makeEntity({ id: 3000, owner: ENEMY, position: [3000, 0], classes: ["Unit", "Soldier"] }));
		const lands = new EnemyLands();
		const first = lands.byLand(world.gameState);

		world.accessAt.set("3001,0", 8);
		world.addEntity(makeEntity({ id: 3001, owner: ENEMY, position: [3001, 0], classes: ["Unit", "Soldier"] }));
		assert.equal(lands.byLand(world.gameState), first, "the turn's count, kept");
		assert.deepEqual([...first.keys()], [7]);

		world.ai.playedTurn++;
		assert.deepEqual([...lands.byLand(world.gameState).keys()].sort((a, b) => a - b), [7, 8], "counted again");
	});
});
