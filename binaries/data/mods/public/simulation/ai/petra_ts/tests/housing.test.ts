/**
 * housing: when a house is planned, when a planned one may be paid, and how
 * urgently, over the census (decision/housing.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { houseNeeded, planAnotherHouse, urgentHousePriority } from "../decision/housing.ts";

/** a town of `population` with room for `limit`, foundations adding `coming`, under the game's 300 */
const census = (population: number, limit: number, coming = 0, max = 300) => ({ population, limit, max, coming });

describe("housing", () =>
{
	it("plans three houses ahead, five past eighty units", () =>
	{
		assert.equal(planAnotherHouse(2, 40), true);
		assert.equal(planAnotherHouse(3, 40), false);
		assert.equal(planAnotherHouse(4, 81), true);
		assert.equal(planAnotherHouse(5, 120), false);
	});

	it("pays a house once the room left falls to 10 free slots, 15 past 30 units, 21 past 55", () =>
	{
		assert.equal(houseNeeded(census(20, 30), false), true, "10 free");
		assert.equal(houseNeeded(census(20, 31), false), false, "11 free");
		assert.equal(houseNeeded(census(40, 55), false), true, "15 free past 30");
		assert.equal(houseNeeded(census(60, 81), false), true, "21 free past 55");
		assert.equal(houseNeeded(census(60, 82), false), false, "22 free");
	});

	it("counts the room the foundations will add, waits while saving, and stops at the cap", () =>
	{
		assert.equal(houseNeeded(census(60, 70, 10), false), true, "10 + 10 coming: 20 free");
		assert.equal(houseNeeded(census(60, 70, 15), false), false, "25 free with the foundations");
		assert.equal(houseNeeded(census(60, 75), true), false, "saving: only at 10 free");
		assert.equal(houseNeeded(census(60, 70), true), true);
		assert.equal(houseNeeded(census(290, 300), false), false, "the game's cap reached");
	});

	it("puts the house queue just above the training queues when slots run short", () =>
	{
		assert.equal(urgentHousePriority({ "house": 250, "villager": 650, "citizenSoldier": 600 }), 651);
		assert.equal(urgentHousePriority({ "house": 400, "villager": 300, "citizenSoldier": 600 }), 800, "Petra's double, when higher");
	});
});
