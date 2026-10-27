/**
 * Base manager: one town's ground and the people and dropsites on it. The
 * suites seat a real Headquarters on the small engine-truthful board (see
 * tests/harness/hqWorld.ts) and then read the seated town's own base manager,
 * the way the office does: its ground, its anchor, its dropsite books, its
 * workers and the foundations they raise.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logs, resetRecorder } from "./harness/engine.ts";
import { emptyEvents, fake, orders, override } from "./harness/fakes.ts";
import {
	doorManagers, dropsiteCC, ENEMY, type HqSeatOptions, type HqWorld, type HqWorldOptions,
	makeGaiaSupply, makeHqEntity, makeHqWorld, PLAYER, seatHQ, structureTemplate, territoryCellAt
} from "./harness/hqWorld.ts";

import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";

import { GAIA, entityId, templateName, worldPos } from "../adapter/brands.ts";
import { BaseManager } from "../decision/baseManager.ts";
import { EASY, HARD, MEDIUM } from "../decision/difficultyLevel.ts";
import type { Headquarters } from "../decision/headquarters.ts";
import type { DefenseArmy } from "../execution/defenseArmy.ts";
import { Worker } from "../execution/worker.ts";

// the player id the common-api reads metadata under
const PlayerID = PLAYER;
/** a seated office on the standard board, and its own town */
function seat(worldOptions: Partial<HqWorldOptions> = {}, seatOptions: Partial<HqSeatOptions> = {})
{
	const world = makeHqWorld(worldOptions);
	const hq = seatHQ(world, { stubs: doorManagers, ...seatOptions });
	// the game books the town's ground before any plan is made (gameAnalysis)
	hq.updateTerritories(world.gameState);
	const base = hq.baseManagers()[0];
	return { world, hq, base };
}

/** a storehouse of ours, dropping wood (and food, when asked) */
function storehouse(world: HqWorld, id: number, position: [number, number], types: string[] = ["wood"]): ReturnType<typeof makeHqEntity>
{
	return world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position,
		"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
	}, {
		"resourceDropsiteTypes": () => types,
		// the common-api answers this from the resource types; the entity fake's default is false
		"isResourceDropsite": (resource?: string) => !resource || types.includes(resource)
	}));
}

/** the wood a base books for each reach of a dropsite, by supply id */
function booked(base: { dropsiteSupplies: Record<string, Record<string, Array<{ id: number }>>> }, type: string, band: string): number[]
{
	return base.dropsiteSupplies[type][band].map((supply) => supply.id);
}

describe("the town's ground: how its base is founded, kept and lost", () =>
{
	it("a ground being founded is constructing, and asks for no defenders", () =>
	{
		const { world, base } = seat({ "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });

		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);

		assert.equal(base.constructing, true, "the centre is still going up");
		assert.equal(base.neededDefenders, 0, "no garrison is asked until the centre stands");
	});

	it("a captured ground asks for defenders on a medium-or-harder board, and for none on an easy one", () =>
	{
		const { world, hq, base } = seat();

		hq.Config.difficulty = HARD;
		base.reset(world.gameState, BaseManager.STATE_CAPTURED);
		assert.equal(base.neededDefenders, 3 + 2 * (HARD - 3), "the captured centre is garrisoned against the old owner");

		hq.Config.difficulty = EASY;
		base.reset(world.gameState, BaseManager.STATE_CAPTURED);
		assert.equal(base.neededDefenders, 0, "an easy board does not ask a garrison of a captured centre");

		hq.Config.difficulty = MEDIUM;
		base.reset(world.gameState, BaseManager.STATE_CAPTURED);
		assert.equal(base.neededDefenders, 3, "the medium board's garrison is the base three");
	});

	it("a ground back under its own centre is no longer constructing, and asks for no defenders", () =>
	{
		const { world, hq, base } = seat();
		hq.Config.difficulty = HARD;
		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);

		base.reset(world.gameState, BaseManager.STATE_WITH_ANCHOR);

		assert.equal(base.constructing, false);
		assert.equal(base.neededDefenders, 0);
	});

	it("a centre lost to a raid leaves the ground without an anchor and without an active count", () =>
	{
		const { world, hq, base } = seat();
		assert.equal(hq.numActiveBases(), 1, "the seated centre makes the town one active base");

		base.anchorLost(world.gameState);

		assert.equal(base.anchor, undefined);
		assert.equal(base.anchorId, undefined);
		assert.equal(base.neededDefenders, 0, "a ground with no centre has no garrison to ask for");
		assert.equal(hq.numActiveBases(), 0, "the town no longer counts as an active base");
	});
});

describe("the dropsites: what each one reaches, by distance band", () =>
{
	it("a storehouse books the trees near it in nearby, medium and faraway bands, by distance", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40]);
		world.addEntity(makeGaiaSupply({ "id": 2601, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		world.addEntity(makeGaiaSupply({ "id": 2602, "position": [160, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		world.addEntity(makeGaiaSupply({ "id": 2603, "position": [250, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		// a tree beyond the reach of any dropsite on this board: the far corner, past 360 units
		world.addEntity(makeGaiaSupply({ "id": 2604, "position": [300, 300], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "wood", "nearby"), [2601], "the tree beside the storehouse");
		assert.deepEqual(booked(base, "wood", "medium"), [2602], "the grove a stone's throw out");
		assert.deepEqual(booked(base, "wood", "faraway"), [2603], "the far stand, still within the town's reach");
	});

	it("each band is ordered from the nearest supply to the farthest", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40]);
		world.addEntity(makeGaiaSupply({ "id": 2611, "position": [70, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		world.addEntity(makeGaiaSupply({ "id": 2612, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "wood", "nearby"), [2612, 2611]);
	});

	it("the far band is ordered too", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40]);
		world.addEntity(makeGaiaSupply({ "id": 2631, "position": [260, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		world.addEntity(makeGaiaSupply({ "id": 2632, "position": [240, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "wood", "faraway"), [2632, 2631]);
	});

	it("animals roam past the dropsites and are not booked as a fixed supply", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40], ["wood", "food"]);
		world.addEntity(makeGaiaSupply({ "id": 2621, "position": [50, 40], "generic": "food", "specific": "deer", "classes": ["Animal"] }));
		world.addEntity(makeGaiaSupply({ "id": 2622, "position": [50, 50], "generic": "food", "specific": "berry", "classes": ["Fruit"] }));

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "food", "nearby"), [2622], "the berry bush is booked, the deer is not");
	});

	it("a supply on another landmass is out of the storehouse's reach by land", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40]);
		// the grove stands across the water, on a landmass that is not the town's
		world.accessAt.set("60,60", 3);
		world.addEntity(makeGaiaSupply({ "id": 2631, "position": [60, 60], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "wood", "nearby"), [], "the island's tree is not this town's to cut");
	});

	it("a storehouse destroyed clears its own books, and the office no longer counts it", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 2501, [40, 40]);
		world.addEntity(makeGaiaSupply({ "id": 2651, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		base.assignResourceToDropsite(world.gameState, dropsite, false);

		base.removeDropsite(world.gameState, entityId(2501));

		assert.deepEqual(booked(base, "wood", "nearby"), []);
		assert.equal(base.dropsites[2501], undefined, "the dropsite is off the town's list");
	});

	// port-only: the reference's removeSupply is guarded by a supply[i].ent
	// field that nothing ever writes, so it always fires: removing one
	// dropsite there splices every dropsite book of the player. The port keeps
	// the entries booked by the surviving dropsites (see baseManager.ts).
	it("a storehouse destroyed leaves the other dropsites' books untouched", () =>
	{
		const { world, base } = seat();
		const store = storehouse(world, 3701, [40, 40]);
		// the seed centre takes food and wood as well, and carries supplies of its own
		const centre = dropsiteCC(world);
		world.addEntity(makeGaiaSupply({
			"id": 3702, "position": [10, 30], "generic": "food", "specific": "berry", "classes": ["Fruit"]
		}));
		world.addEntity(makeGaiaSupply({
			"id": 3703, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"]
		}));

		base.assignResourceToDropsite(world.gameState, centre, false);
		base.assignResourceToDropsite(world.gameState, store, false);

		base.removeDropsite(world.gameState, entityId(3701));

		assert.deepEqual(booked(base, "food", "nearby"), [3702], "the centre keeps its berries");
		assert.deepEqual(booked(base, "wood", "nearby"), [3703], "the centre keeps its own wood note");
		assert.equal(base.dropsites[3701], undefined, "the destroyed storehouse is off the list");
	});
});

/** the storehouse card the town knows, and a builder who books it */
function storehouseCard(world: HqWorld, hq: Headquarters): void
{
	world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse", {
		"classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood", "stone", "metal"]
	});
	bookBuilder(world, hq, ["structures/{civ}/storehouse"]);
}

/** a builder of ours who knows the named cards */
function bookBuilder(world: HqWorld, hq: Headquarters, buildable: string[]): void
{
	world.addEntity(makeHqEntity({
		"id": 2206, "owner": PLAYER, "position": [152, 152],
		"classes": ["Unit", "Support", "Worker"]
	}, {
		"buildableEntities": (civ: string) => buildable.map((name) => name.replace("{civ}", civ))
	}));
	hq.buildManager.init(world.gameState);
}

/** the resource map cell of a map position, as the board reads it */
/** the resource map of a resource, as the office's gatherers' estimate reads it */
function resourceMap(world: HqWorld, type: string): Float32Array
{
	return (world.gameState.sharedScript as unknown as
		Record<string, Record<string, { map: Float32Array }>>).resourceMaps[type].map;
}

/** a stand of trees the wood estimate counts at the given position */
function woodCluster(world: HqWorld, centre: [number, number]): void
{
	const map = resourceMap(world, "wood");
	for (const dx of [-8, 0, 8])
		for (const dz of [-8, 0, 8])
			map[territoryCellAt([centre[0] + dx, centre[1] + dz])] = 100;
}

describe("finding where a new dropsite should stand", () =>
{
	it("a wood cluster with no storehouse: the best spot is by the trees", () =>
	{
		const { world, hq, base } = seat();
		storehouseCard(world, hq);
		woodCluster(world, [150, 150]);

		const best = base.findBestDropsiteAndLocation(world.gameState, "wood");

		assert.equal(best.templateName, "structures/athen/storehouse");
		assert.ok(best.quality > 50, "a stand of that size is worth a storehouse");
		assert.ok(Math.abs(best.pos[0] - 150) <= 40 && Math.abs(best.pos[1] - 150) <= 40,
			"the storehouse goes where the trees are");
	});

	it("a spot within sixty units of an existing storehouse is not chosen, however rich the stand", () =>
	{
		const { world, hq, base } = seat();
		storehouseCard(world, hq);
		woodCluster(world, [150, 150]);
		const existing = storehouse(world, 2502, [150, 150]);
		base.assignResourceToDropsite(world.gameState, existing, false);

		const best = base.findBestDropsiteAndLocation(world.gameState, "wood");

		const dx = best.pos[0] - 150, dz = best.pos[1] - 150;
		assert.ok(dx * dx + dz * dz >= 3600, "a new storehouse does not crowd the one already standing");
	});

	it("a spot sixty to eighty units from a storehouse is worth less, in proportion", () =>
	{
		const quality = (withStorehouse: boolean) =>
		{
			const { world, hq, base } = seat();
			storehouseCard(world, hq);
			// one rich cell, whose centre is [148, 148]
			resourceMap(world, "wood")[territoryCellAt([150, 150])] = 100;
			if (withStorehouse)
				storehouse(world, 2502, [220, 148]);
			return base.findBestDropsiteAndLocation(world.gameState, "wood").quality;
		};
		const alone = quality(false);
		// 72 units away: (72 - 60) / 20 of the value
		assert.ok(Math.abs(quality(true) - alone * 0.6) < 1e-6);
	});

	it("a stand under an enemy tower's arrows is passed over; a bigger storehouse feels the arrows from farther", () =>
	{
		const best = (footprint: Record<string, unknown> | undefined) =>
		{
			const { world, hq, base } = seat();
			world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse", {
				"classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood", "stone", "metal"],
				"getPaths": footprint ? { "Footprint": footprint } : {}
			});
			bookBuilder(world, hq, ["structures/{civ}/storehouse"]);
			// an enemy tower shooting 60 far over the richest stand
			world.addEntity(makeHqEntity({ "id": 2510, "owner": ENEMY, "position": [148, 148],
				"classes": ["Structure", "Tower"] }, {
				"hasDefensiveFire": () => true, "attackRange": () => ({ "max": 60, "min": 0 })
			}));
			const map = resourceMap(world, "wood");
			map[territoryCellAt([150, 150])] = 100;			// under the tower
			map[territoryCellAt([214, 150])] = 90;			// 64 from the tower
			map[territoryCellAt([150, 246])] = 50;			// 96 from the tower
			const { pos } = base.findBestDropsiteAndLocation(world.gameState, "wood");
			// the stand the chosen spot belongs to
			const stands: Record<string, [number, number]> = { "under": [148, 148], "near": [212, 148], "far": [148, 244] };
			return Object.keys(stands).find((name) =>
				Math.abs(stands[name][0] - pos[0]) <= 8 && Math.abs(stands[name][1] - pos[1]) <= 8);
		};
		// a point-sized storehouse is safe 64 away
		assert.equal(best(undefined), "near");
		// a 12-wide one (half-size 6) is not: it goes to the far stand
		assert.equal(best({ "Square": { "@depth": "12", "@width": "10" } }), "far");
		assert.equal(best({ "Circle": { "@radius": "6" } }), "far");
	});

	it("a map without trees offers no dropsite worth building", () =>
	{
		const { world, hq, base } = seat();
		storehouseCard(world, hq);

		const best = base.findBestDropsiteAndLocation(world.gameState, "wood");

		assert.equal(best.quality, 0, "no stand, no spot");
	});

	it("a centre is never the dropsite the search proposes; the office raises those itself", () =>
	{
		const { world, base } = seat();
		world.templates["structures/athen/civil_centre"] = structureTemplate("structures/athen/civil_centre", {
			"classes": ["Structure", "CivCentre"], "dropsiteTypes": ["wood"]
		});
		woodCluster(world, [150, 150]);

		const found = base.findBestDropsiteLocation(world.gameState, "wood", templateName("structures/athen/civil_centre"));

		assert.equal(found.quality, 0);
	});
});

describe("the town's food and its gatherers: checkResourceLevels", () =>
{
	const FIELD = "structures/athen/field";
	const CORRAL = "structures/athen/corral";

	/** the fields and pens the town may plant, as the civ knows them */
	function farmCards(world: HqWorld, hq: Headquarters, withField = true): void
	{
		if (withField)
			world.templates[FIELD] = structureTemplate(FIELD, { "classes": ["Structure", "Economic", "Field"] });
		world.templates[CORRAL] = structureTemplate(CORRAL, { "classes": ["Structure", "Corral"] });
		bookBuilder(world, hq, withField ? ["structures/{civ}/field", "structures/{civ}/corral"] : ["structures/{civ}/corral"]);
	}

	/** berries of the given amount near the seated centre, booked by it */
	function berries(world: HqWorld, base: BaseManager, amount: number): void
	{
		const centre = dropsiteCC(world);
		if (amount > 0)
			world.addEntity(makeGaiaSupply({
				"id": 2701, "position": [30, 10], "generic": "food", "specific": "berry",
				"classes": ["Fruit"], "amount": amount
			}));
		base.assignResourceToDropsite(world.gameState, centre, false);
	}

	it("a town with enough fruit in reach plants no field yet", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq);
		berries(world, base, 700);

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.field.plans.length, 0, "the bushes feed the town for now");
		assert.ok(!hq.needFarm, "no field asked for while the bushes last");
	});

	it("a town with little fruit in reach plants its first field, favoured to its base", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq);
		berries(world, base, 200);

		base.checkResourceLevels(world.gameState, world.ai.queues);

		const plans = world.ai.queues.field.plans;
		assert.equal(plans.length, 1);
		assert.equal(plans[0]?.type, FIELD);
		assert.equal(plans[0]?.metadata?.favoredBase, base.ID);
		assert.equal(hq.needFarm, true);
	});

	it("with a field standing, the next field is planned while the town is short of its goal", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq);
		berries(world, base, 0);
		hq.maxFields = false;
		world.addEntity(makeHqEntity({
			"id": 2702, "owner": PLAYER, "position": [60, 60],
			"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
		}));

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.field.plans.length, 1);
	});

	it("once the town's fields reach the provisioned goal, no further field is planned", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq);
		berries(world, base, 0);
		hq.maxFields = false;
		world.addEntity(makeHqEntity({
			"id": 2702, "owner": PLAYER, "position": [60, 60],
			"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
		}));
		// the goal is the civ's provisioned count; the ground already carries that many field foundations
		const goal = hq.Config.Economy.provisionFields;
		for (let i = 0; i < goal; ++i)
			world.addEntity(makeHqEntity({
				"id": 2710 + i, "owner": PLAYER, "position": [70 + 4 * i, 70],
				"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
			}, { "foundationProgress": () => 0.2 }));

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.field.plans.length, 0);
	});

	it("a town saving its resources makes do with one field foundation fewer", () =>
	{
		for (const saving of [false, true])
		{
			const { world, hq, base } = seat();
			farmCards(world, hq);
			berries(world, base, 0);
			hq.maxFields = false;
			hq.saveResources = saving || undefined;
			world.addEntity(makeHqEntity({
				"id": 2702, "owner": PLAYER, "position": [60, 60],
				"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
			}));
			// one field already being laid out
			world.addEntity(makeHqEntity({
				"id": 2703, "owner": PLAYER, "position": [70, 70],
				"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
			}, { "foundationProgress": () => 0.2 }));

			base.checkResourceLevels(world.gameState, world.ai.queues);

			// provisionFields is 2: one more while not saving, none when saving
			assert.equal(world.ai.queues.field.plans.length, saving ? 0 : 1, `saving ${saving}`);
		}
	});

	it("at the town's field cap, a pen is planted for the herd it needs", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq);
		berries(world, base, 0);
		world.addEntity(makeHqEntity({
			"id": 2702, "owner": PLAYER, "position": [60, 60],
			"classes": ["Structure", "Economic", "Field"], "templateName": FIELD
		}));
		hq.maxFields = 1;
		hq.needCorral = true;

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.field.plans.length, 0, "the cap is reached");
		assert.equal(world.ai.queues.corral.plans.length, 1, "the herd gets its pen");
	});

	it("a civ with no field card keeps a pen while the fruit runs short", () =>
	{
		const { world, hq, base } = seat();
		farmCards(world, hq, false);
		berries(world, base, 100);

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.corral.plans.length, 1);
		assert.equal(hq.needCorral, true);
	});

	it("a storehouse rising resets the gatherers' tally for that resource", () =>
	{
		const { world, base } = seat();
		base.gatherers.stone = { "nextCheck": 99, "used": 5, "lost": 9 };
		world.addEntity(makeHqEntity({
			"id": 2703, "owner": PLAYER, "position": [60, 60],
			"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
		}, { "foundationProgress": () => 0.3 }));

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.deepEqual(base.gatherers.stone, { "nextCheck": 0, "used": 0, "lost": 0 });
	});

	it("a resource with nobody gathering it is looked at again in ten turns", () =>
	{
		const { world, base } = seat();

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(base.gatherers.stone.nextCheck, 10);
	});

	it("gatherers lost on the walk home plan a storehouse closer to the stone", () =>
	{
		const { world, hq, base } = seat();
		storehouseCard(world, hq);
		// the tally accumulates across turns: most of the stone gatherers are walking home empty
		base.gatherers.stone = { "nextCheck": 0, "used": 30, "lost": 40 };
		resourceMap(world, "stone")[territoryCellAt([150, 150])] = 100;
		woodCluster(world, [150, 150]);

		base.checkResourceLevels(world.gameState, world.ai.queues);

		const plans = world.ai.queues.dropsites.plans;
		assert.equal(plans.length, 1);
		assert.equal(plans[0]?.type, "structures/athen/storehouse");
		assert.deepEqual(plans[0]?.metadata, { "base": base.ID, "type": "stone" });
		assert.equal(base.gatherers.stone.nextCheck, 20, "the tally is taken again in twenty turns");
	});

	it("a poor patch with a new ground open to the town is served by a new ground, not a weak storehouse", () =>
	{
		const { world, hq, base } = seat({ "phase": 2, "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		storehouseCard(world, hq);
		world.templates["structures/athen/civil_centre"] = structureTemplate("structures/athen/civil_centre", {
			"classes": ["Structure", "CivCentre"], "territories": ["own", "neutral"]
		});
		bookBuilder(world, hq, ["structures/{civ}/civil_centre", "structures/{civ}/storehouse"]);
		base.gatherers.stone = { "nextCheck": 0, "used": 30, "lost": 40 };
		resourceMap(world, "stone")[territoryCellAt([150, 150])] = 20;
		hq.canExpand = true;

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.dropsites.plans.length, 0, "the weak patch is not worth a storehouse here");
		assert.equal(world.ai.queues.civilCentre.plans.length, 1, "the new ground is asked for instead");
	});

	it("a poor patch the town cannot expand on still gets a storehouse, less strictly chosen", () =>
	{
		const { world, hq, base } = seat({ "stock": { "food": 500, "wood": 500, "stone": 500, "metal": 500 } });
		storehouseCard(world, hq);
		base.gatherers.stone = { "nextCheck": 0, "used": 30, "lost": 40 };
		resourceMap(world, "stone")[territoryCellAt([150, 150])] = 20;
		hq.canExpand = false;

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(world.ai.queues.dropsites.plans.length, 1, "the less strict storehouse is planned");
	});
});

/** a worker of ours at a position, on the base's payroll with the given metadata */
function hand(world: HqWorld, base: BaseManager, id: number,
	classes: string[], metadata: Record<string, unknown>, methods: Record<string, unknown> = {},
	position: [number, number] = [60, 60]): ReturnType<typeof makeHqEntity>
{
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position, classes }, {
		"isIdle": () => false,
		"unitAIState": () => "INDIVIDUAL.IDLE",
		"resourceGatherRates": () => ({ "wood.tree": 0.7 }),
		"canGather": () => true,
		"isGatherer": () => true,
		"isBuilder": () => false,
		"stopMoving": () => undefined,
		"canAttackClass": () => false,
		...methods
	}, metadata));
	base.assignEntity(world.gameState, ent);
	return ent;
}

/** a gaia supply of the given "generic.specific" type */
function supply(world: HqWorld, id: number, type: string): void
{
	const [generic, specific] = type.split(".");
	world.addEntity(makeHqEntity({ id, "owner": GAIA, "position": [70, 70], "classes": [] },
		{ "resourceSupplyType": () => ({ generic, specific }) }));
}

/** what a unit gathering from the supply says: its state, its order, its rates */
function gathering(supplyId: number, rates: Record<string, number>): Record<string, unknown>
{
	return {
		"unitAIState": () => "INDIVIDUAL.GATHER.GATHERING",
		"unitAIOrderData": () => orders({ "target": entityId(supplyId) }),
		"resourceGatherRates": () => rates
	};
}

const CIVILIAN = ["Unit", "Support", "Civilian", "Worker"];
const SOLDIER = ["Unit", "Infantry", "CitizenSoldier", "Worker"];

describe("the workers' trade: what they bring in and where they go", () =>
{
	// only the port passes: the original reads the order's target off the
	// order itself, which the engine has wrapped ({type, data}) since its
	// commit 4b516b336e, so every gatherer adds 0 (FINDINGS §18)
	it("a gatherer on the wood adds its rate, discounted for the walk, to the town's wood estimate", () =>
	{
		const { world, base } = seat();
		supply(world, 2891, "wood.tree");
		hand(world, base, 2801, CIVILIAN, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
			gathering(2891, { "wood.tree": 1 }));
		hand(world, base, 2802, CIVILIAN, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
			gathering(2891, { "wood.tree": 3 }));
		hand(world, base, 2803, CIVILIAN, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
			{ ...gathering(2891, { "wood.tree": 9 }), "isIdle": () => true });
		const rates: Record<string, number> = { "food": 0, "wood": 0, "stone": 0, "metal": 0 };

		base.addGatherRates(world.gameState, rates);

		// each working gatherer adds ln(1 + rate) / 1.1; the idle one adds nothing
		assert.ok(Math.abs(rates.wood - (Math.log(2) + Math.log(4)) / 1.1) < 1e-9);
		assert.equal(rates.stone, 0);
	});

	it("hunters and fishers add their rates to the town's food estimate", () =>
	{
		const { world, base } = seat();
		supply(world, 2892, "food.meat");
		supply(world, 2893, "food.fish");
		hand(world, base, 2811, ["Unit", "Cavalry", "FastMoving"],
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_HUNTER }, gathering(2892, { "food.meat": 1 }));
		hand(world, base, 2812, ["Unit", "FishingBoat"],
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER }, gathering(2893, { "food.fish": 2 }));
		const rates: Record<string, number> = { "food": 0, "wood": 0, "stone": 0, "metal": 0 };

		base.addGatherRates(world.gameState, rates);

		assert.ok(Math.abs(rates.food - (Math.log(2) + Math.log(3)) / 1.1) < 1e-9);
		assert.equal(rates.wood, 0);
	});

	it("a worker with no role yet is put to work, and a cavalryman with no role is left out", () =>
	{
		const { world, base } = seat();
		const soldier = hand(world, base, 2821, SOLDIER, {});
		const elephant = hand(world, base, 2822, ["Unit", "Support", "Elephant"], {});
		const cavalry = hand(world, base, 2823, ["Unit", "Cavalry"], {});

		base.assignRolelessUnits(world.gameState);

		assert.equal(soldier.getMetadata(PlayerID, "role"), Worker.ROLE_WORKER);
		assert.equal(elephant.getMetadata(PlayerID, "role"), Worker.ROLE_WORKER, "an elephant hauls like a worker");
		assert.equal(cavalry.getMetadata(PlayerID, "role"), undefined, "a horseman is not put to the fields");
	});

	it("a mercenary, a worker and citizen soldier by its classes, gathers nothing and is no worker", () =>
	{
		// Athens' Cretan archers keep the Worker and CitizenSoldier classes, but
		// mixins/mercenary.xml takes away their ResourceGatherer: as workers they
		// would stand idle for good, never given a resource to gather
		const { world, base } = seat();
		const mercenary = hand(world, base, 2824, ["Unit", "CitizenSoldier", "Worker", "Infantry", "Ranged", "Mercenary"], {},
			{ "isGatherer": () => false, "canGather": () => false });

		base.assignRolelessUnits(world.gameState);

		assert.equal(mercenary.getMetadata(PlayerID, "role"), undefined, "left to the armies");
	});

	it("a gatherer moved from the wood to the food is the civilian first", () =>
	{
		const { world, base } = seat();
		const civilian = hand(world, base, 2831, CIVILIAN,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });
		const soldier = hand(world, base, 2832, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });

		const left = base.switchGatherer(world.gameState, "wood", "food", 1);

		assert.equal(left, 0);
		assert.equal(civilian.getMetadata(PlayerID, "gather-type"), "food");
		assert.equal(soldier.getMetadata(PlayerID, "gather-type"), "wood", "the soldier keeps the wood");
	});

	it("a gatherer moved from the food to the wood is the soldier first, the fields keep their civilians", () =>
	{
		const { world, base } = seat();
		const civilian = hand(world, base, 2841, CIVILIAN,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "food" });
		const soldier = hand(world, base, 2842, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "food" });

		base.switchGatherer(world.gameState, "food", "wood", 1);

		assert.equal(soldier.getMetadata(PlayerID, "gather-type"), "wood");
		assert.equal(civilian.getMetadata(PlayerID, "gather-type"), "food");
	});

	it("a switch asks for as many gatherers as the town has, and reports the rest unfilled", () =>
	{
		const { world, base } = seat();
		for (let i = 0; i < 3; ++i)
			hand(world, base, 2851 + i, CIVILIAN,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });

		const left = base.switchGatherer(world.gameState, "wood", "stone", 5);

		assert.equal(left, 2, "three gatherers switched, two of the five asked for not found");
	});

	it("an idle builder beside a damaged centre goes to repair it", () =>
	{
		const { world, base } = seat();
		const repaired: unknown[] = [];
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		const builder = hand(world, base, 2861, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_IDLE },
			{ "isBuilder": () => true, "isGatherer": () => false, "repair": (target: unknown) => repaired.push(target) });

		base.reassignIdleWorkers(world.gameState);

		assert.deepEqual(repaired, [centre], "the idle builder mends the centre before anything else");
		assert.ok(builder);
	});

	it("an idle gatherer is set to whichever resource the town most needs and can gather", () =>
	{
		const { world, base } = seat();
		const gatherer = hand(world, base, 2871, CIVILIAN,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_IDLE });

		base.reassignIdleWorkers(world.gameState);

		assert.equal(gatherer.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_GATHERER);
		assert.ok(["food", "wood", "stone", "metal"].includes(gatherer.getMetadata(PlayerID, "gather-type") as string));
	});

	it("an idle elephant can only build, so it stays idle", () =>
	{
		const { world, base } = seat();
		const elephant = hand(world, base, 2881, ["Unit", "Support", "Elephant", "Worker"],
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_IDLE });

		base.reassignIdleWorkers(world.gameState);

		assert.equal(elephant.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE);
	});

	it("an idle fast horseman who can hunt the deer becomes a hunter, and an idle fishing boat a fisher", () =>
	{
		const { world, base } = seat();
		// a horseman is a hunter, not a worker; the worker class would send him to gather
		const horseman = hand(world, base, 2891, ["Unit", "Cavalry", "FastMoving"],
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_IDLE },
			{ "canAttackClass": (cls: string) => cls === "Animal" });
		const boat = hand(world, base, 2892, ["Unit", "FishingBoat"],
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_IDLE });

		base.reassignIdleWorkers(world.gameState);

		assert.equal(horseman.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_HUNTER);
		assert.equal(boat.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_FISHER);
	});

	it("a neighbour asking for two builders gets two from a town of five, the town keeping three", () =>
	{
		const { world, base } = seat();
		for (let i = 0; i < 5; ++i)
			hand(world, base, 2901 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true });
		const lent = new EntityCollection(world.gameState.sharedScript) as unknown as
			{ length: number; values(): Iterable<{ getMetadata(p: number, k: string): unknown }> };

		base.pickBuilders(world.gameState, lent as never, 2);

		assert.equal(lent.length, 2);
		for (const ent of lent.values())
			assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE, "a lent hand is idled for the job");
		assert.equal(base.workers.length, 5, "the town's own roll is unchanged; the hands are only set aside");
	});

	// only the port passes: in the original every hand without a plan scores
	// -20, which overrides its idle (-50) and builder (100) scores
	it("a neighbour borrows idle hands first, never a builder", () =>
	{
		const { world, base } = seat();
		const worker = (id: number, metadata: Record<string, unknown>) =>
			hand(world, base, id, SOLDIER, { "role": Worker.ROLE_WORKER, ...metadata }, { "isBuilder": () => true });
		// out of reach: gone inside a building, defending, boarding a ship
		override(worker(2921, { "subrole": Worker.SUBROLE_GATHERER }), { "position": () => undefined });
		worker(2922, { "subrole": Worker.SUBROLE_GATHERER, "plan": -2 });
		worker(2923, { "subrole": Worker.SUBROLE_GATHERER, "transport": 4 });
		// the town's own: a builder, a gatherer, then an idle hand
		worker(2929, { "subrole": Worker.SUBROLE_BUILDER });
		worker(2924, { "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });
		worker(2925, { "subrole": Worker.SUBROLE_IDLE });
		// hands kept for an attack plan: a builder, a gatherer, an idle one
		worker(2926, { "subrole": Worker.SUBROLE_BUILDER, "plan": 5 });
		worker(2927, { "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood", "plan": 5 });
		worker(2928, { "subrole": Worker.SUBROLE_IDLE, "plan": 5 });
		const lent = new EntityCollection(world.gameState.sharedScript);

		base.pickBuilders(world.gameState, lent, 2);

		// six available hands, three stay: two lent, the two idle ones
		assert.deepEqual([...lent.values()].map((e) => e.id()).sort(), [2925, 2928]);
	});

	it("a town of three builders lends none", () =>
	{
		const { world, base } = seat();
		for (let i = 0; i < 3; ++i)
			hand(world, base, 2911 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true });
		const lent = new EntityCollection(world.gameState.sharedScript);

		base.pickBuilders(world.gameState, lent, 2);

		assert.equal(lent.length, 0, "the last three hands stay at home");
	});
});

/** the town's stock, large enough that builders are not held back for want of it */
const RICH = { "food": 2000, "wood": 2000, "stone": 2000, "metal": 2000 };

/** a building raised on the town's ground, still a foundation until its progress completes */
function foundation(world: HqWorld, base: { assignEntity(gs: unknown, ent: unknown): void }, id: number,
	position: [number, number], classes: string[], metadata: Record<string, unknown> = {},
	methods: Record<string, unknown> = {}): ReturnType<typeof makeHqEntity>
{
	const ent = world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position, "classes": ["Structure", ...classes],
		"templateName": `structures/athen/${classes[0].toLowerCase()}`
	}, { "foundationProgress": () => 0.4, "buildTime": () => 50, ...methods }, metadata));
	base.assignEntity(world.gameState, ent);
	return ent;
}

/** the builders of ours who have been given a target, by that target's id */
function builders(world: HqWorld, targetId: number): number
{
	return world.gameState.getOwnEntitiesByMetadata("target-foundation", targetId).length;
}

describe("the builders: who raises and mends the town's ground", () =>
{
	it("a house raised on the ground gets its three builders, and the rest of the hands keep working", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 6; ++i)
			hand(world, base, 3001 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [60 + i, 60]);
		foundation(world, base, 3010, [70, 60], ["House"]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3010), 3, "a house takes three builders");
	});

	it("a centre being raised takes the builders, and no house beside it gets any", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);
		for (let i = 0; i < 6; ++i)
			hand(world, base, 3021 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [60 + i, 60]);
		foundation(world, base, 3030, [70, 60], ["House"]);
		foundation(world, base, 3031, [100, 100], ["CivCentre"], { "baseAnchor": true });

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3030), 0, "the house waits while the new centre goes up");
		assert.ok(builders(world, 3031) > 0, "the new centre takes the hands");
	});

	it("a centre damaged and not under attack is mended by its nearest hands, five at most", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 8; ++i)
			hand(world, base, 3041 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [20 + i, 20]);
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		centre.healthLevel = () => 0.9;

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 1000), 5);
	});

	it("a centre under thirty per cent of its health draws seven hands", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 10; ++i)
			hand(world, base, 3051 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [20 + i, 20]);
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		centre.healthLevel = () => 0.2;

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 1000), 7, "a centre near falling draws the most hands");
	});

	it("a town short of stock lends fewer hands to its foundations", () =>
	{
		const { world, base } = seat({ "stock": { "food": 100, "wood": 100, "stone": 100, "metal": 100 } });
		for (let i = 0; i < 10; ++i)
			hand(world, base, 3061 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [60 + i, 60]);
		foundation(world, base, 3080, [70, 60], ["House"]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3080), 2, "with little stock, a fifth of the hands build at once");
	});

	it("a centre left to decay is not mended", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 6; ++i)
			hand(world, base, 3081 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [20 + i, 20]);
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		centre.decaying = () => true;

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 1000), 0);
	});

	it("with the hold on repairs, only the centre is mended and the barracks is left damaged", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 6; ++i)
			hand(world, base, 3091 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [20 + i, 20]);
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		centre.healthLevel = () => 0.9;
		const barracks = foundation(world, base, 3100, [40, 40], ["Barracks"], {}, {
			"foundationProgress": () => undefined, "needsRepair": () => true, "healthLevel": () => 0.9
		});
		void barracks;

		base.assignToFoundations(world.gameState, true);

		assert.equal(builders(world, 3100), 0, "the barracks waits for the hold to lift");
		assert.equal(builders(world, 1000), 5, "the centre is mended regardless");
	});
});

describe("the builders: crews by kind of building, and what holds them back", () =>
{
	/** a woodcutter of ours at a position */
	function woodcutter(world: HqWorld, base: BaseManager, id: number, position: [number, number], metadata: Record<string, unknown> = {},
		classes = SOLDIER): ReturnType<typeof makeHqEntity>
	{
		return hand(world, base, id, classes,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood", ...metadata },
			{ "isBuilder": () => true }, position);
	}

	it("a fortress or a phase-up building takes seven, a barracks four, a wood storehouse three, a smithy two", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		for (let i = 0; i < 30; ++i)
			woodcutter(world, base, 3601 + i, [60 + i, 60]);
		foundation(world, base, 3650, [80, 80], ["Fortress"]);
		foundation(world, base, 3651, [90, 80], ["Temple"], { "phaseUp": true });
		foundation(world, base, 3652, [100, 80], ["Barracks"]);
		foundation(world, base, 3653, [110, 80], ["Storehouse", "DropsiteWood"]);
		foundation(world, base, 3654, [120, 80], ["Blacksmith"]);

		base.assignToFoundations(world.gameState);

		assert.deepEqual([3650, 3651, 3652, 3653, 3654].map((id) => builders(world, id)), [7, 7, 4, 3, 2]);
	});

	it("short of a resource, a town lends a fifth of its hands, never fewer than two; a house needed for room takes two more", () =>
	{
		for (const [population, expected] of [[5, 2], [18, 3]])
		{
			const { world, base } = seat({ "stock": { ...RICH, "food": 100 }, population, "populationLimit": 20, "populationMax": 300 });
			for (let i = 0; i < 5; ++i)
				woodcutter(world, base, 3661 + i, [60 + i, 60]);
			foundation(world, base, 3670, [70, 60], ["House"]);

			base.assignToFoundations(world.gameState);

			assert.equal(builders(world, 3670), expected, `population ${population}`);
		}
	});

	it("with only 500 wood in stock, half the hands at most: a fortress gets five of ten", () =>
	{
		const { world, base } = seat({ "stock": { ...RICH, "wood": 500 } });
		for (let i = 0; i < 10; ++i)
			woodcutter(world, base, 3681 + i, [60 + i, 60]);
		foundation(world, base, 3695, [70, 60], ["Fortress"]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3695), 5);
	});

	it("a foundation beside an invading army waits, unless it is a wall", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		hq.defenseManager.armies = [fake<DefenseArmy>({ "foePosition": worldPos(75, 60) })];
		for (let i = 0; i < 6; ++i)
			woodcutter(world, base, 3701 + i, [60 + i, 60]);
		foundation(world, base, 3710, [70, 60], ["House"]);
		foundation(world, base, 3711, [72, 64], ["Wall"]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3710), 0);
		assert.equal(builders(world, 3711), 2);
	});

	it("a house foundation on ground we no longer hold is left unfinished", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		for (let i = 0; i < 6; ++i)
			woodcutter(world, base, 3721 + i, [60 + i, 60]);
		foundation(world, base, 3730, [100, 100], ["House"], {}, { "buildTerritories": () => ["own"] });
		world.map.setTerritoryOwner(12, 12, 0);
		void hq;

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3730), 0);
	});

	it("the nearest hands build, a farmer counting three times as far, an elephant less the longer the work", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		woodcutter(world, base, 3741, [80, 70], { "gather-type": "food" });		// 10 away, a farmer
		woodcutter(world, base, 3742, [80, 75]);									// 15 away
		woodcutter(world, base, 3743, [80, 76]);									// 16 away
		woodcutter(world, base, 3744, [80, 72], {}, ["Unit", "Support", "Elephant", "Worker"]);	// 12 away
		foundation(world, base, 3750, [80, 60], ["Blacksmith"]);

		base.assignToFoundations(world.gameState);

		const crew = [3741, 3742, 3743, 3744].filter((id) =>
			world.ents.get(id)!.getMetadata(PlayerID, "target-foundation") === 3750);
		assert.deepEqual(crew, [3742, 3744]);
	});

	it("a damaged fortress takes three menders; a damaged barracks by an invading army waits", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		for (let i = 0; i < 8; ++i)
			woodcutter(world, base, 3761 + i, [60 + i, 60]);
		const damaged = (id: number, position: [number, number], classes: string[]) =>
		{
			const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position, "classes": ["Structure", ...classes] },
				{ "needsRepair": () => true, "healthLevel": () => 0.8 }));
			base.assignEntity(world.gameState, ent);
		};
		damaged(3770, [80, 60], ["Fortress"]);
		damaged(3771, [200, 200], ["Barracks"]);
		hq.defenseManager.armies = [fake<DefenseArmy>({ "foePosition": worldPos(205, 200) })];

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3770), 3);
		assert.equal(builders(world, 3771), 0);
	});

	it("menders already at work are enough; hands defending, boarding or inside a building are not called", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		const centre = world.ents.get(1000)!;
		centre.needsRepair = () => true;
		centre.healthLevel = () => 0.9;
		// four hands out of reach, and one already mending the barracks
		woodcutter(world, base, 3781, [20, 20], { "plan": -2 });
		woodcutter(world, base, 3782, [20, 21], { "transport": 3 });
		override(woodcutter(world, base, 3783, [20, 22]), { "position": () => undefined });
		woodcutter(world, base, 3784, [21, 20], { "plan": -3 });
		woodcutter(world, base, 3785, [60, 60]);
		woodcutter(world, base, 3786, [61, 60], { "subrole": Worker.SUBROLE_BUILDER });
		const barracks = world.addEntity(makeHqEntity({ "id": 3790, "owner": PLAYER, "position": [62, 60],
			"classes": ["Structure", "Barracks"] }, { "needsRepair": () => true, "healthLevel": () => 0.8 }));
		base.assignEntity(world.gameState, barracks);
		world.ents.get(3786)!.setMetadata(PlayerID, "target-foundation", entityId(3790));

		base.assignToFoundations(world.gameState);

		// the barracks keeps its one mender; the centre gets the one free hand
		assert.equal(builders(world, 3790), 1);
		assert.equal(builders(world, 1000), 1);
		assert.equal(world.ents.get(3785)!.getMetadata(PlayerID, "target-foundation"), 1000);
	});
});

describe("a ground that changes hands: the centre's ring and the anchorless docks", () =>
{
	it("a new centre planted inside an enemy's ring is abandoned", () =>
	{
		const { world, hq, base } = seat({
			"territoryOwner": (ix: number, iy: number) => ix <= 2 && iy <= 2 ? ENEMY : PLAYER
		});
		hq.updateTerritories(world.gameState);
		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);
		world.addEntity(makeHqEntity({
			"id": 3201, "owner": ENEMY, "position": [20, 20],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		let destroyed = false;
		override(world.ents.get(1000)!, { "destroy": () => { destroyed = true; } });

		base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(destroyed, true, "a centre raised under the rival's walls cannot be held");
	});

	it("a new centre on ground no rival holds is kept", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);
		let destroyed = false;
		override(world.ents.get(1000)!, { "destroy": () => { destroyed = true; } });

		base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(destroyed, false);
	});

	it("a dock on another landmass founds a base for that landmass, and claims the dock", () =>
	{
		const { world, hq } = seat({
			"landPassMap": (px: number) => px >= 80 ? 3 : 2
		}, { "landRegions": { 2: true, 3: true } });
		hq.updateTerritories(world.gameState);
		world.accessAt.set("200,100", 3);
		const dock = world.addEntity(makeHqEntity({
			"id": 3211, "owner": PLAYER, "position": [200, 100],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, { "resourceDropsiteTypes": () => ["food"] }));

		const island = hq.basesManager.createBase(world.gameState, dock, BaseManager.STATE_ANCHORLESS);

		assert.equal(island.accessIndex, 3, "the new base answers to the island's landmass");
		assert.equal(dock.getMetadata(PLAYER, "base"), island.ID, "the dock belongs to the island's base");
	});

	it("the town's own bases answer the update, and a town still standing is not reported lost", () =>
	{
		const { world, base } = seat({ "stock": RICH });

		const active = base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(active, true);
	});

	it("a centre's cadence counters are read and written through the town's base", () =>
	{
		const { base } = seat();

		base.AddTCGatherer(entityId(2801));
		assert.equal(base.GetTCGatherer(entityId(2801)), 1);
		base.RemoveTCGatherer(entityId(2801));
		assert.equal(base.GetTCGatherer(entityId(2801)), 0);
	});
});

describe("the dropsites and gatherers, read turn by turn", () =>
{
	it("a storehouse rising counts as a dropsite, so a new one is not placed beside it", () =>
	{
		const { world, hq, base } = seat();
		storehouseCard(world, hq);
		woodCluster(world, [150, 150]);
		// the storehouse is still a foundation: the office must already see it
		world.addEntity(makeHqEntity({
			"id": 3301, "owner": PLAYER, "position": [150, 150],
			"classes": ["Structure", "Storehouse"], "templateName": "foundation|structures/athen/storehouse"
		}, {
			"foundationProgress": () => 0.3,
			"resourceDropsiteTypes": () => undefined,
			"isResourceDropsite": () => false
		}));

		const best = base.findBestDropsiteLocation(world.gameState, "wood", templateName("structures/athen/storehouse"));

		const dx = best.pos[0] - 150, dz = best.pos[1] - 150;
		assert.ok(dx * dx + dz * dz >= 3600, "the foundation's spot is not doubled");
	});

	it("the gatherers at work and those walking home empty are counted each turn", () =>
	{
		const { world, base } = seat();
		const working = { "unitAIState": () => "INDIVIDUAL.GATHER.GATHERING" };
		for (let i = 0; i < 3; ++i)
			hand(world, base, 3311 + i, CIVILIAN,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "stone" }, working);
		hand(world, base, 3314, CIVILIAN,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "stone" },
			{ "unitAIState": () => "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING" });

		base.checkResourceLevels(world.gameState, world.ai.queues);

		assert.equal(base.gatherers.stone.used, 3);
		assert.equal(base.gatherers.stone.lost, 1);
	});

	it("a supply booked twice by the same dropsite is booked once", () =>
	{
		const { world, base } = seat();
		const dropsite = storehouse(world, 3321, [40, 40]);
		world.addEntity(makeGaiaSupply({ "id": 3322, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"] }));
		base.assignResourceToDropsite(world.gameState, dropsite, false);

		base.assignResourceToDropsite(world.gameState, dropsite, false);

		assert.deepEqual(booked(base, "wood", "nearby"), [3322]);
	});

	it("a wood with no trees left in reach sends its gatherers to another resource", () =>
	{
		const { world, base } = seat();
		for (let i = 0; i < 3; ++i)
			hand(world, base, 3331 + i, CIVILIAN,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });

		base.setWorkersIdleByPriority(world.gameState);

		const moved = [3331, 3332, 3333].filter((id) =>
			world.ents.get(id)?.getMetadata(PLAYER, "gather-type") !== "wood");
		assert.ok(moved.length >= 1, "at least one axe-man is moved off the exhausted wood");
	});
});

describe("the builders on the foundations, in the cases not yet read", () =>
{
	it("a builder on another foundation is called to the new centre when the ground is constructing", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		base.reset(world.gameState, BaseManager.STATE_UNCONSTRUCTED);
		foundation(world, base, 3341, [70, 60], ["House"]);
		const newCentre = foundation(world, base, 3342, [100, 100], ["CivCentre"], { "baseAnchor": true });
		const builder = hand(world, base, 3343, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 3341 },
			{ "isBuilder": () => true }, [72, 60]);

		base.assignToFoundations(world.gameState);

		assert.equal(builder.getMetadata(PLAYER, "target-foundation"), newCentre.id(),
			"the hands leave the house for the centre the ground is waiting on");
	});

	it("a town with no finished centre puts all its hands to raising that centre", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		const centre = world.ents.get(1000)!;
		centre.foundationProgress = () => 0.5;
		centre.buildTime = () => 150;
		hq.basesManager.resetBaseCache();
		for (let i = 0; i < 6; ++i)
			hand(world, base, 3351 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [20 + i, 20]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 1000), 6, "the first centre is raised by every hand the town has");
	});

	it("idle builders beside a foundation are sent to it before the rest", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		foundation(world, base, 3361, [70, 60], ["House"]);
		for (let i = 0; i < 2; ++i)
			hand(world, base, 3362 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER },
				{ "isBuilder": () => true, "isIdle": () => true }, [72, 60]);
		for (let i = 0; i < 4; ++i)
			hand(world, base, 3371 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [60 + i, 60]);

		base.assignToFoundations(world.gameState);

		assert.equal(world.ents.get(3362)?.getMetadata(PLAYER, "target-foundation"), 3361, "the idle one nearest the house goes first");
		assert.equal(world.ents.get(3363)?.getMetadata(PLAYER, "target-foundation"), 3361);
		assert.equal(builders(world, 3361), 3, "and the house still takes three in all");
	});

	it("a damaged barracks has an idle builder beside it sent to mend it", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		foundation(world, base, 3381, [40, 40], ["Barracks"], {}, {
			"foundationProgress": () => undefined, "needsRepair": () => true, "healthLevel": () => 0.9
		});
		hand(world, base, 3382, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER },
			{ "isBuilder": () => true, "isIdle": () => true }, [42, 40]);

		base.assignToFoundations(world.gameState);

		assert.equal(builders(world, 3381), 1, "one idle builder mends a damaged barracks");
	});

	it("a town of two builders borrows a builder from the ground with no town", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		foundation(world, base, 3391, [70, 60], ["House"]);
		for (let i = 0; i < 2; ++i)
			hand(world, base, 3392 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [60 + i, 60]);
		const baseless = hq.basesManager.baselessBase();
		for (let i = 0; i < 4; ++i)
			hand(world, baseless, 3401 + i, SOLDIER,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
				{ "isBuilder": () => true }, [80 + i, 80]);

		base.assignToFoundations(world.gameState);

		const lent = [3401, 3402, 3403, 3404].filter((id) => world.ents.get(id)?.getMetadata(PLAYER, "base") === base.ID);
		assert.equal(lent.length, 1, "one hand from the ground with no town joins the house");
	});
});

describe("the turn of a town: workers out of a base, and a town whose centre fell", () =>
{
	it("a worker with no town of its own is handed to the town it stands nearest", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		const baseless = hq.basesManager.baselessBase();
		const stray = hand(world, baseless, 3501, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" },
			{}, [60, 60]);

		baseless
			.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(stray.getMetadata(PLAYER, "base"), base.ID, "the stray joins the town nearest it");
	});

	it("a town whose centre falls keeps working the storehouse still standing, and reports itself active", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		const dropsite = storehouse(world, 3511, [40, 40]);
		base.assignEntity(world.gameState, dropsite);
		hand(world, base, 3512, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" }, {}, [44, 40]);
		// the centre is destroyed: it leaves the world, and the base loses its anchor
		world.removeEntity(1000);
		base.anchorLost(world.gameState);
		assert.equal(hq.numActiveBases(), 0);

		const active = base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(active, true, "the storehouse and its workers still keep the ground");
	});

	it("a town whose centre falls and nothing else stands is no longer an active base", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		world.removeEntity(1000);
		base.anchorLost(world.gameState);

		const active = base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(active, false, "a town with nothing left on the ground does not work it");
	});

	it("a town whose centre falls is absorbed by a second centre on the same land: its storehouse and people join it", () =>
	{
		const { world, hq, base } = seat({ "stock": RICH });
		const dropsite = storehouse(world, 3521, [40, 40]);
		base.assignEntity(world.gameState, dropsite);
		const worker = hand(world, base, 3522, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" }, {}, [44, 40]);
		const second = world.addEntity(makeHqEntity({
			"id": 3523, "owner": PLAYER, "position": [250, 250],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));
		const heir = hq.basesManager.createBase(world.gameState, second, BaseManager.STATE_WITH_ANCHOR);
		world.removeEntity(1000);
		base.anchorLost(world.gameState);

		const active = base.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(active, false, "the old town hands its ground over");
		assert.equal(dropsite.getMetadata(PLAYER, "base"), heir.ID, "the storehouse answers to the new centre");
		assert.equal(worker.getMetadata(PLAYER, "base"), heir.ID, "and so do the workers");
	});
});

describe("the rest of the turn: idle hands already spoken for, docks with no town, and the baseless pool", () =>
{
	it("an idle builder across the town from a foundation is not sent to it", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		foundation(world, base, 3651, [70, 60], ["House"]);
		hand(world, base, 3652, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER },
			{ "isBuilder": () => true, "isIdle": () => true }, [300, 300]);

		base.assignToFoundations(world.gameState);

		assert.equal(world.ents.get(3652)?.getMetadata(PLAYER, "target-foundation"), undefined,
			"an idle builder more than two hundred units away stays where it stands");
	});

	it("an idle builder already on a foundation keeps its job", () =>
	{
		const { world, base } = seat({ "stock": RICH });
		foundation(world, base, 3601, [70, 60], ["House"]);
		hand(world, base, 3602, SOLDIER,
			{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 3999 },
			{ "isBuilder": () => true, "isIdle": () => true }, [72, 60]);

		base.assignToFoundations(world.gameState);

		assert.equal(world.ents.get(3602)?.getMetadata(PLAYER, "target-foundation"), 3999,
			"a builder with a job is not pulled to another one");
	});

	// only the port passes: the dock lands in the baseless pool's units with no town
	// on its landmass, and the reference's units loop dereferences the missing best
	// base (getBestBase returns nothing) and throws; the port skips it and notes the dock
	it("a dock built outside any town is left out of the towns, and the office is told", () =>
	{
		// the dock stands on an island with no town of ours: no base shares its landmass
		const { world, hq } = seat({ "stock": RICH, "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("250,250", 3);
		const dock = world.addEntity(makeHqEntity({
			"id": 3611, "owner": PLAYER, "position": [250, 250],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, { "resourceDropsiteTypes": () => ["food"] }));
		const baseless = hq.basesManager.baselessBase();
		baseless.assignEntity(world.gameState, dock);
		resetRecorder();

		baseless
			.update(world.gameState, world.ai.queues, emptyEvents());

		assert.ok(logs.some((line: string) => line.includes("dock in 'noBase' baseManager")),
			"the dock is noted as sitting outside every town");
	});

	it("with no finished centre anywhere, the baseless pool sorts its idle hands into roles and waits", () =>
	{
		const { world, hq } = seat({ "stock": RICH });
		override(world.ents.get(1000)!, { "foundationProgress": () => 0.5 });
		hq.basesManager.resetBaseCache();
		const baseless = hq.basesManager.baselessBase();
		const recruit = hand(world, baseless, 3621, SOLDIER, {});

		const active = baseless
			.update(world.gameState, world.ai.queues, emptyEvents());

		assert.equal(active, false, "the pool is not an active town");
		assert.equal(recruit.getMetadata(PLAYER, "role"), Worker.ROLE_WORKER, "the recruit is put to work");
	});

	it("a wood the queues most want, with no trees left in reach, sends its gatherers to the next need", () =>
	{
		const { world, hq, base } = seat();
		for (let i = 0; i < 3; ++i)
			hand(world, base, 3631 + i, CIVILIAN,
				{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood" });
		// the office's turn cache holds what the queues ask of each resource this turn
		hq.turnCache.wantedRates =
			{ "food": 0.5, "wood": 3, "stone": 0, "metal": 0 };

		base.setWorkersIdleByPriority(world.gameState);

		const moved = [3631, 3632, 3633].filter((id) =>
			world.ents.get(id)?.getMetadata(PLAYER, "gather-type") !== "wood");
		assert.ok(moved.length >= 1, "the exhausted wood gives up at least one gatherer");
	});
});
