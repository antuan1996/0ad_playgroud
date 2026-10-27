/**
 * orders: what a unit has been ordered to do, read from the orders the engine
 * hands over (adapter/orders.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { fake, orders } from "./harness/fakes.ts";
import { modsPublic } from "./harness/paths.ts";

import { entityId } from "../adapter/brands.ts";
import { gatherRate, ordersOf } from "../adapter/orders.ts";

/** A female citizen's rates, as resourceGatherRates() gives them: base speed times rate. */
const CITIZEN_RATES = { "food.fruit": 1, "food.grain": 0.5, "wood.tree": 0.7, "stone.rock": 0.35 };

function unit(state: string | undefined, queue: CommonUnitOrder[]): CommonEntity
{
	return fake<CommonEntity>({
		"unitAIState": () => state,
		"unitAIOrderData": () => queue,
		"resourceGatherRates": () => CITIZEN_RATES
	});
}

/** A game state knowing the supplies by id. */
function world(supplies: Record<number, { generic: string; specific: string } | undefined>): CommonGameState
{
	return fake<CommonGameState>({
		"getEntityById": (id: number) => id in supplies ? fake<CommonEntity>({ "resourceSupplyType": () => supplies[id] }) : undefined
	});
}

describe("what a unit has been ordered to do", () =>
{
	it("the common API hands over UnitAI's orders, type and data, not the data alone", () =>
	{
		// Entity.unitAIOrderData() calls UnitAI.GetOrders since the engine's
		// commit 4b516b336e; the reader unwraps the data. If the engine goes
		// back to GetOrderData, the reader must change with it.
		const source = readFileSync(path.join(modsPublic, "simulation/ai/common-api/entity.js"), "utf8");
		assert.match(source, /unitAIOrderData\(\) \{ return SimEngine\.QueryInterface\(this\.id\(\), Sim\.IID_UnitAI\)\.GetOrders\(\); \}/);
		const unitAI = readFileSync(path.join(modsPublic, "simulation/components/UnitAI.js"), "utf8");
		assert.match(unitAI, /UnitAI\.prototype\.GetOrders = function\(\)\n\{\n\treturn this\.orderQueue\.slice\(\);/);
	});

	it("reads each order's data, in queue order, leaving out the orders that carry none", () =>
	{
		const queue = [
			{ "type": "ReturnResource", "data": { "target": entityId(50) } },
			{ "type": "Stop" },
			{ "type": "Gather", "data": { "target": entityId(60), "force": false } }
		];

		assert.deepEqual(ordersOf(unit("INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", queue)),
			[{ "target": 50 }, { "target": 60, "force": false }]);
		assert.deepEqual(ordersOf(unit("INDIVIDUAL.IDLE", [])), []);
	});
});

describe("the rate a unit gathers at", () =>
{
	it("a woman cutting a tree gathers at her wood rate", () =>
	{
		const gameState = world({ 70: { "generic": "wood", "specific": "tree" } });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.GATHERING", orders({ "target": entityId(70) }))), 0.7);
	});

	it("an order to gather from a field gives the grain rate, not the fruit one", () =>
	{
		const gameState = world({ 71: { "generic": "food", "specific": "grain" } });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.APPROACHING", orders({ "target": entityId(71) }))), 0.5);
	});

	it("reads the next order when the first has no target", () =>
	{
		const gameState = world({ 72: { "generic": "stone", "specific": "rock" } });
		const queue = orders({ "force": true }, { "target": entityId(72) });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.GATHERING", queue)), 0.35);
	});

	it("a unit carrying back to a dropsite reads the dropsite, which supplies nothing: 0", () =>
	{
		// as Entity.currentGatherRate always did: the first order with a target wins
		const gameState = world({ 80: undefined, 73: { "generic": "wood", "specific": "tree" } });
		const queue = orders({ "target": entityId(80) }, { "target": entityId(73) });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", queue)), 0);
	});

	it("a supply gone, or one the unit has no rate for, gives 0", () =>
	{
		const gameState = world({ 74: { "generic": "metal", "specific": "ore" } });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.GATHERING", orders({ "target": entityId(99) }))), 0);
		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.GATHER.GATHERING", orders({ "target": entityId(74) }))), 0);
	});

	it("a unit not gathering, or one that cannot gather, has no rate", () =>
	{
		const gameState = world({ 70: { "generic": "wood", "specific": "tree" } });

		assert.equal(gatherRate(gameState, unit("INDIVIDUAL.COMBAT.ATTACKING", orders({ "target": entityId(70) }))), undefined);
		const soldierOnly = fake<CommonEntity>({ "resourceGatherRates": () => undefined });
		assert.equal(gatherRate(gameState, soldierOnly), undefined);
	});
});
