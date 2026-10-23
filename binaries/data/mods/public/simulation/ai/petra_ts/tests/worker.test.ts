/**
 * Worker: the pair of hands each town sends to the fields, the herds, the
 * sea and the scaffolding. The suites seat a real Headquarters on the small
 * engine-truthful board (see tests/harness/hqWorld.ts) and drive one worker
 * through the turns of a real campaign: gathering what the town lacks,
 * hunting the herds, fishing the shoals, and raising the town's dropsites
 * and fields.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPetraModule } from "./harness/target.ts";
import {
	makeGaiaSupply, makeHqEntity, makeHqWorld, seatHQ, structureTemplate, PLAYER, ENEMY,
	type HqInstance, type HqSeatOptions, type HqWorldOptions
} from "./harness/hqWorld.ts";
import type { HqWorld } from "./harness/hqWorld.ts";

const { BaseManager } = await loadPetraModule<{
	BaseManager: {
		STATE_WITH_ANCHOR: string;
	};
}>("baseManager");
const { Worker } = await loadPetraModule<{
	Worker: {
		ROLE_WORKER: string;
		SUBROLE_IDLE: string;
		SUBROLE_BUILDER: string;
		SUBROLE_GATHERER: string;
		SUBROLE_HUNTER: string;
		SUBROLE_FISHER: string;
	};
}>("worker");

// the player id the common-api reads metadata under
const PlayerID = 1;

// the co-managers the suites keep outside the walls, as the other campaigns do
const doorManagers = [
	"navalManager", "tradeManager", "researchManager", "diplomacyManager",
	"victoryManager", "defenseManager"
];

/** a supply entry as a town's book keeps it */
interface ResourceSupply
{
	id: number;
	dropsite: number;
	dist: number;
}

/** the base-manager members the suites read and drive, as a town holds them */
interface Base
{
	ID: number;
	workerObject: Wk;
	accessIndex: number | undefined;
	anchor: { id(): number } | undefined;
	dropsiteSupplies: Record<string, { nearby: ResourceSupply[]; medium: ResourceSupply[]; faraway: ResourceSupply[] }>;
	assignEntity(gs: unknown, ent: unknown): void;
	assignResourceToDropsite(gs: unknown, ent: unknown, deserialized: boolean): void;
	workersBySubrole(gs: unknown, subrole: string): { values(): unknown[] };
	AddTCGatherer(id: number): void;
	GetTCGatherer(id: number): number;
	RemoveTCGatherer(id: number): void;
	workers: { length: number };
}

/** the worker members the suites read and drive */
interface Wk
{
	ent: unknown;
	entAccess: number;
	baseAccess: number;
	baseID: number;
	update(gs: unknown, ent: unknown): void;
	startBuilding(gs: unknown): boolean;
	startGathering(gs: unknown): boolean;
	startHunting(gs: unknown, position?: [number, number]): boolean;
	startFishing(gs: unknown): boolean;
	retryWorking(gs: unknown, subrole: string): boolean;
	gatherNearestField(gs: unknown, baseID: number): unknown | false;
	buildAnyField(gs: unknown, baseID: number): unknown | false;
	moveToGatherer(gs: unknown, ent: unknown, forced: boolean): void;
	isInaccessibleSupply(gs: unknown): boolean;
}

/** a seat of the office on the standard board, with the town's worker pair */
function seat(worldOptions: Partial<HqWorldOptions> = {}, seatOptions: Partial<HqSeatOptions> = {})
{
	const world = makeHqWorld(worldOptions as HqWorldOptions);
	const hq = seatHQ(world, { stubs: doorManagers, ...seatOptions });
	hq.updateTerritories(world.gameState);
	const base = hq.baseManagers()[0] as unknown as Base;
	return { world, hq, base, worker: base.workerObject as Wk };
}

/** prime the worker's private state the way update() would before a call */
function prime(w: Wk, ent: unknown, access = 2): void
{
	w.ent = ent;
	w.entAccess = access;
	w.baseAccess = access;
}

/** a worker of ours, on a base's payroll with the given metadata and methods */
function hand(world: HqWorld, host: Base, id: number, metadata: Record<string, unknown>,
	methods: Record<string, unknown> = {}, position: [number, number] = [60, 60])
{
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position,
		"classes": ["Unit", "Infantry", "CitizenSoldier", "Worker"] }, {
		"isIdle": () => true,
		"unitAIState": () => "INDIVIDUAL.IDLE",
		"unitAIOrderData": () => [],
		"currentGatherRate": () => 0,
		"canGather": () => true,
		"isGatherer": () => true,
		"isBuilder": () => true,
		"stopMoving": () => undefined,
		"canAttackClass": () => false,
		"resourceCarrying": () => [],
		"resourceGatherRates": () =>
			({ "food.fruit": 1, "food.meat": 1, "food.grain": 1, "wood.tree": 1, "stone.rock": 1, "metal.ore": 1 }),
		...methods
	}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "wood", ...metadata }));
	host.assignEntity(world.gameState, ent);
	return ent;
}

/** a raw supply with the engine's template leaves the gatherer search reads */
function rawSupply(world: HqWorld, id: number, position: [number, number],
	generic: string, specific: string, methods: Record<string, unknown> = {})
{
	return world.addEntity(makeGaiaSupply({ id, position, generic, specific }, {
		"get": (path: string) => path === "ResourceSupply/Type" ? generic + "." + specific : undefined,
		"resourceSupplyNumGatherers": () => 0,
		"maxGatherers": () => 8,
		...methods
	}));
}

/** the town's centre as the universal dropsite every civil centre template is,
 * with the map's supplies around it booked into the town's books */
function bookCentreSupplies(world: HqWorld, base: Base): void
{
	const cc = world.ents.get(1000) as unknown as {
		resourceDropsiteTypes: () => void;
		isResourceDropsite: (resource?: string) => void;
	};
	cc.resourceDropsiteTypes = () => ["food", "wood", "stone", "metal"];
	cc.isResourceDropsite = (resource?: string) =>
		!resource || ["food", "wood", "stone", "metal"].includes(resource);
	base.assignResourceToDropsite(world.gameState, base.anchor as never, false);
}

/** a storehouse of ours, dropping wood */
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

/** the ids a town's book holds in the given band, for a clear assertion */
function booked(base: Base, resource: string, band: "nearby" | "medium" | "faraway"): number[]
{
	return (base.dropsiteSupplies[resource][band] as ResourceSupply[]).map((r) => r.id);
}

describe("a worker at the scaffolding: startBuilding and retryWorking", () =>
{
	it("a hand told to raise a standing, undamaged building finds nothing to do", () =>
	{
		const { world, base, worker } = seat();
		const store = storehouse(world, 6001, [40, 40]);
		base.assignEntity(world.gameState, store);
		const ent = hand(world, base, 6002, { "target-foundation": 6001 });
		prime(worker, ent);

		assert.equal(worker.startBuilding(world.gameState), false, "nothing to repair");
	});

	it("a hand told to raise a foundation across the water cannot reach it", () =>
	{
		const { world, base, worker } = seat();
		const rising = world.addEntity(makeHqEntity({
			"id": 6011, "owner": PLAYER, "position": [240, 240],
			"classes": ["Structure", "Storehouse"], "templateName": "foundation|structures/athen/storehouse"
		}, { "foundationProgress": () => 0.4, "needsRepair": () => true }));
		world.accessAt.set("240,240", 3);
		// the town stays on land 2
		const ent = hand(world, base, 6012, { "target-foundation": 6011 });
		prime(worker, ent);

		assert.equal(worker.startBuilding(world.gameState), false, "the crossing bars the hand");
		void rising;
	});

	it("a hand at a foundation's side raises it, and a house keeps the crew at it", () =>
	{
		const { world, base, worker } = seat();
		const rising = world.addEntity(makeHqEntity({
			"id": 6021, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "House"], "templateName": "foundation|structures/athen/house"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }));
		const repaired: unknown[] = [];
		const ent = hand(world, base, 6022, { "target-foundation": 6021 },
			{ "repair": (target: unknown, auto: boolean) => repaired.push([target, auto]) });
		prime(worker, ent);

		assert.equal(worker.startBuilding(world.gameState), true);
		assert.deepEqual(repaired, [[rising, true]], "the hand raises the house and stays on it");
	});
});

describe("a worker picking its crop: startGathering", () =>
{
	it("a woodcutter walks to the nearest tree the town has booked", () =>
	{
		const { world, base, worker } = seat();
		const bush = rawSupply(world, 6031, [30, 30], "food", "fruit");
		const tree = rawSupply(world, 6032, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6033, { "gather-type": "wood" },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6032], "the woodcutter walks to the tree, not the berries");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6032);
		void bush;
	});

	it("a supply already stripped bare is passed over for the next tree", () =>
	{
		const { world, base, worker } = seat();
		const stripped = rawSupply(world, 6041, [30, 30], "wood", "tree",
			{ "resourceSupplyAmount": () => 0, "resourceSupplyMax": () => 0 });
		const tree = rawSupply(world, 6042, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6043, { "gather-type": "wood" },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		worker.startGathering(world.gameState);

		assert.deepEqual(gathered, [6042], "the bare tree is skipped");
	});

	it("with nothing of its crop left anywhere, a hand gives up its trade for the turn", () =>
	{
		const { world, hq, base, worker } = seat();
		// no wood supplies at all: the book is empty
		const ent = hand(world, base, 6051, { "gather-type": "wood" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), false);
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE, "the woodcutter is idled");
		assert.equal((hq as unknown as { lastFailedGather: Record<string, number> }).lastFailedGather.wood,
			(world.gameState as unknown as { ai: { elapsedTime: number } }).ai.elapsedTime);
	});
});

describe("a worker at the fields: gatherNearestField and buildAnyField", () =>
{
	/** a built field the town owns, as the farm the town raised */
	function field(world: HqWorld, id: number, position: [number, number], baseID: number,
		diminishing = 1, numGatherers = 0)
	{
		return world.addEntity(makeHqEntity({
			"id": id, "owner": PLAYER, "position": position,
			"classes": ["Structure", "Field"], "templateName": "structures/athen/field"
		}, {
			"get": (path: string) => path === "ResourceSupply/Type" ? "food.grain" : undefined,
			"resourceSupplyNumGatherers": () => numGatherers,
			"resourceSupplyAmount": () => 1000,
			"getDiminishingReturns": () => diminishing,
			"maxGatherers": () => 8
		}, { "base": baseID }));
	}

	it("a thinned field is passed over even when nearer than a full one", () =>
	{
		const { world, base, worker } = seat();
		// the full field stands a little farther; the thinned one is closer but
		// its diminishing returns price it out of the choice
		field(world, 6062, [20, 20], base.ID, 0.5, 4);
		field(world, 6061, [30, 30], base.ID, 1, 0);
		const ent = hand(world, base, 6063, { "gather-type": "food" });
		prime(worker, ent);

		const picked = worker.gatherNearestField(world.gameState, base.ID) as { id(): number };

		assert.ok(picked, "a field is found");
		assert.equal(picked.id(), 6061, "the full field wins over the nearer, thinned one");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6061);
	});

	it("a hand who cannot build leaves the field-foundations alone", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6071, { "gather-type": "food" }, { "isBuilder": () => false });
		prime(worker, ent);

		assert.equal(worker.buildAnyField(world.gameState, base.ID), false);
	});

	it("a builder is sent to the nearest field-foundation of its town", () =>
	{
		const { world, base, worker } = seat();
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Field"], "maxGatherers": 8 });
		const rising = world.addEntity(makeHqEntity({
			"id": 6081, "owner": PLAYER, "position": [44, 44],
			"classes": ["Structure", "Field"], "templateName": "foundation|structures/athen/field"
		}, { "foundationProgress": () => 0.3, "getBuildersNb": () => 0 }, { "base": base.ID }));
		const ent = hand(world, base, 6082, { "gather-type": "food" });
		prime(worker, ent);

		const picked = worker.buildAnyField(world.gameState, base.ID) as { id(): number };

		assert.ok(picked, "a field-foundation is found");
		assert.equal(picked.id(), 6081, "the builder joins the field-foundation");
		void rising;
	});
});

describe("a worker elephant moving aside: moveToGatherer", () =>
{
	it("a dropsite-bearer follows the nearest gatherer so its crop can be dropped", () =>
	{
		const { world, base, worker } = seat();
		const gatherer = hand(world, base, 6091, { "gather-type": "wood" },
			{ "isIdle": () => false }, [50, 50]);
		// the mobile dropsite the elephant carries
		const moved: number[] = [];
		const bearer = world.addEntity(makeHqEntity({
			"id": 6092, "owner": PLAYER, "position": [20, 20],
			"classes": ["Unit", "Support", "Elephant"]
		}, {
			"resourceDropsiteTypes": () => ["wood", "food"],
			"move": (x: number) => moved.push(x)
		}));

		worker.moveToGatherer(world.gameState, bearer, true);

		assert.deepEqual(moved, [50], "the bearer walks to the woodcutter");
		void gatherer;
	});
});

describe("a worker after the herds: startHunting", () =>
{
	/** a huntable animal the map places, domestic or wild */
	function animal(world: HqWorld, id: number, position: [number, number], domestic = false)
	{
		return world.addEntity(makeGaiaSupply({
			"id": id, "position": position, "generic": "food", "specific": "meat",
			"classes": domestic ? ["Animal", "Domestic"] : ["Animal"]
		}, {
			"get": (path: string) => path === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0,
			"maxGatherers": () => 8
		}));
	}

	it("a map without herds gives the hunter nothing to do", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6101, { "subrole": Worker.SUBROLE_HUNTER });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a hunter walks to the cattle, which do not flee", () =>
	{
		const { world, base, worker } = seat();
		const cow = animal(world, 6111, [40, 40], true);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6112, { "subrole": Worker.SUBROLE_HUNTER },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [6111], "the hunter walks to the cattle");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6111);
		void cow;
	});

	it("an infantry hand cannot chase down a fleeing deer", () =>
	{
		const { world, base, worker } = seat();
		animal(world, 6121, [40, 40], false);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6122, { "subrole": Worker.SUBROLE_HUNTER },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false, "the deer outruns the infantry");
		assert.deepEqual(gathered, []);
	});

	it("a rider can chase down a fleeing deer", () =>
	{
		const { world, base, worker } = seat();
		const deer = animal(world, 6131, [40, 40], false);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = world.addEntity(makeHqEntity({
			"id": 6132, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Cavalry", "FastMoving", "CitizenSoldier", "Worker"]
		}, {
			"isIdle": () => true, "unitAIState": () => "INDIVIDUAL.IDLE",
			"isGatherer": () => true, "isBuilder": () => true, "canAttackClass": () => false,
			"resourceGatherRates": () => ({ "food.meat": 1 }),
			"gather": (target: unknown) => gathered.push((target as { id(): number }).id())
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_HUNTER }));
		base.assignEntity(world.gameState, ent);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [6131], "the rider runs the deer down");
		void deer;
	});

	it("a hunter asked whether an island pasture is reachable answers without moving", () =>
	{
		const { world, base, worker } = seat();
		const cow = animal(world, 6141, [40, 40], true);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6142, { "subrole": Worker.SUBROLE_HUNTER },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState, [45, 45]), true, "there is game around");
		assert.deepEqual(gathered, [], "but the hand stays put for now");
		void cow;
	});

	it("a hunter leaves the enemy's herds alone", () =>
	{
		const { world, base, worker } = seat();
		animal(world, 6151, [40, 40], true);
		bookCentreSupplies(world, base);
		// the pasture stands on hostile ground (territory cell 5,5)
		world.map.setTerritoryOwner(5, 5, ENEMY);
		const gathered: number[] = [];
		const ent = hand(world, base, 6152, { "subrole": Worker.SUBROLE_HUNTER },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false, "the enemy's cattle are not ours to take");
		assert.deepEqual(gathered, []);
	});
});

/** a second town of ours on the board, as a colony raises */
function secondTown(world: HqWorld, hq: HqInstance, id: number, position: [number, number]): Base
{
	const cc = world.addEntity(makeHqEntity({
		"id": id, "owner": PLAYER, "position": position,
		"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre"
	}));
	const town = hq.basesManager.createBase(world.gameState, cc, BaseManager.STATE_WITH_ANCHOR) as unknown as Base;
	hq.updateTerritories(world.gameState);
	return town;
}

describe("a worker roaming further afield: startGathering beyond its own town", () =>
{
	it("a woodcutter whose town is bare works the next town's wood instead", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 6201, [240, 240]);
		// the colony's storehouse books its own stand of trees the moment it is
		// assigned to the town, so the stand must already be on the map
		const store = storehouse(world, 6202, [230, 230]);
		const tree = rawSupply(world, 6203, [235, 235], "wood", "tree");
		colony.assignEntity(world.gameState, store);
		const gathered: number[] = [];
		const ent = hand(world, base, 6204, { "gather-type": "wood" },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6203], "the woodcutter crosses to the colony's stand");
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID, "and answers to the colony now");
		void tree;
	});

	it("a hand with nothing to cut joins the raising of a storehouse for its crop", () =>
	{
		const { world, base, worker } = seat();
		world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse",
			{ "classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood"] });
		const rising = world.addEntity(makeHqEntity({
			"id": 6211, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "Storehouse"], "templateName": "foundation|structures/athen/storehouse"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }, { "base": base.ID }));
		const repaired: number[] = [];
		const ent = hand(world, base, 6212, { "gather-type": "wood" },
			{ "repair": (target: unknown) => repaired.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(repaired, [6211], "the hand raises the storehouse");
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER);
		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), 6211);
		void rising;
	});

	it("a woodcutter travels to a far stand when the near ones are gone", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6221, [260, 10], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6222, { "gather-type": "wood" },
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6221], "the far stand is the only wood left");
		void tree;
	});
});

describe("a worker through its turn: update", () =>
{
	it("a hand on a building plan is left to the plan, not the fields", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6231, { "subrole": Worker.SUBROLE_BUILDER, "plan": -2, "target-foundation": 6001 });

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER, "the plan keeps its hand");
	});

	it("an idle gatherer takes up its crop at the turn's start", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6241, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6242, { "gather-type": "wood", "subrole": Worker.SUBROLE_GATHERER },
			{ "isIdle": () => true, "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6241], "the hand walks to the tree");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6241);
		void tree;
	});

	it("a builder already on a scaffold is left to it", () =>
	{
		const { world, base, worker } = seat();
		const rising = world.addEntity(makeHqEntity({
			"id": 6251, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "House"], "templateName": "foundation|structures/athen/house"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }));
		const ent = hand(world, base, 6252,
			{ "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 6251 },
			{ "unitAIState": () => "INDIVIDUAL.REPAIR.APPROACHING" });

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER, "still a builder");
		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), 6251, "still on the scaffold");
		void rising;
	});

	it("an idle hunter chases the herd when the turn opens", () =>
	{
		const { world, base, worker } = seat();
		const cow = world.addEntity(makeGaiaSupply({
			"id": 6261, "position": [40, 40], "generic": "food", "specific": "meat",
			"classes": ["Animal", "Domestic"]
		}, {
			"get": (path: string) => path === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
		bookCentreSupplies(world, base);
		const ent = hand(world, base, 6262, { "subrole": Worker.SUBROLE_HUNTER },
			{ "isIdle": () => true });

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "supply"), 6261, "the hunter took up the cattle");
		void cow;
	});

	it("a fisher with no shoals left scuttles its boat", () =>
	{
		const { world, hq, base, worker } = seat();
		const scuttled: number[] = [];
		const ent = hand(world, base, 6271, { "subrole": Worker.SUBROLE_FISHER },
			{ "isIdle": () => true, "destroy": () => scuttled.push(1) });

		worker.update(world.gameState, ent);

		assert.equal(scuttled.length, 1, "the boat is scuttled");
		const calls = hq.navalManagerCalls as Array<[string, unknown[]]>;
		assert.ok(calls.some(([m]) => m === "resetFishingBoats"), "the fleet is told the boat is gone");
	});
});
