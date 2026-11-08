/**
 * The entity helpers every manager leans on (entityExtend): unit strength,
 * land and sea access, capture decisions, where a worker drops its load,
 * which base an entity belongs to, and treasure hunting.
 *
 * Most of these run inside other campaigns; this suite covers the branches
 * those campaigns never reach.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logs, resetRecorder } from "./harness/engine.ts";
import { makeEntity, makeTemplate, override, type Methods } from "./harness/fakes.ts";
import { ENEMY, PLAYER, collectionOf, makeWorld, type World } from "./harness/world.ts";

import { templateName } from "../adapter/brands.ts";
import * as ext from "../adapter/entityExtend.ts";
import { getBestBase } from "../decision/baseManager.ts";

/** the real Config's damage weights */
const IMPORTANCE = { Hack: 0.075, Pierce: 0.085, Crush: 0.045, Fire: 0.001 };
const ALLY = 3;

function close(actual: number, expected: number): void
{
	assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

describe("getMaxStrength: how strong a unit template is", () =>
{
	/** an archer as the game ships it: a ranged attack, a slaughter attack for hunting */
	const archer = (extra: Methods = {}) =>
		override(
			makeTemplate("units/athen/infantry_archer_b", {
				attackTypes: ["Ranged", "Slaughter"],
				attackStrengths: { Ranged: { Pierce: 6 }, Slaughter: { Hack: 100 } },
				attackRanges: { Ranged: { max: 60 } },
				attackTimes: { Ranged: { prepare: 500, repeat: 1000 } },
				resistanceStrengths: { Hack: 1, Pierce: 1, Crush: 1 },
				maxHitpoints: 50,
			}),
			{ getMultiplierAgainst: () => 1, ...extra },
		);

	it("weighs damage, range, rate of fire and armour by hitpoints; the hunting attack does not count", () =>
	{
		const expected = (0.085 * 6 / 4 + 60 * 0.0125 + 1000 / 1e5 - 500 / 1e5 + (0.075 + 0.085 + 0.045) * 1 / 4) * 50 /
			100;
		close(ext.getMaxStrength(archer(), 0, IMPORTANCE), expected);
	});

	it("against a class the damage is multiplied by the unit's bonus against it", () =>
	{
		const vsCavalry = archer({ getMultiplierAgainst: (_type: string, cls: string) => cls === "Cavalry" ? 3 : 1 });
		const plain = ext.getMaxStrength(vsCavalry, 0, IMPORTANCE);
		const bonus = ext.getMaxStrength(vsCavalry, 0, IMPORTANCE, "Cavalry");
		close(bonus - plain, 0.085 * 6 * 2 / 4 * 50 / 100);
	});

	it("a damage type the config does not weigh counts for nothing, and is reported when debugging", () =>
	{
		const poisoner = makeTemplate("units/mod/poisoner", {
			attackTypes: ["Ranged"],
			attackStrengths: { Ranged: { Poison: 10 } },
			attackTimes: { Ranged: { prepare: 0, repeat: 1000 } },
			resistanceStrengths: { Poison: 5 },
		});
		resetRecorder();
		close(ext.getMaxStrength(poisoner, 0, IMPORTANCE), 1000 / 1e5);
		assert.equal(logs.length, 0);

		ext.getMaxStrength(poisoner, 1, IMPORTANCE);
		assert.ok(logs.some((line) => line.includes("Poison unknown attackStrength")));
		assert.ok(logs.some((line) => line.includes("Poison unknown resistanceStrength")));
	});

	it("a template without any attack has no strength (its armour is not weighed either)", () =>
	{
		const house = makeTemplate("structures/athen/house", { resistanceStrengths: { Hack: 20 } });
		assert.equal(ext.getMaxStrength(house, 0, IMPORTANCE), 0);
	});
});

describe("land and sea access", () =>
{
	it("a garrisoned unit is where its holder is", () =>
	{
		const world = makeWorld();
		world.accessAt.set("50,50", 4);
		const soldier = world.addEntity(makeEntity({ id: 10, owner: PLAYER, classes: ["Unit", "Infantry"] }));
		world.addEntity(
			makeEntity({ id: 11, owner: PLAYER, position: [50, 50], classes: ["Unit", "Ship"] }, {
				isGarrisonHolder: () => true,
				garrisoned: () => [10],
			}),
		);
		assert.equal(ext.getLandAccess(world.gameState, soldier), 4);
	});

	it("a unit nowhere at all is reported, with its details, and has no access", () =>
	{
		const world = makeWorld();
		const lost = world.addEntity(makeEntity({ id: 12, owner: PLAYER, classes: ["Unit", "Infantry"] }));
		resetRecorder();
		assert.equal(ext.getLandAccess(world.gameState, lost), undefined);
		assert.ok(logs.some((line) => line.includes("entity without position, but not garrisoned")));
		assert.ok(logs.some((line) => line.includes(" >>> id 12")));
	});

	it("a structure's access is computed once and kept", () =>
	{
		const world = makeWorld();
		world.accessAt.set("100,100", 3);
		const house = world.addEntity(
			makeEntity({ id: 13, owner: PLAYER, position: [100, 100], classes: ["Structure"] }),
		);
		assert.equal(ext.getLandAccess(world.gameState, house), 3);
		world.accessAt.set("100,100", 5);
		assert.equal(ext.getLandAccess(world.gameState, house), 3);
	});

	/** a dock standing in the water at [100,100], facing north (angle 0) */
	function dock(world: World, id: number, footprint: Record<string, string>): CommonEntity
	{
		return world.addEntity(
			makeEntity({ id, owner: PLAYER, position: [100, 100], classes: ["Structure", "Dock"] }, {
				buildPlacementType: () => "shore",
				get: (path: string) =>
					path in footprint ?
						footprint[path] :
						path === "Footprint/Square" && "Footprint/Square/@depth" in footprint ||
							path === "Footprint/Circle" && "Footprint/Circle/@radius" in footprint ?
						{} :
						undefined,
			}),
		);
	}

	it("a dock whose centre is in the water finds its land behind it, within half its depth", () =>
	{
		const world = makeWorld();
		world.accessAt.set("100,100", 1);
		world.accessAt.set("100,97", 1);
		world.accessAt.set("100,94", 2);
		const square = dock(world, 14, { "Footprint/Square/@depth": "20" });
		assert.equal(ext.getLandAccess(world.gameState, square), 2);
		assert.equal(square.getMetadata(PLAYER, "access"), 2);
	});

	it("a round dock looks as far as its radius", () =>
	{
		const world = makeWorld();
		world.accessAt.set("100,100", 1);
		world.accessAt.set("100,97", 1);
		world.accessAt.set("100,94", 1);
		world.accessAt.set("100,91", 2);
		assert.equal(ext.getLandAccess(world.gameState, dock(world, 15, { "Footprint/Circle/@radius": "10" })), 2);
		// a smaller one stops short of the land
		const world2 = makeWorld();
		world2.accessAt.set("100,100", 1);
		world2.accessAt.set("100,97", 1);
		world2.accessAt.set("100,94", 1);
		world2.accessAt.set("100,91", 2);
		assert.equal(ext.getLandAccess(world2.gameState, dock(world2, 16, { "Footprint/Circle/@radius": "7" })), 1);
	});

	it("a dock whose centre is on land finds its sea in front of it", () =>
	{
		const world = makeWorld();
		const sea = new Map<string, number>([["100,100", 1], ["100,103", 1], ["100,106", 5]]);
		override(world.ai.accessibility, {
			getAccessValue: (pos: [number, number], onWater?: boolean) =>
				onWater ? sea.get(`${pos[0]},${pos[1]}`) ?? 1 : 2,
		});
		const harbour = dock(world, 17, {});
		assert.equal(ext.getSeaAccess(world.gameState, harbour), 5);
		assert.equal(harbour.getMetadata(PLAYER, "sea"), 5);
	});
});

// the require helpers are the port's own (the original reads the values unchecked)
describe("the require helpers: values Petra relies on", () =>
{
	it("each returns what is there and throws, after a warning, on what is missing", () =>
	{
		const world = makeWorld();
		world.templates["units/athen/support_female_citizen"] = makeTemplate("units/athen/support_female_citizen");
		assert.equal(
			ext.requireTemplate(world.gameState, templateName("units/athen/support_female_citizen")),
			world.templates["units/athen/support_female_citizen"],
		);
		const ship = makeEntity({ id: 20, owner: PLAYER, classes: ["Unit", "Ship"] }, {}, { sea: 4 });
		assert.equal(ext.requireMetadata(ship, "sea"), 4);
		assert.equal(ext.requireValue(0), 0);

		resetRecorder();
		assert.throws(
			() => ext.requireTemplate(world.gameState, templateName("units/athen/nothing")),
			/template units\/athen\/nothing not found/,
		);
		assert.throws(() => ext.requireMetadata(ship, "base"), /metadata base not found on entity 20/);
		assert.throws(() => ext.requireValue(undefined), /required value was unexpectedly undefined/);
		assert.equal(logs.length, 3);
	});
});

describe("getAttackBonus", () =>
{
	it("a bonus restricted to another civilization does not apply", () =>
	{
		const bonuses = {
			BonusCiv: { Civ: "maur", Multiplier: "2" },
			BonusStructure: { Classes: "Structure", Multiplier: "1.5" },
		};
		const ent = makeEntity({ id: 40, owner: PLAYER, classes: ["Unit"] }, {
			get: (path: string) =>
				path === "Attack/Capture" ? {} : path === "Attack/Capture/Bonuses" ? bonuses : undefined,
		});
		const athen = makeEntity({ id: 41, owner: ENEMY, classes: ["Structure"] }, { civ: () => "athen" });
		const maur = makeEntity({ id: 42, owner: ENEMY, classes: ["Structure"] }, { civ: () => "maur" });
		close(ext.getAttackBonus(ent, athen, "Capture"), 1.5);
		close(ext.getAttackBonus(ent, maur, "Capture"), 3);
	});
});

describe("returnResources: where a worker drops its load", () =>
{
	/** a world with shared dropsites (the allies researched it) and a loaded woodcutter at [100,100] */
	function sharedWorld(): { world: World; worker: CommonEntity; dropped: CommonEntity[]; }
	{
		const world = makeWorld();
		world.gameState.playerData.hasSharedDropsites = true;
		world.gameState.playerData.isAlly[ALLY] = true;
		world.gameState.playerData.isMutualAlly[ALLY] = true;
		world.gameState.playerData.isAlly[ENEMY] = true; // we ally them, they do not ally us
		world.gameState.getAnyDropsites = () =>
			collectionOf(world, world.structures.filter((s) => s.hasClass("Storehouse")));
		const dropped: CommonEntity[] = [];
		const worker = world.addEntity(
			makeEntity({ id: 50, owner: PLAYER, position: [100, 100], classes: ["Unit", "Worker"] }, {
				resourceCarrying: () => [{ type: "wood", amount: 10 }],
				returnResources: (dropsite: CommonEntity) => dropped.push(dropsite),
			}),
		);
		return { world, worker, dropped };
	}
	function storehouse(world: World, id: number, owner: number, position: [number, number], access = 2): CommonEntity
	{
		return world.addEntity(
			makeEntity(
				{ id, owner, position, classes: ["Structure", "Storehouse"] },
				{ isSharedDropsite: () => true },
				{ access: access },
			),
		);
	}

	it("the nearest storehouse on our land, ours or a mutual ally's", () =>
	{
		const { world, worker, dropped } = sharedWorld();
		storehouse(world, 52, ALLY, [150, 100]);
		storehouse(world, 51, PLAYER, [200, 100]);
		// nearer, but its owner does not ally us back
		storehouse(world, 53, ENEMY, [120, 100]);
		// nearest of all, across the water
		storehouse(world, 54, PLAYER, [105, 100], 4);

		assert.equal(ext.returnResources(world.gameState, worker), true);
		assert.deepEqual(dropped.map((d) => d.id()), [52]);
	});

	it("no storehouse within reach: the load stays carried", () =>
	{
		const { world, worker, dropped } = sharedWorld();
		storehouse(world, 55, PLAYER, [105, 100], 4);
		assert.equal(ext.returnResources(world.gameState, worker), false);
		assert.deepEqual(dropped, []);
	});
});

describe("getBestBase (decision/baseManager.ts): the base an entity belongs to", () =>
{
	interface FakeBase
	{
		ID: number;
		anchor: CommonEntity | undefined;
		accessIndex: number;
		buildings: unknown;
	}

	/** bases replace the world's default one; the first is the baseless base */
	function withBases(world: World, bases: FakeBase[]): FakeBase
	{
		const baseless: FakeBase = { ID: 0, anchor: undefined, accessIndex: 0, buildings: collectionOf(world, []) };
		const all = [baseless, ...bases];
		const hq = world.ai.HQ as unknown as Record<string, unknown>;
		hq.basesManager = { baseManagers: all, baselessBase: () => baseless };
		return baseless;
	}
	function anchor(world: World, id: number, position: [number, number], foundation = false): CommonEntity
	{
		return world.addEntity(
			makeEntity({ id, owner: PLAYER, position, classes: ["Structure", "CivCentre"] }, {
				foundationProgress: () => foundation ? 40 : undefined,
			}),
		);
	}
	const base = (
		world: World,
		ID: number,
		a: CommonEntity | undefined,
		accessIndex = 2,
		buildings: CommonEntity[] = [],
	): FakeBase => ({ ID, anchor: a, accessIndex, buildings: collectionOf(world, buildings) });

	it("the nearest base wins; excluded and unfinished ones are passed over when asked", () =>
	{
		const world = makeWorld();
		const near = base(world, 1, anchor(world, 60, [100, 100], true));
		const far = base(world, 2, anchor(world, 61, [300, 300]));
		withBases(world, [near, far]);
		const unit = world.addEntity(makeEntity({ id: 62, owner: PLAYER, position: [110, 100], classes: ["Unit"] }));

		assert.equal(getBestBase(world.gameState, unit), near);
		assert.equal(getBestBase(world.gameState, unit, false, 1), far);
		assert.equal(getBestBase(world.gameState, unit, true), far);
	});

	it("a base without a civil centre is placed by its first building, and loses to any anchored base", () =>
	{
		const world = makeWorld();
		const outpost = base(world, 1, undefined, 2, [
			world.addEntity(
				makeEntity({ id: 70, owner: PLAYER, position: [100, 100], classes: ["Structure", "Storehouse"] }),
			),
		]);
		const empty = base(world, 2, undefined);
		const town = base(world, 3, anchor(world, 71, [300, 300]));
		withBases(world, [outpost, empty]);
		const unit = world.addEntity(makeEntity({ id: 72, owner: PLAYER, position: [110, 100], classes: ["Unit"] }));
		assert.equal(getBestBase(world.gameState, unit), outpost);

		withBases(world, [outpost, empty, town]);
		assert.equal(getBestBase(world.gameState, unit), town);
	});

	it("a garrisoned unit belongs where its holder stands", () =>
	{
		const world = makeWorld();
		world.accessAt.set("300,300", 2);
		const west = base(world, 1, anchor(world, 80, [100, 100]));
		const east = base(world, 2, anchor(world, 81, [300, 310]));
		withBases(world, [west, east]);
		world.addEntity(makeEntity({ id: 82, owner: PLAYER, classes: ["Unit", "Infantry"] }));
		world.addEntity(
			makeEntity({ id: 83, owner: PLAYER, position: [300, 300], classes: ["Structure", "Tower"] }, {
				isGarrisonHolder: () => true,
				garrisoned: () => [82],
			}),
		);
		assert.equal(getBestBase(world.gameState, world.ents.get(82)!), east);
	});

	it("a unit nowhere is reported and goes to the baseless base", () =>
	{
		const world = makeWorld();
		const baseless = withBases(world, [base(world, 1, anchor(world, 90, [100, 100]))]);
		resetRecorder();
		const lost = world.addEntity(makeEntity({ id: 91, owner: PLAYER, classes: ["Unit"] }));
		assert.equal(getBestBase(world.gameState, lost), baseless);
		assert.ok(logs.some((line) => line.includes("entity without position, but not garrisoned")));
	});
});

describe("dumpEntity", () =>
{
	it("nothing to dump, nothing logged", () =>
	{
		resetRecorder();
		ext.dumpEntity(undefined);
		assert.deepEqual(logs, []);
	});
});
