/**
 * shipTraffic: where the enemy's ships go, in ship-seconds per cell, fading by
 * half every TRAFFIC_HALF_LIFE seconds (world/shipTraffic.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { worldPos } from "../adapter/brands.ts";
import { ShipTraffic, TRAFFIC_CELL, TRAFFIC_HALF_LIFE } from "../world/shipTraffic.ts";
import { fake, makeEntity } from "./harness/fakes.ts";

/** A game state at `time` whose enemy units are `units`. */
function stateAt(time: number, units: CommonEntity[]): CommonGameState
{
	return fake<CommonGameState>({
		"ai": { "elapsedTime": time },
		"getEnemyUnits": () => ({ "values": () => units.values() }),
	});
}

const ship = (id: number, position: [number, number], classes: string[] = ["Unit", "Ship", "Warship"], owner = 2) =>
	makeEntity({ id, owner, position, classes });

describe("ShipTraffic", () =>
{
	it("adds each enemy ship's seconds in its cell, fishing boats and merchants less, gaia's and land units not", () =>
	{
		const traffic = new ShipTraffic(320, 320);
		const units = [
			ship(1, [40, 40]),
			ship(2, [40, 40], ["Unit", "Ship", "FishingBoat"]),
			ship(3, [200, 40], ["Unit", "Ship", "Trader"]),
			ship(4, [100, 100], ["Unit", "Ship"], 0),
			makeEntity({ id: 5, owner: 2, position: [100, 100], classes: ["Unit", "Infantry"] }),
		];
		traffic.sample(stateAt(100, units)); // the first sample only starts the clock
		traffic.sample(stateAt(110, units));

		const cell = (x: number, z: number) =>
			traffic.cells[Math.floor(x / TRAFFIC_CELL) + Math.floor(z / TRAFFIC_CELL) * traffic.width];
		assert.ok(Math.abs(cell(40, 40) - 12.5) < 1e-4, "a warship's 10 s and a fishing boat's quarter");
		assert.ok(Math.abs(cell(200, 40) - 5) < 1e-4, "a merchant's half");
		assert.equal(cell(100, 100), 0, "gaia's ship and a soldier count nothing");
	});

	it("fades by half every half-life", () =>
	{
		const traffic = new ShipTraffic(320, 320);
		traffic.sample(stateAt(0, [ship(1, [40, 40])]));
		traffic.sample(stateAt(20, [ship(1, [40, 40])]));
		const before = traffic.within(worldPos(40, 40), 20);
		traffic.sample(stateAt(20 + TRAFFIC_HALF_LIFE, []));
		assert.ok(Math.abs(traffic.within(worldPos(40, 40), 20) - before / 2) < 1e-3);
	});

	it("sums the traffic in reach of a point, a stretch already watched counting a third", () =>
	{
		const traffic = new ShipTraffic(320, 320);
		traffic.sample(stateAt(0, []));
		traffic.sample(stateAt(30, [ship(1, [40, 40]), ship(2, [200, 40])]));

		assert.equal(traffic.within(worldPos(60, 40), 40), 30, "the near passage");
		assert.equal(traffic.within(worldPos(60, 40), 10), 0, "out of a short reach");
		assert.equal(traffic.within(worldPos(120, 40), 100), 60, "both in a long one");
		assert.equal(traffic.within(worldPos(60, 40), 40, [worldPos(40, 70)]), 10, "watched by a tower already");
		assert.deepEqual(traffic.busiest(1)[0].slice(2), [30]);
	});
});
