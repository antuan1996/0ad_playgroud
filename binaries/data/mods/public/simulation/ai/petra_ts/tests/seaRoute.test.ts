/**
 * seaRoute: a ship's way to its landing point over the cells of its sea, round
 * the enemy shooters it can avoid (world/seaRoute.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seaRegion, worldPos } from "../adapter/brands.ts";
import { fake, makeEntity } from "./harness/fakes.ts";

import type { Accessibility } from "simulation/ai/common-api/terrain-analysis.js";
import {
	DANGER_MARGIN,
	MAX_WAYPOINTS,
	seaRoute,
	shootersOf,
	threatsAlong,
	threatsAt,
	type Shooter,
} from "../world/seaRoute.ts";

const SEA = seaRegion(3);
const CELL = 4;

/** a 60 x 60 cell sea (240 m), with `land` cells (x, y) left out of it */
function sea(land: (x: number, y: number) => boolean = () => false): Accessibility
{
	const width = 60;
	const navalPassMap = new Uint16Array(width * width);
	for (let y = 0; y < width; ++y)
		for (let x = 0; x < width; ++x)
			navalPassMap[x + y * width] = land(x, y) ? 1 : SEA;
	return fake<Accessibility>({
		"width": width,
		"height": width,
		"cellSize": CELL,
		navalPassMap,
		"gamePosToMapPos": (pos: [number, number]) => [Math.floor(pos[0] / CELL), Math.floor(pos[1] / CELL)],
	});
}

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("seaRoute", () =>
{
	it("on open water goes to the landing point in a few waypoints, all at sea", () =>
	{
		const access = sea();
		const route = seaRoute(access, SEA, worldPos(10, 120), worldPos(230, 120), []);

		assert.ok(route);
		assert.ok(route.length <= MAX_WAYPOINTS);
		assert.deepEqual(route.at(-1), [230, 120], "the last waypoint is the landing point");
		for (const point of route)
			assert.equal(access.navalPassMap[Math.floor(point[0] / CELL) + Math.floor(point[1] / CELL) * 60], SEA);
	});

	it("goes round a tower beside the straight way, out of its reach", () =>
	{
		const tower: Shooter = { "pos": worldPos(120, 110), "range": 40 };
		const route = seaRoute(sea(), SEA, worldPos(10, 120), worldPos(230, 120), [tower]);

		assert.ok(route);
		for (const point of route.slice(0, -1))
			assert.ok(dist(point, tower.pos) > tower.range + DANGER_MARGIN - CELL, `waypoint ${point} keeps clear`);
		assert.ok(
			route.some(point => Math.abs(point[1] - 110) > tower.range + DANGER_MARGIN),
			"it swings wide of the tower, on one side or the other",
		);
	});

	it("keeps its margin from a swordsman waiting on the shore", () =>
	{
		const swordsman: Shooter = { "pos": worldPos(120, 128), "range": 0 };
		const route = seaRoute(sea(), SEA, worldPos(10, 120), worldPos(230, 120), [swordsman]);

		assert.ok(route);
		for (const point of route.slice(0, -1))
			assert.ok(dist(point, swordsman.pos) > DANGER_MARGIN - CELL, `waypoint ${point} keeps clear`);
	});

	it("still reaches a landing point under fire", () =>
	{
		const fort: Shooter = { "pos": worldPos(225, 120), "range": 60 };
		const route = seaRoute(sea(), SEA, worldPos(10, 120), worldPos(230, 120), [fort]);

		assert.deepEqual(route?.at(-1), [230, 120]);
	});

	it("on open water sails straight: one leg", () =>
	{
		assert.deepEqual(seaRoute(sea(), SEA, worldPos(10, 120), worldPos(230, 120), []), [[230, 120]]);
	});

	// the user's watch of a 4-player Dodecanese game: transports passed the
	// towers they could have sailed round an island to avoid
	it("sails round the far side of an island rather than past the towers on its near shore, every leg at sea", () =>
	{
		// an island across the middle, from y = 60 to 180 m; the ship crosses from west to east below it
		const island = (x: number, y: number): boolean => x >= 20 && x < 40 && y >= 15 && y < 45;
		const access = sea(island);
		const from = worldPos(40, 120);
		const to = worldPos(200, 120);
		// two towers on the island's west shore and south: the straight way passes within their reach
		const towers: Shooter[] = [{ "pos": worldPos(100, 80), "range": 40 }, {
			"pos": worldPos(100, 160),
			"range": 40,
		}];
		const route = seaRoute(access, SEA, from, worldPos(200, 230), towers);
		assert.ok(route);
		assert.ok(route.length <= MAX_WAYPOINTS);
		assert.equal(threatsAlong(from, route, towers), 0, "no leg within a tower's reach");
		let previous: readonly number[] = from;
		for (const point of route)
		{
			for (let k = 0; k <= 50; ++k)
			{
				const x = previous[0] + (point[0] - previous[0]) * k / 50;
				const y = previous[1] + (point[1] - previous[1]) * k / 50;
				assert.equal(
					access.navalPassMap[Math.floor(x / CELL) + Math.floor(y / CELL) * 60],
					SEA,
					`(${x}, ${y}) at sea`,
				);
			}
			previous = point;
		}
		assert.ok(seaRoute(access, SEA, from, to, towers), "and a way exists to the east too");
	});

	it("finds no route from or to a point off its sea, or across land", () =>
	{
		const island = sea(x => x === 30); // a wall of land down the middle
		assert.equal(seaRoute(island, SEA, worldPos(10, 120), worldPos(230, 120), []), undefined, "no way across");
		assert.equal(seaRoute(island, SEA, worldPos(122, 120), worldPos(230, 120), []), undefined, "starting on land");
		assert.equal(
			seaRoute(sea(), seaRegion(9), worldPos(10, 120), worldPos(230, 120), []),
			undefined,
			"another sea",
		);
	});
});

describe("shootersOf", () =>
{
	it("counts the enemy buildings with defensive fire, the archers by their range and the swordsmen at 0, not houses, traders or gaia", () =>
	{
		const tower = makeEntity({ id: 1, owner: 2, position: [10, 10], classes: ["Structure", "Tower"] }, {
			"hasDefensiveFire": () => true,
			"attackRange": () => ({ "max": 72, "min": 0 }),
		});
		const house = makeEntity({ id: 2, owner: 2, position: [20, 20], classes: ["Structure", "House"] }, {
			"hasDefensiveFire": () => false,
		});
		const archer = makeEntity({ id: 3, owner: 2, position: [30, 30], classes: ["Unit", "Ranged"] }, {
			"attackTypes": () => ["Ranged"],
			"attackRange": () => ({ "max": 60, "min": 0 }),
		});
		const swordsman = makeEntity({ id: 4, owner: 2, position: [40, 40], classes: ["Unit", "Melee"] }, {
			"attackTypes": () => ["Melee"],
		});
		const wolf = makeEntity({ id: 5, owner: 0, position: [50, 50], classes: ["Unit", "Animal"] });
		const trader = makeEntity({ id: 8, owner: 2, position: [80, 80], classes: ["Unit", "Trader"] }, {
			"attackTypes": () => undefined,
		});
		// a slinger and a sentry post whose templates name no range: a tower's reach
		const slinger = makeEntity({ id: 7, owner: 2, position: [70, 70], classes: ["Unit", "Ranged"] }, {
			"attackTypes": () => ["Ranged"],
			"attackRange": () => undefined,
		});
		const sentry = makeEntity({ id: 6, owner: 2, position: [60, 60], classes: ["Structure", "Tower"] }, {
			"hasDefensiveFire": () => true,
			"attackRange": () => undefined,
		});
		const gameState = fake<CommonGameState>({
			"getEnemyEntities": () => ({
				"values": () => [tower, house, archer, swordsman, wolf, sentry, slinger, trader].values(),
			}),
		});

		assert.deepEqual(shootersOf(gameState), [
			{ "pos": [10, 10], "range": 72 },
			{ "pos": [30, 30], "range": 60 },
			{ "pos": [40, 40], "range": 0 },
			{ "pos": [60, 60], "range": 60 },
			{ "pos": [70, 70], "range": 60 },
		]);
	});
});

describe("threats in reach", () =>
{
	const archer: Shooter = { "pos": worldPos(100, 100), "range": 40 };
	const swordsman: Shooter = { "pos": worldPos(200, 100), "range": 0 };

	it("of a point: within a shooter's range and the margin", () =>
	{
		assert.equal(
			threatsAt(worldPos(100, 100 + 40 + DANGER_MARGIN), [archer, swordsman]),
			1,
			"at the edge of the archer's reach",
		);
		assert.equal(threatsAt(worldPos(100, 100 + 40 + DANGER_MARGIN + 1), [archer, swordsman]), 0);
		assert.equal(threatsAt(worldPos(205, 100), [archer, swordsman]), 1, "beside the swordsman");
	});

	it("of a way: a shooter near any of its stretches counts once", () =>
	{
		// from (0, 160) east to (300, 160): 60 m from the archer, out of its 52 m
		assert.equal(threatsAlong(worldPos(0, 160), [worldPos(300, 160)], [archer, swordsman]), 0);
		// by (150, 110) then east: past the archer within reach, the swordsman within the margin
		assert.equal(threatsAlong(worldPos(0, 160), [worldPos(150, 110), worldPos(300, 100)], [archer, swordsman]), 2);
		assert.equal(
			threatsAlong(worldPos(100, 100), [worldPos(100, 100)], [archer]),
			1,
			"a way of no length, on the archer",
		);
	});
});
