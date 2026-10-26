/**
 * Bases manager: the handful of towns a city grows around its centres and
 * docks. The suites seat a real Headquarters on the small engine-truthful
 * board (see tests/harness/hqWorld.ts) and drive its towns through the turns
 * of an actual campaign: grounds founded and lost, foundations raised, units
 * captured from the enemy, workers trained and sent where the town needs
 * them most.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyEvents, entityMetadata, eventsWith } from "./harness/fakes.ts";
import {
	bookCentreSupplies, doorManagers, ENEMY, type HqSeatOptions, type HqWorld, type HqWorldOptions,
	makeGaiaSupply, makeHQConfig, makeHqEntity, makeHqWorld, PLAYER, seatHQ, structureTemplate,
	territoryCellAt
} from "./harness/hqWorld.ts";

import { entityId } from "../adapter/brands.ts";
import { BaseManager } from "../decision/baseManager.ts";
import { BasesManager } from "../decision/basesManager.ts";
import type { Headquarters } from "../decision/headquarters.ts";
import { Worker } from "../execution/worker.ts";

// the player id the common-api reads metadata under
const PlayerID = PLAYER;
/** a seat of the office on the standard board, with its towns' manager */
function seat(worldOptions: Partial<HqWorldOptions> = {}, seatOptions: Partial<HqSeatOptions> = {})
{
	const world = makeHqWorld(worldOptions);
	const hq = seatHQ(world, { stubs: doorManagers, ...seatOptions });
	// the game books the towns' ground before any plan is made (gameAnalysis)
	hq.updateTerritories(world.gameState);
	return {
		world, hq,
		bs: hq.basesManager,
		base: hq.baseManagers()[0]
	};
}

/** a worker of ours, on a base's payroll with the given metadata */
function hand(world: HqWorld, host: BaseManager, id: number, metadata: Record<string, unknown>,
	methods: Record<string, unknown> = {}, position: [number, number] = [60, 60])
{
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position,
		"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"] }, {
		"isIdle": () => false,
		"unitAIState": () => "INDIVIDUAL.IDLE",
		"currentGatherRate": () => 0,
		"canGather": () => true,
		"isGatherer": () => true,
		"isBuilder": () => true,
		"stopMoving": () => undefined,
		"canAttackClass": () => false,
		...methods
	}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood", ...metadata }));
	host.assignEntity(world.gameState, ent);
	return ent;
}

/** a second town of ours on the board, as a colony or a captured centre raises */
function secondTown(world: HqWorld, hq: Headquarters, id: number, position: [number, number]): BaseManager
{
	const cc = world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position,
		"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
	}));
	const town = hq.basesManager.createBase(world.gameState, cc, BaseManager.STATE_WITH_ANCHOR);
	// the office rescans the ground every turn (headquarters.checkEvents)
	hq.updateTerritories(world.gameState);
	return town;
}

/** a storehouse of ours, dropping wood (and food, when asked) */
function storehouse(world: HqWorld, id: number, position: [number, number], types: string[] = ["wood"])
{
	return world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position,
		"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
	}, {
		"resourceDropsiteTypes": () => types,
		"isResourceDropsite": (resource?: string) => !resource || types.includes(resource)
	}));
}

/** a foundation the town carries at the given place, with plan-style metadata */
function foundation(world: HqWorld, base: BaseManager | undefined, id: number, position: [number, number],
	classes: string[], metadata: Record<string, unknown> = {})
{
	const ent = world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position,
		"classes": ["Structure", ...classes],
		"templateName": "foundation|structures/athen/" + classes[0].toLowerCase()
	}, { "foundationProgress": () => 0.4, "buildTime": () => 50 }, metadata));
	if (base)
		base.assignEntity(world.gameState, ent);
	return ent;
}

/** a raw supply with the engine's template leaves the gatherer search reads */
function rawSupply(world: HqWorld, id: number, position: [number, number],
	generic: string, specific: string)
{
	return world.addEntity(makeGaiaSupply({ id, position, generic, specific }, {
		// the engine template carries ResourceSupply/Type ("wood.tree" …),
		// which the gatherer search matches against the worker's rates
		"get": (path: string) => path === "ResourceSupply/Type" ? generic + "." + specific : undefined,
		"resourceSupplyNumGatherers": () => 0,
		// a fruit bush's template ceiling, as ResourceSupply/MaxGatherers reads
		"maxGatherers": () => 8
	}));
}

/** swaps the office's answer to a new ground for a recorder; the real one is
 * verified in the headquarters' own campaign */
function watchHandleNewBase(hq: Headquarters): number[]
{
	const calls: number[] = [];
	hq.handleNewBase = () =>
	{
		calls.push(1);
	};
	return calls;
}

describe("a city's grounds: what the board starts with and how grounds are reused", () =>
{
	it("a town under construction is a founding ground, both fresh and read from a save", () =>
	{
		const { world, hq } = seat();
		// a mid-game save read back: one centre standing, one still rising
		foundation(world, undefined, 4002, [250, 250], ["CivCentre"]);
		const fresh = new BasesManager(hq.Config);
		fresh.init(world.gameState, true);

		assert.equal(fresh.baseManagers.length, 2, "the board has two grounds");
		assert.equal(fresh.baseManagers[0]?.anchor?.id(), 1000, "the standing centre anchors the first");
		assert.equal(fresh.baseManagers[1]?.anchor?.id(), 4002, "the rising centre anchors the founding ground");
		assert.equal(fresh.baseManagers[1]?.constructing, true, "the founding ground is under construction");
	});

	it("a save read with a storehouse standing rebuilds the town's ground map over it", () =>
	{
		const { world, base, bs } = seat();
		const store = storehouse(world, 4781, [40, 40]);
		base.assignEntity(world.gameState, store);

		bs.postinit(world.gameState);

		assert.ok(bs.getBaseByID(base.ID), "the town still reads from the reloaded ground map");
	});

	it("a second dock on an island joins the island's ground instead of founding a new one", () =>
	{
		const { world, hq, base } = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("200,100", 3);
		world.accessAt.set("220,110", 3);
		// the engine reads a foundation's built form through its name; the dock knows itself
		world.templates["structures/athen/dock"] = structureTemplate("structures/athen/dock",
			{ "classes": ["Structure", "Dock"], "dropsiteTypes": ["food"] });
		const island = hq.basesManager.createBase(world.gameState,
			foundation(world, undefined, 4011, [200, 100], ["Dock"], { "resourceDropsiteTypes": () => ["food"] }),
			BaseManager.STATE_ANCHORLESS);
		const count = hq.baseManagers().length;

		const second = foundation(world, undefined, 4012, [220, 110], ["Dock"]);
		const reused = hq.basesManager.createBase(world.gameState, second, BaseManager.STATE_ANCHORLESS);

		assert.equal(reused, island, "the island's ground is reused for the second dock");
		assert.equal(hq.baseManagers().length, count, "no founding run for the second dock");
		assert.equal(second.getMetadata(PLAYER, "base"), island.ID, "the new dock answers to the island");
		assert.equal(island.accessIndex, 3, "the island ground answers to the island's landmass");
		void base;
	});
});

describe("a building lost: the turn of the destruction events", () =>
{
	it("a storehouse lost to a raid leaves its books and its place, and spares the town's people", () =>
	{
		const { world, base, bs } = seat();
		const store = storehouse(world, 4201, [40, 40]);
		base.assignEntity(world.gameState, store);
		world.addEntity(makeGaiaSupply({
			"id": 4202, "position": [60, 40], "generic": "wood", "specific": "tree", "classes": ["Forest"]
		}));
		base.assignResourceToDropsite(world.gameState, store, false);

		bs.checkEvents(world.gameState, eventsWith({
			"Destroy": [{ "entity": entityId(4201), "metadata": { [PlayerID]: entityMetadata({ "base": base.ID }) } }]
		}));

		assert.equal(base.dropsites[4201], undefined, "the storehouse is off the town's list");
	});

	it("a centre lost to a sally removes the ground's anchor and the ground stops asking for a garrison", () =>
	{
		const { world, base, bs, hq } = seat();
		assert.equal(hq.numActiveBases(), 1);

		bs.checkEvents(world.gameState, eventsWith({
			"Destroy": [{
				"entity": entityId(1000),
				"metadata": { [PlayerID]: entityMetadata({ "base": base.ID, "baseAnchor": true }) }
			}]
		}));

		assert.equal(base.anchor, undefined);
		assert.equal(hq.numActiveBases(), 0, "the town is no longer an active ground");
	});

	// only the port passes: the original calls newbase.reset(type) for the
	// (gameState, state) signature, so a reused ground gets no state: it is
	// never founding, and never asks for defenders
	it("a town that lost its centre guards a centre it captures, and founds one it rebuilds", () =>
	{
		const { world, hq, base, bs } = seat({}, { "config": makeHQConfig({ "difficulty": 5 }) });
		bs.checkEvents(world.gameState, eventsWith({
			"Destroy": [{ "entity": entityId(1000), "metadata": { [PlayerID]: entityMetadata({ "base": base.ID, "baseAnchor": true }) } }]
		}));
		const captured = world.addEntity(makeHqEntity({
			"id": 4300, "owner": PLAYER, "position": [70, 70],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));

		const reused = bs.createBase(world.gameState, captured, BaseManager.STATE_CAPTURED);
		assert.equal(reused, base, "the town's ground takes the captured centre");
		assert.equal(reused.neededDefenders, 7, "very hard guards a captured centre with 3 + 2 × 2 defenders");
		assert.equal(reused.constructing, false);

		bs.checkEvents(world.gameState, eventsWith({
			"Destroy": [{ "entity": entityId(4300), "metadata": { [PlayerID]: entityMetadata({ "base": base.ID, "baseAnchor": true }) } }]
		}));
		const rebuilt = foundation(world, undefined, 4301, [70, 70], ["CivCentre"]);
		assert.equal(bs.createBase(world.gameState, rebuilt, BaseManager.STATE_UNCONSTRUCTED), base);
		assert.equal(base.constructing, true, "the ground founds its new centre, calling builders to it");
		assert.equal(base.neededDefenders, 0, "a foundation asks for no defenders");
		void hq;
	});

	it("a foundation raised and felled in the same turn costs the towns nothing", () =>
	{
		const { world, bs } = seat();
		const count = bs.baseManagers.length;

		bs.checkEvents(world.gameState, eventsWith({
			"Destroy": [{
				"entity": entityId(4002), "metadata": { [PlayerID]: entityMetadata({ "base": -1 }) }, "SuccessfulFoundation": false
			}]
		}));

		assert.equal(bs.baseManagers.length, count, "no ground is affected");
	});
});

describe("a unit promoted, a centre renamed: the turn of the renames", () =>
{
	it("a promoted gatherer forgets its old trade and is put to work again", () =>
	{
		const { world, base, bs } = seat();
		const veteran = hand(world, base, 4301,
			{ "supply": 400 },
			{ "isGatherer": () => false });
		// the game hands the promoted form a fresh id with the same plan metadata
		const promoted = world.addEntity(makeHqEntity({
			"id": 4302, "owner": PLAYER, "position": [62, 60],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.IDLE",
			"canGather": () => true,
			"isGatherer": () => false,
			"isBuilder": () => true,
			"canAttackClass": () => false
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood", "base": base.ID }));
		void veteran;

		bs.checkEvents(world.gameState, eventsWith({
			"EntityRenamed": [{ "entity": entityId(4301), "newentity": entityId(4302) }]
		}));

		assert.equal(promoted.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_IDLE, "the veteran re-enters as idle");
		assert.ok(!promoted.getMetadata(PLAYER, "gather-type"), "the old trade is forgotten");
	});

	it("a centre's name change keeps its ground keyed to the renamed centre", () =>
	{
		const { world, base, bs } = seat();
		world.addEntity(makeHqEntity({
			"id": 4311, "owner": PLAYER, "position": [10, 10],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "base": base.ID }));
		const before = base.anchorId;

		bs.checkEvents(world.gameState, eventsWith({
			"EntityRenamed": [{ "entity": entityId(1000), "newentity": entityId(4311) }]
		}));

		assert.equal(base.anchorId, 4311, "the ground follows the renamed centre, not " + before);
		assert.equal(base.anchor?.id(), 4311);
	});
});

describe("a foundation raised: the turn of the Create events", () =>
{
	it("a colony's centre foundation founds a ground and calls ten hands from the towns to it", () =>
	{
		const { world, hq, base, bs } = seat();
		const colony = secondTown(world, hq, 4401, [240, 240]);
		// the handing town keeps three hands home, so thirteen are needed for ten
		for (let i = 0; i < 13; ++i)
			hand(world, base, 4410 + i, {}, {}, [20 + i, 20]);
		// the plans of a new civil centre carry base -1, as the office's plans do
		const rising = foundation(world, undefined, 4403, [250, 250], ["CivCentre"], { "base": -1 });

		bs.checkEvents(world.gameState, eventsWith({
			"Create": [{ "entity": entityId(4403) }]
		}));

		// a colony under construction: its rising centre is already its anchor
		const newBase = bs.baseManagers.filter((b) => b.constructing)[0];
		assert.ok(newBase, "the colony's ground is born");
		assert.equal(bs.baseManagers.length, 3, "the two standing towns keep theirs");
		assert.equal(rising.getMetadata(PLAYER, "base"), newBase.ID,
			"the foundation is keyed to the founding ground");
		let moved = 0;
		for (let i = 0; i < 13; ++i)
		{
			const w = world.ents.get(4410 + i)!;
			if (w.getMetadata(PLAYER, "base") === newBase.ID && w.getMetadata(PLAYER, "target-foundation") === 4403)
				++moved;
		}
		assert.equal(moved, 10, "ten hands are sent to raise the new centre");
		const present = world.ents.get(4410)!;
		assert.equal(present.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_BUILDER);
		void base;
	});

	it("a dock foundation on an island founds a ground there and sends four hands to it", () =>
	{
		const { world, hq, base, bs } = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("200,100", 3);
		world.templates["structures/athen/dock"] = structureTemplate("structures/athen/dock",
			{ "classes": ["Structure", "Dock"], "dropsiteTypes": ["food"] });
		for (let i = 0; i < 8; ++i)
			hand(world, base, 4420 + i, {}, {}, [30 + i, 30]);
		// dock plans carry base -2, as every port of a groundless island does
		const rising = foundation(world, undefined, 4429, [200, 100], ["Dock"], { "base": -2 });

		bs.checkEvents(world.gameState, eventsWith({
			"Create": [{ "entity": entityId(4429) }]
		}));

		const islandBase = hq.baseManagers()[1];
		assert.equal(rising.getMetadata(PLAYER, "base"), islandBase.ID,
			"the dock is keyed to the island's founding ground");
		let moved = 0;
		for (let i = 0; i < 8; ++i)
		{
			const w = world.ents.get(4420 + i)!;
			if (w.getMetadata(PLAYER, "target-foundation") === 4429)
				++moved;
		}
		assert.equal(moved, 4, "four hands are sent to build the port");
	});
});

describe("a foundation standing finished: the turn of the ConstructionFinished events", () =>
{
	it("a colony's centre raised turns the ground from founding to standing, and the office is told", () =>
	{
		const { world, base, hq, bs } = seat();
		const newBase = bs.createBase(world.gameState,
			foundation(world, undefined, 4501, [250, 250], ["CivCentre"], { "base": -1 }),
			BaseManager.STATE_UNCONSTRUCTED);
		assert.equal(newBase.constructing, true);
		const calls = watchHandleNewBase(hq);
		// the raised centre carries the anchor's metadata, as the engine hands it over
		const raised = world.addEntity(makeHqEntity({
			"id": 4502, "owner": PLAYER, "position": [250, 250],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}, {}, { "base": newBase.ID, "baseAnchor": true }));

		bs.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": entityId(4501), "newentity": entityId(4502) }]
		}));

		assert.equal(newBase.constructing, false, "the ground is founding no more");
		assert.equal(calls.length, 1, "the office is told a new ground was founded");
		void base;
	});

	it("a storehouse raised joins its town's books and is booked at once", () =>
	{
		const { world, base, bs } = seat();
		const ent = foundation(world, base, 4511, [40, 40], ["Storehouse"]);
		world.removeEntity(4511);
		const raised = storehouse(world, 4512, [40, 40], ["wood"]);
		raised.setMetadata(PLAYER, "base", base.ID);

		bs.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": entityId(4511), "newentity": entityId(4512) }]
		}));

		assert.equal(base.dropsites[4512], true, "the new storehouse is on the town's list");
		assert.equal(raised.getMetadata(PLAYER, "base"), base.ID);
		void ent;
	});

	it("a repair on a standing building books nothing new", () =>
	{
		const { world, base, bs } = seat();
		storehouse(world, 4521, [40, 40]);
		base.assignEntity(world.gameState, world.ents.get(4521)!);

		bs.checkEvents(world.gameState, eventsWith({
			"ConstructionFinished": [{ "entity": entityId(4521), "newentity": entityId(4521) }]
		}));

		assert.equal(base.dropsites[4521] === undefined, false, "the storehouse keeps its place");
		const count = Object.keys(base.dropsites).length;
		assert.equal(Object.keys(base.dropsites).filter((id) => bs.baseManagers.some((b) => b.dropsites[id as unknown as number] !== undefined)).length, 1, "no doubled booking: one storehouse, one place");
	});
});

describe("a town changing hands: the turn of the OwnershipChanged events", () =>
{
	it("a storehouse taken by the raiders leaves the books, and nothing rises from it", () =>
	{
		const { world, base, bs } = seat();
		const store = storehouse(world, 4601, [40, 40]);
		base.assignEntity(world.gameState, store);
		base.assignResourceToDropsite(world.gameState, store, false);

		bs.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "from": PlayerID, "to": ENEMY, "entity": entityId(4601) }]
		}));

		assert.equal(base.dropsites[4601], undefined, "the taken storehouse is off the town's list");
		assert.equal(base.anchor?.id(), 1000, "the town's centre is untouched");
	});

	it("a centre taken by the raiders costs the town its ground", () =>
	{
		const { world, base, bs, hq } = seat();

		bs.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "from": PlayerID, "to": ENEMY, "entity": entityId(1000) }]
		}));

		assert.equal(base.anchor, undefined);
		assert.equal(hq.numActiveBases(), 0, "the captured centre is no ground of ours any more");
	});

	it("a centre taken from the enemy is founded as a new ground, and the office is told", () =>
	{
		const { world, hq, bs } = seat();
		const calls = watchHandleNewBase(hq);
		const captured = world.addEntity(makeHqEntity({
			"id": 4611, "owner": PLAYER, "position": [250, 250],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
		}));

		bs.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "from": ENEMY, "to": PlayerID, "entity": entityId(4611) }]
		}));

		const ground = bs.baseManagers.find((b) => b.constructing === false && b.ID !== bs.baseManagers[0].ID);
		assert.ok(ground, "the captured centre makes a town");
		assert.equal(ground?.anchor?.id(), 4611);
		assert.equal(captured.getMetadata(PLAYER, "base"), ground?.ID);
		assert.equal(calls.length, 1, "the office is told the new ground stands");
	});

	it("a storehouse won back from the raiders returns to the standing town's books", () =>
	{
		const { world, base, bs } = seat();
		const won = storehouse(world, 4621, [244, 20]);
		// the enemy kept our metadata; it resurfaces on recapture
		won.setMetadata(PLAYER, "base", base.ID);

		bs.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "from": ENEMY, "to": PlayerID, "entity": entityId(4621) }]
		}));

		const mine = bs.baseManagers.find((b) => b.dropsites[4621] !== undefined);
		assert.ok(mine, "the won-back storehouse is booked on a ground of ours");
		assert.equal(won.getMetadata(PLAYER, "base"), base.ID, "the storehouse answers to its old town again");
	});

	it("a unit won from the enemy joins the town it stands nearest", () =>
	{
		const { world, base, bs } = seat();
		const joined = world.addEntity(makeHqEntity({
			"id": 4631, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}));

		bs.checkEvents(world.gameState, eventsWith({
			"OwnershipChanged": [{ "from": ENEMY, "to": PlayerID, "entity": entityId(4631) }]
		}));

		assert.equal(joined.getMetadata(PLAYER, "base"), base.ID, "the won worker answers to the town");
	});
});

describe("a body fresh off the training yard: the turn of the TrainingFinished events", () =>
{
	it("a worker trained with no town yet joins the nearest ground and is set to work", () =>
	{
		const { world, base, bs } = seat();
		const bush = rawSupply(world, 4702, [30, 30], "food", "fruit");
		// the town's centre is a universal dropsite, as every civil centre template is
		bookCentreSupplies(world, base);
		world.addEntity(makeHqEntity({
			"id": 4701, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => true,
			"unitAIState": () => "INDIVIDUAL.IDLE",
			"canGather": () => true,
			"isGatherer": () => true,
			"isBuilder": () => true,
			"canAttackClass": () => false,
			// a citizen-soldier's template rates: the common gatherable kinds
			"resourceGatherRates": () =>
				({ "food.fruit": 1, "food.meat": 1, "wood.tree": 1, "stone.rock": 1, "metal.ore": 1 })
		}, { "role": Worker.ROLE_WORKER }));

		bs.checkEvents(world.gameState, eventsWith({
			"TrainingFinished": [{ "entities": [entityId(4701)], "owner": PLAYER }]
		}));

		const fresh = world.ents.get(4701)!;
		assert.equal(fresh.getMetadata(PLAYER, "base"), base.ID, "the recruit joins the nearest town");
		assert.equal(fresh.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_GATHERER, "the recruit is put to the fields");
		assert.ok(["food", "wood", "stone", "metal"].includes(fresh.getMetadata(PLAYER, "gather-type") as string));
		assert.equal(fresh.getMetadata(PLAYER, "supply"), bush.id(), "the recruit is sent to the nearest supply");
	});

	it("a worker trained for its own town goes to work on that town's turn", () =>
	{
		const { world, base, bs } = seat();
		const bush = rawSupply(world, 4712, [30, 30], "food", "fruit");
		bookCentreSupplies(world, base);
		world.addEntity(makeHqEntity({
			"id": 4711, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => true,
			"unitAIState": () => "INDIVIDUAL.IDLE",
			"canGather": () => true,
			"isGatherer": () => true,
			"isBuilder": () => true,
			"canAttackClass": () => false,
			"resourceGatherRates": () =>
				({ "food.fruit": 1, "food.meat": 1, "wood.tree": 1, "stone.rock": 1, "metal.ore": 1 })
		}, { "role": Worker.ROLE_WORKER, "base": base.ID }));

		bs.checkEvents(world.gameState, eventsWith({
			"TrainingFinished": [{ "entities": [entityId(4711)], "owner": PLAYER }]
		}));

		const fresh = world.ents.get(4711)!;
		assert.equal(fresh.getMetadata(PLAYER, "base"), base.ID, "the recruit stays with its town");
		assert.equal(fresh.getMetadata(PLAYER, "subrole"), Worker.SUBROLE_GATHERER);
		assert.equal(fresh.getMetadata(PLAYER, "supply"), bush.id(), "and is sent to the town's nearest supply");
	});

	// port-only: a worker whose plan carries no live ground (base -1, or a
	// town that fell before it finished) is guarded with "if (!base) continue"
	// before reassignment; the reference dereferences the missing base and
	// throws (see basesManager.ts TrainingFinished).
	it("a worker whose plan had no ground yet is left for the next turn to place", () =>
	{
		const { world, bs } = seat();
		world.addEntity(makeHqEntity({
			"id": 4721, "owner": PLAYER, "position": [200, 200],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {}, { "role": Worker.ROLE_WORKER, "base": -1 }));

		bs.checkEvents(world.gameState, eventsWith({
			"TrainingFinished": [{ "entities": [entityId(4721)], "owner": PLAYER }]
		}));

		const fresh = world.ents.get(4721)!;
		assert.equal(fresh.getMetadata(PLAYER, "base"), -1, "no bogus ground is found for a -1 plan");
	});

	// a supply unit delivered by a market order walks to its dropsite. The
	// port tells it with the exact-point `move` and the reference with
	// `moveToRange` — but with no min/max the engine resolves moveToRange to
	// the same point-walk, so both commands are equivalent (see UnitAI.MoveTo).
	it("livestock won from the market walks to the nearest dropsite", () =>
	{
		const { world, base, bs } = seat();
		base.assignEntity(world.gameState, storehouse(world, 4731, [40, 40], ["food"]));
		const arrived: number[] = [];
		world.addEntity(makeHqEntity({
			"id": 4732, "owner": PLAYER, "position": [30, 30],
			"classes": ["Unit", "Animal", "Herd"]
		}, {
			"resourceSupplyType": () => ({ "generic": "food", "specific": "meat" }),
			// both commands the AI may use to send the herd to the dropsite
			"move": (x: number) => { arrived.push(x); },
			"moveToRange": (x: number) => { arrived.push(x); }
		}));

		bs.checkEvents(world.gameState, eventsWith({
			"TrainingFinished": [{ "entities": [entityId(4732)], "owner": PLAYER }]
		}));

		assert.deepEqual(arrived, [40], "the herd walks to the storehouse");
	});
});

describe("hands called across the city: bulkPickWorkers", () =>
{
	/** a colony ground awaiting builders, as the office founds one */
	function colonyGround(world: HqWorld, hq: Headquarters, id: number): BaseManager
	{
		return hq.basesManager.createBase(world.gameState,
			foundation(world, undefined, id, [250, 250], ["CivCentre"], { "base": -1 }),
			BaseManager.STATE_UNCONSTRUCTED);
	}

	it("ten hands answer a colony's call from towns short of them, each town keeping its three", () =>
	{
		const { world, hq, base, bs } = seat();
		for (let i = 0; i < 5; ++i)
			hand(world, base, 4801 + i, {}, {}, [20 + i, 20]);
		const colony = secondTown(world, hq, 4800, [240, 240]);
		for (let i = 0; i < 8; ++i)
			hand(world, colony, 4810 + i, {}, {}, [240 + i, 240]);
		const newGround = colonyGround(world, hq, 4830);

		const lent = bs.bulkPickWorkers(world.gameState, newGround, 10);

		assert.ok(lent !== false, "the city answers the call");
		const lentIds = lent.toIdArray();
		// ten asked; every town hands over its hands beyond the three it keeps
		assert.equal(lentIds.length, 7, "2 of five and 5 of eight march, three works per town stay");
		assert.deepEqual([base.workers.length, colony.workers.length], [5, 8],
			"the lends are only set aside; the caller binds them to the new ground");
	});

	it("a city of idle hands answers no call", () =>
	{
		const { world, hq, bs } = seat();
		const newGround = colonyGround(world, hq, 4831);

		const lent = bs.bulkPickWorkers(world.gameState, newGround, 10);

		assert.equal(lent, false, "with nobody to give, the call is refused");
	});
});

describe("the office's turn tally: gatherers and their supplies", () =>
{
	it("a gatherer walking home with its crop is counted for its supply this turn", () =>
	{
		const { world, base, bs } = seat();
		hand(world, base, 4901,
			{ "supply": 5001 },
			{
				"unitAIState": () => "INDIVIDUAL.RETURNRESOURCE.APPROACHING",
				"unitAIOrderData": () => [{ "target": 4000 }, { "target": 5001 }]
			});

		bs.assignGatherers();

		assert.equal(bs.GetTCGatherer(entityId(5001)), 1, "the pack-man is on the tally for the supply he carries");
		assert.equal(bs.GetTCGatherer(entityId(4000)), 0, "the crops' former bush is not counted");
	});

	it("a gatherer whose order no longer names its supply is not counted", () =>
	{
		const { world, base, bs } = seat();
		hand(world, base, 4911,
			{ "supply": 5011 },
			{
				"unitAIState": () => "INDIVIDUAL.RETURNRESOURCE.APPROACHING",
				"unitAIOrderData": () => [{ "target": 5012 }, { "target": 5013 }]
			});

		bs.assignGatherers();

		assert.equal(bs.GetTCGatherer(entityId(5011)), 0);
	});

	it("a gatherer leaving a supply counted on an earlier turn seeds the tally without dipping past zero", () =>
	{
		const { world, hq, base, bs } = seat();
		// last turn the pack-man took the supply; the office has since reset its tally
		hq.basesManager.checkEvents(world.gameState, emptyEvents());
		hand(world, base, 4921, { "supply": 5021 });
		void bs;

		// the release is tallied through the base's own counters, as the turn order does
		(base as unknown as { RemoveTCGatherer(id: number): void }).RemoveTCGatherer(5021);

		const tally = (hq.basesManager as unknown as { turnCache: { resourceGatherer: Record<number, number> } })
			.turnCache.resourceGatherer;
		assert.equal(tally[5021], -1, "the leave is seeded, not doubled");
		hq.basesManager.AddTCGatherer(entityId(5021));
		assert.equal(hq.basesManager.GetTCGatherer(entityId(5021)), 0, "a hand taking and leaving the same supply nets zero");
	});
});

describe("a body placed by the opening plan: the starting-strategy placing", () =>
{
	it("a dock placed on our own coast answers to our town, and its crew to it", () =>
	{
		const { world, base, bs } = seat();
		const garrisonedUnit = world.addEntity(makeHqEntity({
			"id": 4952, "owner": PLAYER, "position": [300, 40],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => true, "unitAIState": () => "INDIVIDUAL.IDLE",
			"canGather": () => true, "isGatherer": () => true, "canAttackClass": () => false
		}));
		const dock = world.addEntity(makeHqEntity({
			"id": 4953, "owner": PLAYER, "position": [302, 40],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, {
			"resourceDropsiteTypes": () => ["food"],
			"isResourceDropsite": (r?: string) => !r || r === "food",
			"isGarrisonHolder": () => true,
			"garrisoned": () => [4952]
		}));

		bs.assignEntity(world.gameState, dock, territoryCellAt([302, 40]));

		assert.equal(dock.getMetadata(PLAYER, "base"), base.ID, "the dock answers to the town");
		assert.equal(garrisonedUnit.getMetadata(PLAYER, "base"), base.ID, "so does the crew inside it");
	});

	it("a port placed on an island with no town of ours founds a ground there", () =>
	{
		const { world, hq, bs } = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("240,240", 3);
		world.templates["structures/athen/dock"] = structureTemplate("structures/athen/dock",
			{ "classes": ["Structure", "Dock"], "dropsiteTypes": ["food"] });
		const before = hq.baseManagers().length;
		const port = world.addEntity(makeHqEntity({
			"id": 4961, "owner": PLAYER, "position": [240, 240],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, {
			"resourceDropsiteTypes": () => ["food"],
			"isResourceDropsite": (r?: string) => !r || r === "food"
		}));
		hq.updateTerritories(world.gameState);

		bs.assignEntity(world.gameState, port, territoryCellAt([240, 240]));

		assert.equal(hq.baseManagers().length, before + 1, "the island port gets its own ground");
		assert.equal(port.getMetadata(PLAYER, "base"), hq.baseManagers()[before].ID);
	});

	it("a worker placed in our own ground is put to work at once", () =>
	{
		const { world, base, bs } = seat();
		const bush = rawSupply(world, 4972, [30, 30], "food", "fruit");
		bookCentreSupplies(world, base);
		world.addEntity(makeHqEntity({
			"id": 4971, "owner": PLAYER, "position": [30, 30],
			"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => true, "unitAIState": () => "INDIVIDUAL.IDLE",
			"canGather": () => true, "isGatherer": () => true, "isBuilder": () => true,
			"canAttackClass": () => false,
			"resourceGatherRates": () =>
				({ "food.fruit": 1, "food.meat": 1, "wood.tree": 1, "stone.rock": 1, "metal.ore": 1 })
		}));

		bs.assignEntity(world.gameState, world.ents.get(4971)!, territoryCellAt([30, 30]));

		const placed = world.ents.get(4971)!;
		assert.equal(placed.getMetadata(PLAYER, "base"), base.ID);
		assert.equal(placed.getMetadata(PLAYER, "role"), Worker.ROLE_WORKER, "the opening plan's hands know their trade");
		assert.equal(placed.getMetadata(PLAYER, "supply"), bush.id(), "and walk to their first crop at once");
	});

	it("a scout placed outside every ground answers the nearest town, not a groundless pool", () =>
	{
		const { world, hq, base, bs } = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("240,240", 3);
		hq.updateTerritories(world.gameState);
		world.addEntity(makeHqEntity({
			"id": 4981, "owner": PLAYER, "position": [240, 240],
			"classes": ["Unit", "Cavalry", "Scout"]
		}));

		bs.assignEntity(world.gameState, world.ents.get(4981)!, territoryCellAt([240, 240]));

		const stranded = world.ents.get(4981)!;
		// a unit, unlike a building, may answer a town across the water
		assert.equal(stranded.getMetadata(PLAYER, "base"), base.ID, "the scout answers the nearest town");
	});
});

