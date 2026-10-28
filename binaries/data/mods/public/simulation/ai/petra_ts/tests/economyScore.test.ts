/**
 * economyScore: the economy's options on one scale, the seconds each takes to
 * pay back its cost from the income it adds, read off the measured rates of
 * world/gatherEconomy.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PAYBACK_HORIZON, incomeGain, incomeOf, paybackSeconds } from "../decision/economyScore.ts";
import { GatherEconomy } from "../world/gatherEconomy.ts";

/** a town at minute 6: 26 on the fields at 0.66, 3 on the berries at 0.6, 15 woodcutters at 0.8 */
function town(): GatherEconomy
{
	const economy = new GatherEconomy();
	economy.foodGatherers.grain = 26;
	economy.perFoodGatherer.grain = 0.66;
	economy.foodGatherers.fruit = 3;
	economy.perFoodGatherer.fruit = 0.6;
	economy.gatherers.wood = 15;
	economy.perGatherer.wood = 0.8;
	return economy;
}

describe("economyScore", () =>
{
	it("reads what each supply type brings in now", () =>
	{
		const economy = town();
		assert.ok(Math.abs(incomeOf(economy, "food.grain") - 17.16) < 1e-9);
		assert.ok(Math.abs(incomeOf(economy, "food.fruit") - 1.8) < 1e-9);
		assert.equal(incomeOf(economy, "wood.tree"), 12, "wood by its gatherers, whatever the tree");
		assert.equal(incomeOf(economy, "food.meat"), 0, "no hunters");
		assert.equal(incomeOf(economy, "food.milk"), 0, "a food no source of ours is");
		assert.equal(incomeOf(economy, "stone.rock"), 0, "no gatherers on the stone");
	});

	it("adds up what a tech's rate multipliers bring in, and nothing for other effects", () =>
	{
		const economy = town();
		const plough = [{ "value": "ResourceGatherer/Rates/food.grain", "multiply": 1.2 }];
		assert.ok(Math.abs(incomeGain(economy, plough) - 3.432) < 1e-9);
		const both = [{ "value": "ResourceGatherer/Rates/food.fruit", "multiply": 1.5 },
			{ "value": "ResourceGatherer/Rates/wood.tree", "multiply": 1.25 }];
		assert.ok(Math.abs(incomeGain(economy, both) - (0.9 + 3)) < 1e-9);
		assert.equal(incomeGain(economy, [{ "value": "ResourceGatherer/Capacities/food", "add": 5 }]), 0);
		assert.equal(incomeGain(economy, [{ "value": "Health/Max", "multiply": 1.2 }]), 0);
	});

	it("pays back after its delay and its cost over its gain, never without a gain", () =>
	{
		assert.equal(paybackSeconds(300, 40, 3), 140);
		assert.equal(paybackSeconds(300, 40, 0), Infinity);
		assert.ok(paybackSeconds(300, 40, incomeGain(town(), [{ "value": "ResourceGatherer/Rates/food.grain", "multiply": 1.2 }])) <
			PAYBACK_HORIZON, "the plough pays back within the horizon on 26 farmers");
	});
});
