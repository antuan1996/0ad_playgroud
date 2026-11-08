/**
 * Capture or destroy (world/capture.ts): a unit of ours weighs a target's
 * capture points, regeneration and decay against the joint strength our units
 * set on it, kept in the capture tally (world/captureTally.ts) the bot exposes
 * as gameState.ai.captures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeEntity } from "./harness/fakes.ts";
import { ENEMY, PLAYER, makeWorld, type World } from "./harness/world.ts";

import { entityId } from "../adapter/brands.ts";
import { allowCapture } from "../world/capture.ts";

describe("allowCapture: capture or destroy", () =>
{
	/** an enemy house of 500 capture points, at full health */
	function house(world: World, extra: Record<string, unknown> = {}): CommonEntity
	{
		return world.addEntity(
			makeEntity({ id: 30, owner: ENEMY, position: [100, 100], classes: ["Structure", "House"] }, {
				isCapturable: () => true,
				capturePoints: () => [0, 0, 500],
				...extra,
			}),
		);
	}
	function capturer(world: World, id: number, strength: number): CommonEntity
	{
		return world.addEntity(
			makeEntity({ id, owner: PLAYER, position: [100, 90], classes: ["Unit", "Infantry"] }, {
				canCapture: () => true,
				captureStrength: () => strength,
			}),
		);
	}

	it("a lone soldier is too weak for a full house; a second one tips the balance, and counts once", () =>
	{
		const world = makeWorld();
		const target = house(world);
		const first = capturer(world, 31, 2.5);
		const second = capturer(world, 32, 4);
		// 2.5 against 500 / 80 = 6.25
		assert.equal(allowCapture(world.gameState, first, target), false);
		// 2.5 + 4 = 6.5
		assert.equal(allowCapture(world.gameState, second, target), true);
		assert.equal(allowCapture(world.gameState, first, target), true);
		assert.deepEqual(world.ai.captures.targets.get(entityId(30)), { strength: 6.5, ents: new Set([31, 32]) });
	});

	it("a decaying building gives way faster", () =>
	{
		const world = makeWorld();
		const target = house(world, { decaying: () => true, territoryDecayRate: () => 5 });
		// 2.5 against 6.25 - 5
		assert.equal(allowCapture(world.gameState, capturer(world, 33, 2.5), target), true);
	});
});
