/**
 * The build-order planner's forecast (decision/economyForecast.ts, PLAN.md
 * §6.3.2): an Athenian town of the first minutes, its civic centre's women
 * (50 food, 8 s) and spearmen (50 food 50 wood, 10 s), houses of 5 room
 * (150 wood, 50 s), and the gather rates the bot measures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STEP, forecast, type EconomyState } from "../decision/economyForecast.ts";

function town(overrides: Partial<EconomyState> = {}): EconomyState
{
	return {
		time: 120,
		stock: { food: 0, wood: 0, stone: 0, metal: 0 },
		gatherers: { food: 10, wood: 10, stone: 0, metal: 0 },
		ratePerGatherer: { food: 0.5, wood: 0.8, stone: 0.4, metal: 0.4 },
		supports: 15,
		soldiers: 5,
		population: 20,
		popLimit: 100,
		popMax: 300,
		trainers: [{ centre: true, queue: [] }],
		batchModifier: 0.8,
		support: { cost: { food: 50 }, seconds: 8 },
		soldier: { cost: { food: 50, wood: 50 }, seconds: 10 },
		house: { cost: { wood: 150 }, seconds: 50, room: 5 },
		...overrides,
	};
}

const settings = { supportRatio: 0.5, targetWorkers: 100 };

describe("the planner's forecast: forecast", () =>
{
	it("a town training nothing gathers at its measured rates", () =>
	{
		const idle = town({ trainers: [], stock: { food: 0, wood: 0 } });
		const later = forecast(idle, settings, 180);
		// 60 s of 10 x 0.5 food and 10 x 0.8 wood
		assert.equal(later.gathered, 780);
		assert.equal(later.population, 20);
		assert.equal(later.time, 180);
	});

	it("the civic centre trains women first, up to their cap, then citizen soldiers", () =>
	{
		const rich = town({ stock: { food: 100000, wood: 100000 }, supports: 48, population: 53 });
		const later = forecast(rich, settings, 120 + 6 * 60);
		assert.equal(later.supports, 50, "half of the 100 workers wanted");
		assert.ok(later.soldiers > 5, "then soldiers");
	});

	it("trains in batches, quicker each than one by one, bigger as the workforce grows", () =>
	{
		// batches of ceil(workers / 10): two women in 8 x 2^0.8 = 13.9 s, then three in 19.3 s, twice: done at
		// 52.5 s; the next three would be out at 71.8 s
		const rich = town({ stock: { food: 100000, wood: 0 } });
		const later = forecast(rich, settings, 120 + 6 * STEP);
		assert.equal(later.supports, 15 + 2 + 3 + 3);
	});

	it("trains what its queue holds first, already paid for", () =>
	{
		const queued = town({
			gatherers: { food: 0, wood: 0 },
			trainers: [{ centre: true, queue: [{ kind: "soldier", count: 5, seconds: 5 }] }],
		});
		const later = forecast(queued, settings, 120 + STEP);
		assert.equal(later.soldiers, 10, "the five queued spearmen are out after their 5 s");
		assert.equal(later.population, 20, "their room was taken when they were queued");
	});

	it("waits for a house when the room runs out, and builds one with the wood", () =>
	{
		const full = town({ popLimit: 22, stock: { food: 100000, wood: 150 } });
		const soon = forecast(full, settings, 120 + 2 * STEP);
		assert.equal(soon.population, 22, "the room left is taken");
		const later = forecast(full, settings, 120 + 8 * STEP);
		assert.ok(later.population > 22, "the house built, more come");
	});

	it("a barracks trains soldiers only", () =>
	{
		const barracks = town({ stock: { food: 100000, wood: 100000 }, trainers: [{ centre: false, queue: [] }] });
		const later = forecast(barracks, settings, 120 + 6 * STEP);
		assert.equal(later.supports, 15);
		assert.ok(later.soldiers > 5);
	});
});
