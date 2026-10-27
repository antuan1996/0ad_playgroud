/**
 * foodSource: berries or fields, by what a gatherer brings in from each
 * (decision/foodSource.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fieldsBeatBerries, MIN_BERRY_GATHERERS } from "../decision/foodSource.ts";

describe("where food comes from: berries or fields", () =>
{
	it("wants a field once the berries bring in less than a field", () =>
	{
		assert.equal(fieldsBeatBerries({ "fruit": 0.4, "grain": 0.55, "fruitGatherers": 8 }), true);
		assert.equal(fieldsBeatBerries({ "fruit": 0.7, "grain": 0.55, "fruitGatherers": 8 }), false);
	});

	it("does not act on too few berry gatherers to measure", () =>
	{
		assert.equal(fieldsBeatBerries({ "fruit": 0.1, "grain": 0.55, "fruitGatherers": MIN_BERRY_GATHERERS - 1 }), false);
		assert.equal(fieldsBeatBerries({ "fruit": 0.1, "grain": 0.55, "fruitGatherers": MIN_BERRY_GATHERERS }), true);
	});

	it("berries exactly as good as a field keep the berries", () =>
	{
		assert.equal(fieldsBeatBerries({ "fruit": 0.55, "grain": 0.55, "fruitGatherers": 10 }), false);
	});
});
