/**
 * dropsites: whether a base's gatherers of a resource walk too much and want
 * a dropsite nearer, and how good a place must be (decision/dropsites.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GOOD_DROPSITE, dropsiteVerdict, relaxedDropsiteQuality } from "../decision/dropsites.ts";

describe("dropsites", () =>
{
	it("waits for 150 samples of the woodcutters, 60 of the others", () =>
	{
		assert.equal(dropsiteVerdict("wood", 100, 50), "wait");
		assert.equal(dropsiteVerdict("wood", 100, 51), "closer");
		assert.equal(dropsiteVerdict("stone", 40, 20), "wait");
		assert.equal(dropsiteVerdict("stone", 40, 21), "closer");
	});

	it("wants a dropsite nearer once more than 15% of the tally carry back", () =>
	{
		assert.equal(dropsiteVerdict("wood", 170, 30), "fine", "15%: they keep walking");
		assert.equal(dropsiteVerdict("wood", 169, 31), "closer");
		assert.equal(dropsiteVerdict("metal", 100, 0), "fine");
	});

	it("builds on a place above 50, and with no base to plan on less, the more they walk", () =>
	{
		assert.equal(GOOD_DROPSITE, 50);
		assert.equal(relaxedDropsiteQuality(70, 30), 25, "30% carrying back: 50 · 0.15 / 0.3 = 25");
		assert.ok(Math.abs(relaxedDropsiteQuality(40, 60) - 12.5) < 1e-9, "60%: 12.5");
		assert.equal(relaxedDropsiteQuality(80, 20), 25, "20%: at most 25");
	});
});
