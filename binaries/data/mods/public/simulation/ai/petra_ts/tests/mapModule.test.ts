/**
 * The map helpers (mapModule): where a structure may stand
 * (createObstructionMap), who owns a spot (createTerritoryMap) and where the
 * map's edge is (createBorderMap).
 *
 * The board is the HQ world's: 40x40 territory cells of 8 map units, each
 * holding 4x4 passability cells of 2. The territory is laid out in vertical
 * bands of ten cells: neutral (ix 0-9), ours (10-19), an ally's (20-29) and
 * an enemy's (30-39). The territory rules of the templates are the ones
 * the game ships (BuildRestrictions/Territory).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import {
	ENEMY, makeHqEntity, makeHqWorld, structureTemplate, PLAYER, MAP_CELLS, PASS_RATIO, passLand, passShore, passWater,
	type HqWorld, type HqWorldOptions
} from "./harness/hqWorld.ts";

const { createObstructionMap, createTerritoryMap, createBorderMap } = await loadPetraModule<{
	createObstructionMap(gameState: unknown, accessIndex: number | undefined, template?: unknown): { map: ArrayLike<number> };
	createTerritoryMap(gameState: unknown): {
		getOwner(pos: [number, number]): number;
		getOwnerIndex(index: number): number;
		isBlinking(pos: [number, number]): boolean;
	};
	createBorderMap(gameState: unknown): { map: ArrayLike<number> };
}>("mapModule");
const mapMask = await loadPetraModule<{ outside: number; border: number }>("mapMask");

const ALLY = 3;
const PASS_WIDTH = MAP_CELLS * PASS_RATIO;

/** the owner of each band of the board */
function bandOwner(ix: number): number
{
	return ix < 10 ? 0 : ix < 20 ? PLAYER : ix < 30 ? ALLY : ENEMY;
}

/** The board, with the ally made mutual; row iy 30 of our band and of the ally's is decaying. */
function board(options: HqWorldOptions = {}): HqWorld
{
	const blinkingCells: string[] = [];
	for (let ix = 10; ix < 30; ++ix)
		blinkingCells.push(`${ix},30`);
	const world = makeHqWorld({ "territoryOwner": (ix) => bandOwner(ix), blinkingCells, ...options });
	(world.gameState.playerData as { isMutualAlly: boolean[] }).isMutualAlly[ALLY] = true;
	return world;
}

/** whether the passability cell at the center of a territory cell is free to build on */
function free(map: { map: ArrayLike<number> }, ix: number, iy: number): boolean
{
	const px = ix * PASS_RATIO + 2;
	const pz = iy * PASS_RATIO + 2;
	return map.map[px + pz * PASS_WIDTH] === 255;
}

/** free or not, for a territory cell of each band (row iy) */
function bands(map: { map: ArrayLike<number> }, iy: number): Record<string, boolean>
{
	return { "neutral": free(map, 5, iy), "own": free(map, 15, iy), "ally": free(map, 25, iy), "enemy": free(map, 35, iy) };
}

describe("obstruction map: the territories a structure may be built in", () =>
{
	it("a house (own territory only) stands only on our connected land", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2, structureTemplate("structures/athen/house", { "territories": ["own"] }));
		assert.deepEqual(bands(map, 20), { "neutral": false, "own": true, "ally": false, "enemy": false });
		// our land cut from its civil centre decays: no new house there
		assert.equal(free(map, 15, 30), false);
	});

	it("a civil centre (own, neutral) may also go on neutral land and on our decaying land", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2,
			structureTemplate("structures/athen/civil_centre", { "territories": ["own", "neutral"] }));
		assert.deepEqual(bands(map, 20), { "neutral": true, "own": true, "ally": false, "enemy": false });
		assert.equal(free(map, 15, 30), true);
	});

	it("a shrine (own, neutral, ally) may go on an ally's land, decaying or not", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2,
			structureTemplate("structures/maur/temple", { "territories": ["own", "neutral", "ally"] }));
		assert.deepEqual(bands(map, 20), { "neutral": true, "own": true, "ally": true, "enemy": false });
		assert.equal(free(map, 25, 30), true);
	});

	it("a pillar (own, ally) may go on an ally's connected land but not on its decaying land", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2,
			structureTemplate("structures/maur/pillar_ashoka", { "territories": ["own", "ally"] }));
		assert.deepEqual(bands(map, 20), { "neutral": false, "own": true, "ally": true, "enemy": false });
		assert.equal(free(map, 25, 30), false);
	});

	it("an army camp (neutral, enemy) goes on enemy and neutral land, never on ours", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2,
			structureTemplate("structures/rome/army_camp", { "territories": ["neutral", "enemy"] }));
		assert.deepEqual(bands(map, 20), { "neutral": true, "own": false, "ally": false, "enemy": true });
	});

	it("with no template the defaults hold: anywhere but enemy land, land placement", () =>
	{
		const world = board();
		const map = createObstructionMap(world.gameState, 2);
		assert.deepEqual(bands(map, 20), { "neutral": true, "own": true, "ally": true, "enemy": false });
	});
});

describe("obstruction map: the ground a structure may stand on", () =>
{
	it("a land structure stays off the water and the shore strip, and on the land region it was asked for", () =>
	{
		const world = board({
			// in our band: columns ix 12 water, 13 shore strip, the rest open land;
			// the rows iy >= 25 are another land region (an island)
			"passabilityData": (px) => Math.floor(px / PASS_RATIO) === 12 ? passWater :
				Math.floor(px / PASS_RATIO) === 13 ? passShore : passLand,
			"landPassMap": (px, pz) => Math.floor(px / PASS_RATIO) === 12 ? 1 : pz >= 25 * PASS_RATIO ? 4 : 2
		});
		const house = structureTemplate("structures/athen/house", { "territories": ["own"] });

		const map = createObstructionMap(world.gameState, 2, house);
		assert.equal(free(map, 12, 20), false);
		assert.equal(free(map, 13, 20), false);
		assert.equal(free(map, 15, 20), true);
		assert.equal(free(map, 15, 27), false);

		// asked with no land region (0), every land region counts
		const anywhere = createObstructionMap(world.gameState, 0, house);
		assert.equal(free(anywhere, 15, 27), true);
	});

	it("a dock stands on the shore strip, whatever the land region asked for", () =>
	{
		const world = board({
			"passabilityData": (px) => Math.floor(px / PASS_RATIO) === 12 ? passWater :
				Math.floor(px / PASS_RATIO) === 13 ? passShore : passLand
		});
		const dock = structureTemplate("structures/athen/dock",
			{ "territories": ["own", "ally", "neutral"], "placement": "shore" });

		const map = createObstructionMap(world.gameState, 4, dock);
		assert.equal(free(map, 13, 20), true);
		assert.equal(free(map, 12, 20), false);
		// open land far from water is no place for a dock
		assert.equal(free(map, 15, 20), false);
	});
});

describe("obstruction map: distance rules between structures", () =>
{
	/** a tower of the given owner on the given spot */
	function tower(world: HqWorld, id: number, owner: number, position: [number, number]): void
	{
		world.addEntity(makeHqEntity({ id, owner, position, "classes": ["Structure", "Tower", "Defensive"],
			"templateName": "structures/athen/sentry_tower" }));
	}
	const towerTemplate = structureTemplate("structures/athen/defense_tower", {
		"territories": ["own", "neutral"],
		"buildDistance": { "FromClass": "Tower", "MinDistance": 60 },
		"obstruction": { "min": 5, "max": 7 }
	});

	it("a new tower keeps 60 map units (less its own half-size) from our towers", () =>
	{
		const world = board({ "territoryOwner": () => PLAYER });
		tower(world, 500, PLAYER, [160, 160]);

		const map = createObstructionMap(world.gameState, 2, towerTemplate);

		// (60 - 5) / 2 + 1 = 28.5 passability cells around the tower are closed
		const at = (x: number, z: number) => map.map[Math.floor(x / 2) + Math.floor(z / 2) * PASS_WIDTH];
		assert.equal(at(160, 160), 0);
		assert.equal(at(160 + 50, 160), 0);
		assert.equal(at(160, 160 - 50), 0);
		assert.equal(at(160 + 62, 160), 255);
		assert.equal(at(100, 40), 255);
	});

	it("enemy towers and our other buildings do not count", () =>
	{
		const world = board({ "territoryOwner": () => PLAYER });
		tower(world, 501, ENEMY, [160, 160]);
		world.addEntity(makeHqEntity({ "id": 502, "owner": PLAYER, "position": [100, 100],
			"classes": ["Structure", "House"], "templateName": "structures/athen/house" }));

		const map = createObstructionMap(world.gameState, 2, towerTemplate);

		assert.equal(map.map[80 + 80 * PASS_WIDTH], 255);
		assert.equal(map.map[50 + 50 * PASS_WIDTH], 255);
	});

	it("a distance rule without a minimum closes nothing", () =>
	{
		const world = board({ "territoryOwner": () => PLAYER });
		tower(world, 503, PLAYER, [160, 160]);
		const map = createObstructionMap(world.gameState, 2, structureTemplate("structures/athen/defense_tower", {
			"buildDistance": { "FromClass": "Tower", "MinDistance": 0 }
		}));
		assert.equal(map.map[80 + 80 * PASS_WIDTH], 255);
	});
});

describe("territory map: who owns a spot", () =>
{
	it("reads the owner and the decay of a position", () =>
	{
		const world = board();
		const territory = createTerritoryMap(world.gameState);
		assert.equal(territory.getOwner([5 * 8 + 4, 100]), 0);
		assert.equal(territory.getOwner([15 * 8 + 4, 100]), PLAYER);
		assert.equal(territory.getOwner([25 * 8 + 4, 30 * 8 + 4]), ALLY);
		assert.equal(territory.getOwner([35 * 8 + 4, 100]), ENEMY);
		assert.equal(territory.getOwnerIndex(15 + 20 * MAP_CELLS), PLAYER);
		assert.equal(territory.isBlinking([15 * 8 + 4, 30 * 8 + 4]), true);
		assert.equal(territory.isBlinking([15 * 8 + 4, 20 * 8 + 4]), false);
	});
});

describe("border map: the edge of a round map", () =>
{
	it("off-map corners are outside; the ring still on the map is border; the middle is free", () =>
	{
		// the engine marks the area beyond the circle impassable for every class
		const centre = (PASS_WIDTH - 1) / 2;
		const world = makeHqWorld({
			"circularMap": true,
			"passabilityData": (px, pz) =>
				(px - centre) ** 2 + (pz - centre) ** 2 > (PASS_WIDTH / 2) ** 2 ? passWater | 0x8 : passLand
		});

		const map = createBorderMap(world.gameState);

		const at = (ix: number, iy: number) => map.map[ix + iy * MAP_CELLS];
		assert.equal(at(0, 0), mapMask.outside);
		assert.equal(at(39, 39), mapMask.outside);
		// on the map's circle but within the 80-map-unit ring
		assert.equal(at(20, 1), mapMask.border);
		assert.equal(at(1, 20), mapMask.border);
		// the middle of the map and just inside the ring
		assert.equal(at(20, 20), 0);
		assert.equal(at(20, 11), 0);
	});
});
