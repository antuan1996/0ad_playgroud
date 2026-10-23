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
import type { FakeEnt } from "./harness/attackWorld.ts";

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
	anchorLost(gs: unknown): void;
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

/**
 * A citizen cavalryman on a town's payroll: the only kind of unit Petra makes a
 * hunter (baseManager.reassignIdleWorkers: FastMoving, able to gather food and
 * attack animals). The template gives it no Worker class and gathers meat only
 * (template_unit_cavalry.xml), and a hunter is never given a gather-type.
 */
function rider(world: HqWorld, host: Base, id: number, metadata: Record<string, unknown> = {},
	methods: Record<string, unknown> = {}, position: [number, number] = [60, 60])
{
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position,
		"classes": ["Unit", "Cavalry", "FastMoving", "CitizenSoldier"] }, {
		"isIdle": () => true,
		"unitAIState": () => "INDIVIDUAL.IDLE",
		"unitAIOrderData": () => [],
		"isGatherer": () => true,
		"isBuilder": () => false,
		"canAttackClass": () => true,
		"resourceCarrying": () => [],
		"resourceGatherRates": () => ({ "food.meat": 1 }),
		...methods
	}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_HUNTER, ...metadata }));
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
		resourceSupplyType: () => void;
		resourceSupplyNumGatherers: () => void;
		resourceSupplyAmount: () => void;
	};
	// a dropsite is no supply: the common-api answers undefined (entity.js)
	cc.resourceSupplyType = () => undefined;
	cc.resourceSupplyNumGatherers = () => undefined;
	cc.resourceSupplyAmount = () => undefined;
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

	it("a map without herds gives a hungry hand nothing to hunt", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6101, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a hungry hand walks to the cattle, which do not flee", () =>
	{
		const { world, base, worker } = seat();
		const cow = animal(world, 6111, [40, 40], true);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6112, { "gather-type": "food" },
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
		const ent = hand(world, base, 6122, { "gather-type": "food" },
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
		const ent = rider(world, base, 6132, {},
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
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
		const ent = rider(world, base, 6142, {},
			{ "gather": (target: unknown) => gathered.push((target as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState, [45, 45]), true, "there is game around");
		assert.deepEqual(gathered, [], "but the hand stays put for now");
		void cow;
	});

	it("a hungry hand leaves the enemy's herds alone", () =>
	{
		const { world, base, worker } = seat();
		animal(world, 6151, [40, 40], true);
		bookCentreSupplies(world, base);
		// the pasture stands on hostile ground (territory cell 5,5)
		world.map.setTerritoryOwner(5, 5, ENEMY);
		const gathered: number[] = [];
		const ent = hand(world, base, 6152, { "gather-type": "food" },
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
		const ent = rider(world, base, 6262);

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

describe("a worker stuck on the way: isInaccessibleSupply", () =>
{
	it("a hand with no order at hand is not stuck", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6301, { "subrole": Worker.SUBROLE_GATHERER },
			{ "unitAIOrderData": () => [] });
		prime(worker, ent);

		assert.equal(worker.isInaccessibleSupply(world.gameState), false);
	});

	it("a hand whose crop has vanished is stuck", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 6311, {}, { "unitAIOrderData": () => [{ "target": 9999 }] });
		prime(worker, ent);

		assert.equal(worker.isInaccessibleSupply(world.gameState), true);
	});

	it("a hand approaching a standing building is no supply case", () =>
	{
		const { world, base, worker } = seat();
		const store = storehouse(world, 6321, [40, 40]);
		base.assignEntity(world.gameState, store);
		const ent = hand(world, base, 6322, {}, { "unitAIOrderData": () => [{ "target": 6321 }] });
		prime(worker, ent);

		assert.equal(worker.isInaccessibleSupply(world.gameState), false);
	});

	it("a hand who fills its basket is making progress, not stuck", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6331, [30, 30], "wood", "tree");
		let carrying = 0;
		const ent = hand(world, base, 6332, { "subrole": Worker.SUBROLE_GATHERER },
			{
				"unitAIOrderData": () => [{ "target": 6331 }],
				"resourceCarrying": () => carrying > 0 ? [{ "type": "wood", "amount": carrying }] : []
			});
		prime(worker, ent);

		worker.isInaccessibleSupply(world.gameState);   // records the empty basket
		carrying = 5;
		assert.equal(worker.isInaccessibleSupply(world.gameState), false, "the filled basket is progress");
		void tree;
	});

	it("a hand stuck on one tile for a long while marks its crop unreachable", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6341, [30, 30], "wood", "tree");
		const gathered: number[] = [];
		const ent = hand(world, base, 6342, { "subrole": Worker.SUBROLE_GATHERER },
			{
				"unitAIOrderData": () => [{ "target": 6341 }],
				"gather": (target: unknown) => gathered.push((target as { id(): number }).id())
			});
		prime(worker, ent);
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };

		assert.equal(worker.isInaccessibleSupply(world.gameState), false);   // first approach
		gs.ai.elapsedTime = 112;
		assert.equal(worker.isInaccessibleSupply(world.gameState), false);   // stuck: retry once
		assert.deepEqual(gathered, [6341], "the hand retries the crop");
		gs.ai.elapsedTime = 124;
		assert.equal(worker.isInaccessibleSupply(world.gameState), false);   // re-approach
		gs.ai.elapsedTime = 136;
		assert.equal(worker.isInaccessibleSupply(world.gameState), true, "the crop is marked unreachable");
		assert.equal(tree.getMetadata(PlayerID, "inaccessibleTime"), 736);
	});
});

describe("a fisher on the shoals: startFishing", () =>
{
	/** the dock the catch lands at, and the shoal beside it */
	function fishingGround(world: HqWorld, base: Base, seaIndex: number): { dock: FakeEnt; fish: FakeEnt }
	{
		const dock = world.addEntity(makeHqEntity({
			"id": 6401, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, {
			"resourceDropsiteTypes": () => ["food"],
			"isResourceDropsite": (r?: string) => !r || r === "food"
		}, { "sea": seaIndex }));
		base.assignEntity(world.gameState, dock);
		const fish = world.addEntity(makeGaiaSupply({
			"id": 6402, "position": [60, 60], "generic": "food", "specific": "fish", "classes": ["SeaCreature"]
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
		return { dock, fish };
	}

	it("a fisher casts at the nearest shoal beside its dock", () =>
	{
		const { world, hq, base, worker } = seat();
		(hq.navalManager as unknown as { getFishSea: (g: unknown, e: unknown) => number }).getFishSea = () => 5;
		(hq.navalManager as unknown as { canFishSafely: (g: unknown, e: unknown) => boolean }).canFishSafely = () => true;
		const { fish } = fishingGround(world, base, 5);
		const gathered: number[] = [];
		const ent = world.addEntity(makeHqEntity({
			"id": 6403, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Ship", "FishingBoat"]
		}, {
			"resourceGatherRates": () => ({ "food.fish": 1 }),
			"gather": (t: unknown) => gathered.push((t as { id(): number }).id())
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
		base.assignEntity(world.gameState, ent);
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), true);
		assert.deepEqual(gathered, [6402], "the fisher casts at the shoal");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6402);
		void fish;
	});

	it("a fisher over a shoal it cannot gather is idled for the turn", () =>
	{
		const { world, hq, base, worker } = seat();
		(hq.navalManager as unknown as { getFishSea: (g: unknown, e: unknown) => number }).getFishSea = () => 5;
		fishingGround(world, base, 5);
		// the fisher's nets do not suit this shoal's kind
		const ent = world.addEntity(makeHqEntity({
			"id": 6413, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Ship", "FishingBoat"]
		}, {
			"resourceGatherRates": () => ({ "food.meat": 1 })
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
		base.assignEntity(world.gameState, ent);
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), false);
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE, "the fisher lays down its nets");
	});
});

describe("a worker reading its book: findSupply edges and the food fields", () =>
{
	it("a tree felled since booking is dropped from the book", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6521, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		world.removeEntity(6521);   // the tree is felled before the turn
		const ent = hand(world, base, 6522, { "gather-type": "wood" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), false);
		assert.deepEqual(booked(base, "wood", "nearby"), [], "the felled tree is off the book");
		void tree;
	});

	it("a near-bare tree with hands already on it is passed over", () =>
	{
		const { world, base, worker } = seat();
		const bare = rawSupply(world, 6551, [30, 30], "wood", "tree",
			{ "resourceSupplyAmount": () => 10, "resourceSupplyNumGatherers": () => 2 });
		const full = rawSupply(world, 6552, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6553, { "gather-type": "wood" },
			{ "gather": (t: unknown) => gathered.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6552], "the crowded bare tree is skipped");
		void bare;
	});

	it("a woodcutter works the mid-range stand when the near one is bare", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6531, [130, 10], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6532, { "gather-type": "wood" },
			{ "gather": (t: unknown) => gathered.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6531], "the mid-range stand is the nearest wood");
		void tree;
	});

	it("a hungry hand gathers from the town's field when the wild berries are gone", () =>
	{
		const { world, base, worker } = seat();
		world.addEntity(makeHqEntity({
			"id": 6511, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Field"], "templateName": "structures/athen/field"
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.grain" : undefined,
			"resourceSupplyNumGatherers": () => 0, "resourceSupplyAmount": () => 1000,
			"getDiminishingReturns": () => 1, "maxGatherers": () => 8
		}, { "base": base.ID }));
		const gathered: number[] = [];
		const ent = hand(world, base, 6512, { "gather-type": "food" },
			{ "gather": (t: unknown) => gathered.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [6511], "the hand works the field");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6511);
	});

	it("a builder told to redo its task returns to its scaffold", () =>
	{
		const { world, base, worker } = seat();
		const rising = world.addEntity(makeHqEntity({
			"id": 6561, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "House"], "templateName": "foundation|structures/athen/house"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }));
		const repaired: number[] = [];
		const ent = hand(world, base, 6562, { "target-foundation": 6561 },
			{ "repair": (t: unknown) => repaired.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.retryWorking(world.gameState, Worker.SUBROLE_BUILDER), true);
		assert.deepEqual(repaired, [6561]);
		void rising;
	});
});

describe("a worker through its turn, continued: update", () =>
{
	it("a hand whose task was lost is put back to work", () =>
	{
		const { world, base, worker } = seat();
		const bush = rawSupply(world, 6571, [30, 30], "food", "fruit");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		// no subrole: as after a transport or a garrison stint
		const ent = hand(world, base, 6572, { "gather-type": undefined },
			{ "isIdle": () => true, "gather": (t: unknown) => gathered.push((t as { id(): number }).id()) });
		ent.setMetadata(PlayerID, "subrole", undefined);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6571], "the hand is sent back to the fields");
		void bush;
	});

	it("a gatherer carrying the wrong crop returns it before gathering anew", () =>
	{
		const { world, base, worker } = seat();
		bookCentreSupplies(world, base);
		const returned: number[] = [];
		const ent = hand(world, base, 6581, { "gather-type": "wood", "subrole": Worker.SUBROLE_GATHERER },
			{
				"isIdle": () => true,
				"resourceCarrying": () => [{ "type": "food", "amount": 10 }],
				"returnResources": (d: unknown) => returned.push((d as { id(): number }).id())
			});

		worker.update(world.gameState, ent);

		assert.deepEqual(returned, [1000], "the food is dropped at the centre");
	});
});

describe("a worker returning to its trade: retryWorking", () =>
{
	it("a gatherer asked to retry walks back to its crop", () =>
	{
		const { world, base, worker } = seat();
		const tree = rawSupply(world, 6611, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6612, { "gather-type": "wood" },
			{ "gather": (t: unknown) => gathered.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.retryWorking(world.gameState, Worker.SUBROLE_GATHERER), true);
		assert.deepEqual(gathered, [6611]);
		void tree;
	});

	it("a hunter asked to retry takes up the chase again", () =>
	{
		const { world, base, worker } = seat();
		const cow = world.addEntity(makeGaiaSupply({
			"id": 6621, "position": [40, 40], "generic": "food", "specific": "meat",
			"classes": ["Animal", "Domestic"]
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
		bookCentreSupplies(world, base);
		const ent = rider(world, base, 6622);
		prime(worker, ent);

		assert.equal(worker.retryWorking(world.gameState, Worker.SUBROLE_HUNTER), true);
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6621);
		void cow;
	});

	it("a fisher asked to retry casts again", () =>
	{
		const { world, hq, base, worker } = seat();
		(hq.navalManager as unknown as { getFishSea: (g: unknown, e: unknown) => number }).getFishSea = () => 5;
		(hq.navalManager as unknown as { canFishSafely: (g: unknown, e: unknown) => boolean }).canFishSafely = () => true;
		world.addEntity(makeHqEntity({
			"id": 6631, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, { "resourceDropsiteTypes": () => ["food"], "isResourceDropsite": (r?: string) => !r || r === "food" }, { "sea": 5 }));
		world.addEntity(makeGaiaSupply({
			"id": 6632, "position": [60, 60], "generic": "food", "specific": "fish", "classes": ["SeaCreature"]
		}, { "get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8 }));
		const ent = world.addEntity(makeHqEntity({
			"id": 6633, "owner": PLAYER, "position": [60, 60], "classes": ["Unit", "Ship", "FishingBoat"]
		}, { "resourceGatherRates": () => ({ "food.fish": 1 }) },
		{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
		base.assignEntity(world.gameState, ent);
		prime(worker, ent);

		assert.equal(worker.retryWorking(world.gameState, Worker.SUBROLE_FISHER), true);
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6632);
	});
});

describe("a worker and the far side of the water", () =>
{
	it("a woodcutter books a passage when the only wood is across the water", () =>
	{
		const { world, hq, base, worker } = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 },
			{ "landRegions": { 2: true, 3: true } });
		world.accessAt.set("240,240", 3);
		world.accessAt.set("230,230", 3);
		world.accessAt.set("235,235", 3);
		// an island town with its own stand of trees
		const island = secondTown(world, hq, 6641, [240, 240]);
		const store = storehouse(world, 6642, [230, 230]);
		const tree = rawSupply(world, 6643, [235, 235], "wood", "tree");
		island.assignEntity(world.gameState, store);
		(hq.navalManager as unknown as { requireTransport: () => boolean }).requireTransport = () => true;
		const ent = hand(world, base, 6644, { "gather-type": "wood" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID, "the woodcutter answers to the island town");
		void tree;
	});

	it("a hungry hand joins the raising of a field when no field stands yet", () =>
	{
		const { world, base, worker } = seat();
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Field"], "maxGatherers": 8 });
		const rising = world.addEntity(makeHqEntity({
			"id": 6651, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "Field"], "templateName": "foundation|structures/athen/field"
		}, { "foundationProgress": () => 0.3, "getBuildersNb": () => 0, "needsRepair": () => true }, { "base": base.ID }));
		const repaired: number[] = [];
		const ent = hand(world, base, 6652, { "gather-type": "food" },
			{ "repair": (t: unknown) => repaired.push((t as { id(): number }).id()) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(repaired, [6651], "the hand raises the field");
		// a gatherer only lends its back to the field; it stays a gatherer
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_GATHERER);
		void rising;
	});
});

const { TransportPlan } = await loadPetraModule<{ TransportPlan: { BOARDING: string } }>("transportPlan");

/** the naval office's answers a suite pokes on its door */
interface NavalDoor
{
	getPlan: (id: unknown) => unknown;
	requireTransport: (...args: unknown[]) => boolean;
	getFishSea: (g: unknown, e: unknown) => number;
	canFishSafely: (g: unknown, e: unknown) => boolean;
}

function naval(hq: HqInstance): NavalDoor
{
	return hq.navalManager as unknown as NavalDoor;
}

/** a boat at the quay, bound for the given land, recording who it puts ashore */
function boardingPlan(endIndex: number, removed: unknown[], onRemove: (ent: FakeEnt) => void = () => undefined)
{
	return {
		"state": TransportPlan.BOARDING,
		"endIndex": endIndex,
		"removeUnit": (_gs: unknown, ent: FakeEnt) =>
		{
			removed.push(ent.id());
			onRemove(ent);
		}
	};
}

/** the board split by water: land 2 to the west, land 3 east of x = 160 */
function islandSeat()
{
	const s = seat({ "landPassMap": (px: number) => px >= 80 ? 3 : 2 }, { "landRegions": { 2: true, 3: true } });
	s.world.accessAt.set("240,240", 3);
	return s;
}

const ids = (sink: number[]) => (t: unknown) => sink.push((t as { id(): number }).id());

describe("a worker waiting at the quay: update with a transport booked", () =>
{
	it("a builder whose foundation was razed steps off the boat before it sails", () =>
	{
		const { world, hq, base, worker } = seat();
		const removed: number[] = [];
		naval(hq).getPlan = () => boardingPlan(3, removed);
		const ent = hand(world, base, 6701,
			{ "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 9999, "transport": 42 });

		worker.update(world.gameState, ent);

		assert.deepEqual(removed, [6701], "the builder is taken off the passenger list");
	});

	it("a builder whose foundation still stands keeps its passage", () =>
	{
		const { world, hq, base, worker } = seat();
		world.addEntity(makeHqEntity({
			"id": 6711, "owner": PLAYER, "position": [240, 240],
			"classes": ["Structure", "House"], "templateName": "foundation|structures/athen/house"
		}, { "foundationProgress": () => 0.2, "needsRepair": () => true }));
		const removed: number[] = [];
		naval(hq).getPlan = () => boardingPlan(3, removed);
		const ent = hand(world, base, 6712,
			{ "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 6711, "transport": 42 });

		worker.update(world.gameState, ent);

		assert.deepEqual(removed, []);
		assert.equal(ent.getMetadata(PlayerID, "transport"), 42, "still waiting for the boat");
	});

	it("a woodcutter bound for a shore with a storehouse for its wood keeps its passage", () =>
	{
		const { world, hq, base, worker } = seat();
		world.addEntity(makeHqEntity({
			"id": 6721, "owner": PLAYER, "position": [240, 240],
			"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
		}, { "resourceDropsiteTypes": () => ["wood"] }, { "access": 3 }));
		const removed: number[] = [];
		naval(hq).getPlan = () => boardingPlan(3, removed);
		const ent = hand(world, base, 6722, { "gather-type": "wood", "transport": 42 });

		worker.update(world.gameState, ent);

		assert.deepEqual(removed, [], "the far shore has somewhere to drop the wood");
	});

	it("a woodcutter keeps its passage when a worker elephant of ours waits on the far shore", () =>
	{
		const { world, hq, base, worker } = seat();
		world.accessAt.set("240,240", 3);
		world.addEntity(makeHqEntity({
			"id": 6731, "owner": PLAYER, "position": [240, 240],
			"classes": ["Unit", "Support", "Elephant"]
		}, { "resourceDropsiteTypes": () => ["wood", "food"] }));
		const removed: number[] = [];
		naval(hq).getPlan = () => boardingPlan(3, removed);
		const ent = hand(world, base, 6732, { "gather-type": "wood", "transport": 42 });

		worker.update(world.gameState, ent);

		assert.deepEqual(removed, [], "the mobile dropsite takes the wood");
	});

	it("a hunter bound for a shore with nowhere to drop its meat stays home and works", () =>
	{
		const { world, hq, base, worker } = seat();
		const cow = world.addEntity(makeGaiaSupply({
			"id": 6741, "position": [40, 40], "generic": "food", "specific": "meat", "classes": ["Animal", "Domestic"]
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
		bookCentreSupplies(world, base);
		const removed: number[] = [];
		naval(hq).getPlan = () => boardingPlan(3, removed,
			(e: FakeEnt) => e.setMetadata(PlayerID, "transport", undefined));
		// a hunter carries no gather-type: the quay check reads it as food
		const ent = rider(world, base, 6742, { "transport": 42 });

		worker.update(world.gameState, ent);

		assert.deepEqual(removed, [6742], "the hunter steps off the boat");
		assert.equal(ent.getMetadata(PlayerID, "supply"), 6741, "and hunts the cattle at home that same turn");
		void cow;
	});

	// only the port passes: it guards the gatherer's plan lookup as the
	// reference already guards the builder's (the original reads .state off
	// the missing plan and throws). A resiliency guard: in a game the naval
	// manager clears "transport" (releaseAll) before it drops a plan, so no
	// worker should hold the id of a plan that is gone
	it("a gatherer whose boat is gone from the books keeps waiting rather than failing the turn", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getPlan = () => undefined;
		const ent = hand(world, base, 6751, { "gather-type": "wood", "transport": 42 });

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "transport"), 42);
	});
});

describe("a worker on the approach: update while walking to its crop", () =>
{
	it("a woodcutter whose tree vanished on the way picks another", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 6801, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6802, { "gather-type": "wood" }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.APPROACHING",
			"unitAIOrderData": () => [{ "target": 9999 }],
			"gather": ids(gathered)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6801]);
	});

	it("a woodcutter whose tree vanished and has no other stops where it is", () =>
	{
		const { world, base, worker } = seat();
		const stopped: number[] = [];
		const ent = hand(world, base, 6811, { "gather-type": "wood" }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.APPROACHING",
			"unitAIOrderData": () => [{ "target": 9999 }],
			"stopMoving": () => stopped.push(1)
		});

		worker.update(world.gameState, ent);

		assert.equal(stopped.length, 1, "the woodcutter halts");
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE);
	});

	/** a hunter chasing the given animal, as UnitAI sends it at a herd */
	function chaser(world: HqWorld, base: Base, id: number, target: number, sink: number[], stops: number[])
	{
		return rider(world, base, id, {}, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": target }],
			"gather": ids(sink),
			"stopMoving": () => stops.push(1)
		});
	}

	function cattle(world: HqWorld, id: number, position: [number, number])
	{
		return world.addEntity(makeGaiaSupply({
			"id": id, "position": position, "generic": "food", "specific": "meat", "classes": ["Animal", "Domestic"]
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
	}

	it("a hunter drawn into enemy ground turns to the herd at home", () =>
	{
		const { world, base, worker } = seat();
		cattle(world, 6821, [40, 40]);
		cattle(world, 6822, [70, 70]);
		bookCentreSupplies(world, base);
		world.map.setTerritoryOwner(5, 5, ENEMY);
		const gathered: number[] = [];
		const stops: number[] = [];
		const ent = chaser(world, base, 6823, 6821, gathered, stops);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6822], "the hunter takes the cattle on our own ground");
		assert.deepEqual(stops, []);
	});

	it("a hunter drawn into enemy ground with no herd left at home halts", () =>
	{
		const { world, base, worker } = seat();
		cattle(world, 6831, [40, 40]);
		bookCentreSupplies(world, base);
		world.map.setTerritoryOwner(5, 5, ENEMY);
		const gathered: number[] = [];
		const stops: number[] = [];
		const ent = chaser(world, base, 6832, 6831, gathered, stops);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, []);
		assert.equal(stops.length, 1, "the hunter halts at the border");
	});

	/** a neutral player owns the cell the herd grazes on */
	function neutralGround(world: HqWorld, ix: number, iy: number): void
	{
		(world.gameState.playerData as unknown as { isEnemy: boolean[] }).isEnemy[3] = false;
		world.map.setTerritoryOwner(ix, iy, 3);
	}

	it("a hunter chasing into neutral ground far from any of our dropsites halts", () =>
	{
		const { world, base, worker } = seat();
		// beyond a rider's 300 m reach of the town's centre
		cattle(world, 6841, [250, 250]);
		bookCentreSupplies(world, base);
		neutralGround(world, 31, 31);
		const gathered: number[] = [];
		const stops: number[] = [];
		const ent = chaser(world, base, 6842, 6841, gathered, stops);

		worker.update(world.gameState, ent);

		assert.equal(stops.length, 1, "the meat would be too far to carry home");
	});

	it("a hunter chasing into neutral ground beside one of our dropsites carries on", () =>
	{
		const { world, base, worker } = seat();
		cattle(world, 6851, [250, 250]);
		bookCentreSupplies(world, base);
		storehouse(world, 6852, [240, 240], ["food"]);
		neutralGround(world, 31, 31);
		const gathered: number[] = [];
		const stops: number[] = [];
		const ent = chaser(world, base, 6853, 6851, gathered, stops);

		worker.update(world.gameState, ent);

		assert.deepEqual(stops, []);
		assert.deepEqual(gathered, [], "the chase is left alone");
	});

	it("a hand that stopped approaching forgets the notes it kept on the way", () =>
	{
		const { world, base, worker } = seat();
		// a hunter the office sent walking to another town's grounds (update's hunter search)
		const ent = rider(world, base, 6861, { "approachingTarget": 77, "alreadyTried": 77 }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.WALKING"
		});

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "approachingTarget"), undefined);
		assert.equal(ent.getMetadata(PlayerID, "alreadyTried"), undefined);
	});
});

describe("a worker in a fight: update while UnitAI has it in combat", () =>
{
	/** an enemy archer shooting across the strait, to whom UnitAI makes the hand respond */
	function soldier(world: HqWorld, id: number, position: [number, number])
	{
		return world.addEntity(makeHqEntity({
			"id": id, "owner": ENEMY, "position": position, "classes": ["Unit", "Infantry", "Ranged"]
		}, { "resourceSupplyType": () => undefined }));
	}

	it("a fisher UnitAI sent after a whale goes back to the shoals", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 5;
		naval(hq).canFishSafely = () => true;
		world.addEntity(makeHqEntity({
			"id": 6901, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock"
		}, { "resourceDropsiteTypes": () => ["food"], "isResourceDropsite": (r?: string) => !r || r === "food" }, { "sea": 5 }));
		world.addEntity(makeGaiaSupply({
			"id": 6902, "position": [60, 60], "generic": "food", "specific": "fish", "classes": ["SeaCreature"]
		}, { "get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8 }));
		// the whale UnitAI's harpoon went after (the fishing boat's Attack is restricted to SeaCreature)
		world.addEntity(makeGaiaSupply({
			"id": 6904, "position": [90, 90], "generic": "food", "specific": "fish", "classes": ["SeaCreature", "Animal"]
		}, { "get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8 }));
		const gathered: number[] = [];
		const ent = world.addEntity(makeHqEntity({
			"id": 6903, "owner": PLAYER, "position": [60, 60], "classes": ["Unit", "Ship", "FishingBoat"]
		}, {
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 6904 }],
			"resourceGatherRates": () => ({ "food.fish": 1 }),
			"gather": ids(gathered)
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
		base.assignEntity(world.gameState, ent);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6902]);
	});

	it("a gatherer chasing a foe it cannot reach goes back to its crop", () =>
	{
		const { world, base, worker } = seat();
		world.accessAt.set("240,240", 3);
		soldier(world, 6911, [240, 240]);
		rawSupply(world, 6912, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 6913, { "gather-type": "wood" }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 6911 }],
			"gather": ids(gathered)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [6912]);
	});

	it("a builder chasing a foe it cannot reach goes back to its scaffold", () =>
	{
		const { world, base, worker } = seat();
		world.accessAt.set("240,240", 3);
		soldier(world, 6921, [240, 240]);
		world.addEntity(makeHqEntity({
			"id": 6922, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "House"], "templateName": "foundation|structures/athen/house"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }));
		const repaired: number[] = [];
		const ent = hand(world, base, 6923, { "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 6922 }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 6921 }],
			"repair": ids(repaired)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(repaired, [6922]);
	});

	it("an idle hand chasing a foe it cannot reach simply halts", () =>
	{
		const { world, base, worker } = seat();
		world.accessAt.set("240,240", 3);
		soldier(world, 6931, [240, 240]);
		const stops: number[] = [];
		const ent = hand(world, base, 6932, { "subrole": Worker.SUBROLE_IDLE }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 6931 }],
			"stopMoving": () => stops.push(1)
		});

		worker.update(world.gameState, ent);

		assert.equal(stops.length, 1);
	});

	it("a hand serving in a defense army is left to its army's orders", () =>
	{
		const { world, base, worker } = seat();
		world.accessAt.set("240,240", 3);
		soldier(world, 6941, [240, 240]);
		const stops: number[] = [];
		// as DefenseArmy.addOwn enlists a worker: plan -3, subrole defender
		const ent = hand(world, base, 6942, { "subrole": "defender", "PartOfArmy": 3, "plan": -3 }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 6941 }],
			"stopMoving": () => stops.push(1)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(stops, []);
	});

	it("a lone hand an enemy tower drew into a capture fight is told to fight it instead", () =>
	{
		const { world, base, worker } = seat();
		// a full-strength tower: regenerating, every capture point its owner's
		world.addEntity(makeHqEntity({
			"id": 6951, "owner": ENEMY, "position": [70, 70], "classes": ["Structure", "Tower"]
		}, {
			"isCapturable": () => true, "isInvulnerable": () => false, "decaying": () => false,
			"defaultRegenRate": () => 2, "isGarrisonHolder": () => false, "healthLevel": () => 1,
			"capturePoints": () => [0, 0, 2500], "hasDefensiveFire": () => true
		}));
		const attacks: unknown[] = [];
		const ent = hand(world, base, 6952, { "subrole": Worker.SUBROLE_GATHERER }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.ATTACKING",
			"unitAIOrderData": () => [{ "target": 6951, "attackType": "Capture" }],
			"canCapture": () => true, "captureStrength": () => 2.5, "get": () => undefined,
			"attack": (id: number, capture: boolean) => attacks.push([id, capture])
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(attacks, [[6951, false]], "one hand cannot take the tower: it fights it");
	});

	it("a capture fight against gaia's building is left to UnitAI", () =>
	{
		const { world, base, worker } = seat();
		world.addEntity(makeHqEntity({ "id": 6961, "owner": 0, "position": [70, 70], "classes": ["Structure"] }));
		const attacks: unknown[] = [];
		const ent = hand(world, base, 6962, { "subrole": Worker.SUBROLE_GATHERER }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.ATTACKING",
			"unitAIOrderData": () => [{ "target": 6961, "attackType": "Capture" }],
			"attack": (id: number, capture: boolean) => attacks.push([id, capture])
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(attacks, []);
	});
});

describe("a gatherer at work: update checks what UnitAI chose", () =>
{
	/** a gatherer UnitAI has at the given supply, with the town's note of another */
	function atWork(world: HqWorld, base: Base, id: number, target: number, noted: number | undefined,
		gatherType: string, sink: number[], state = "INDIVIDUAL.GATHER.GATHERING", extra: Record<string, unknown> = {})
	{
		return hand(world, base, id, { "gather-type": gatherType, "supply": noted }, {
			"isIdle": () => false,
			"unitAIState": () => state,
			"unitAIOrderData": () => [{ "target": target }],
			"gather": ids(sink),
			...extra
		});
	}

	it("a hand UnitAI moved to a crowded, near-bare tree is sent elsewhere", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7001, [30, 30], "wood", "tree",
			{ "resourceSupplyAmount": () => 50, "resourceSupplyNumGatherers": () => 2 });
		rawSupply(world, 7002, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = atWork(world, base, 7003, 7001, 7002, "wood", gathered);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [7002]);
	});

	it("a hand UnitAI moved to another booked tree nearby keeps it", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7011, [30, 30], "wood", "tree");
		rawSupply(world, 7012, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = atWork(world, base, 7013, 7011, 7012, "wood", gathered);

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "supply"), 7011, "the town's note follows UnitAI's choice");
		assert.deepEqual(gathered, []);
	});

	it("a hand UnitAI moved to a far tree while near ones stand is sent back", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7021, [260, 10], "wood", "tree");
		rawSupply(world, 7022, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		// the note names the far tree the hand felled before UnitAI moved it to the next one
		const ent = atWork(world, base, 7023, 7021, 7020, "wood", gathered);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [7022]);
	});

	it("a hand UnitAI moved to a far tree while mid-range ones stand is sent back", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7031, [260, 10], "wood", "tree");
		rawSupply(world, 7032, [130, 10], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = atWork(world, base, 7033, 7031, 7030, "wood", gathered);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [7032]);
	});

	it("a hand UnitAI moved to a mid-range tree when none stands near keeps it", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7041, [130, 10], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = atWork(world, base, 7042, 7041, 7040, "wood", gathered);

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "supply"), 7041);
		assert.deepEqual(gathered, []);
	});

	// while a gatherer carries its load home, UnitAI's order targets the
	// dropsite (UnitAI.js, GATHER.RETURNINGRESOURCE), which has no ResourceSupply
	it("a woodcutter carrying its load to a dropsite across the water is sent to one it can reach", () =>
	{
		const { world, base, worker } = seat();
		bookCentreSupplies(world, base);
		// a dropsite holds no supply: the common-api answers undefined (entity.js)
		world.addEntity(makeHqEntity({
			"id": 7051, "owner": PLAYER, "position": [170, 170],
			"classes": ["Structure", "Storehouse"], "templateName": "structures/athen/storehouse"
		}, {
			"resourceDropsiteTypes": () => ["wood"],
			"isResourceDropsite": (r?: string) => !r || r === "wood",
			"resourceSupplyType": () => undefined,
			"resourceSupplyNumGatherers": () => undefined,
			"resourceSupplyAmount": () => undefined
		}, { "access": 3 }));
		const returned: number[] = [];
		const gathered: number[] = [];
		rawSupply(world, 7053, [150, 140], "wood", "tree");
		// the hand cut its tree by the strait; UnitAI picked the dropsite nearest
		// in a straight line (UnitAI.FindNearestDropsite), the one across the water
		const ent = atWork(world, base, 7052, 7051, 7053, "wood", gathered,
			"INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING", {
				"resourceCarrying": () => [{ "type": "wood", "amount": 10 }],
				"returnResources": ids(returned)
			});
		(ent as unknown as { position: () => [number, number] }).position = () => [150, 150];

		worker.update(world.gameState, ent);

		assert.deepEqual(returned, [1000], "the load goes to the town's centre");
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_GATHERER);
	});

	it("a stone-cutter whose note points past a nearer booked mine has the note wiped", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7061, [30, 30], "stone", "rock");
		rawSupply(world, 7063, [260, 10], "stone", "rock");
		bookCentreSupplies(world, base);
		(world.gameState.ai as unknown as { playedTurn: number }).playedTurn = 1;
		// the note names the far mine the hand was sent to while the near one was full
		const gathered: number[] = [];
		const ent = atWork(world, base, 7062, 1000, 7063, "stone", gathered,
			"INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING");

		worker.update(world.gameState, ent);

		assert.notEqual(ent.getMetadata(PlayerID, "supply"), 7063, "the next trip goes to the nearer mine");
	});

	it("a stone-cutter whose note points past a mid-range booked mine has the note wiped", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7071, [130, 10], "stone", "rock");
		rawSupply(world, 7073, [260, 10], "stone", "rock");
		bookCentreSupplies(world, base);
		(world.gameState.ai as unknown as { playedTurn: number }).playedTurn = 1;
		const gathered: number[] = [];
		const ent = atWork(world, base, 7072, 1000, 7073, "stone", gathered,
			"INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING");

		worker.update(world.gameState, ent);

		assert.notEqual(ent.getMetadata(PlayerID, "supply"), 7073, "the next trip goes to the mid-range mine");
	});

	// only the port passes: it leaves the order alone while UnitAI targets a
	// dropsite. The original takes the dropsite for a supply the town has not
	// booked and searches the town again; with every booked tree crowded the
	// search fails, and a woodcutter merely walking its load home is idled and
	// wood marked as failed for the whole town
	it("a woodcutter carrying its load home while every booked tree is crowded keeps its trade", () =>
	{
		const { world, hq, base, worker } = seat();
		rawSupply(world, 7081, [30, 30], "wood", "tree",
			{ "resourceSupplyNumGatherers": () => 8, "maxGatherers": () => 8 });
		bookCentreSupplies(world, base);
		(world.gameState.ai as unknown as { playedTurn: number }).playedTurn = 1;
		const gathered: number[] = [];
		const ent = atWork(world, base, 7082, 1000, 7081, "wood", gathered,
			"INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING",
			{ "resourceCarrying": () => [{ "type": "wood", "amount": 10 }] });

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [], "the hand walks on to the centre with its load");
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_GATHERER, "still a woodcutter");
		assert.equal((hq as unknown as { lastFailedGather: Record<string, number> }).lastFailedGather.wood, undefined,
			"wood is not marked as failed");
	});
});

describe("a worker seeking its crop in other towns and over the water: startGathering", () =>
{
	/** a built field of the given town */
	function field(world: HqWorld, id: number, position: [number, number], baseID: number, access?: number)
	{
		return world.addEntity(makeHqEntity({
			"id": id, "owner": PLAYER, "position": position,
			"classes": ["Structure", "Field"], "templateName": "structures/athen/field"
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.grain" : undefined,
			"resourceSupplyNumGatherers": () => 0, "resourceSupplyAmount": () => 1000,
			"getDiminishingReturns": () => 1, "maxGatherers": () => 8
		}, access === undefined ? { "base": baseID } : { "base": baseID, "access": access }));
	}

	/** a field-foundation of the given town */
	function fieldFoundation(world: HqWorld, id: number, position: [number, number], baseID: number, access?: number)
	{
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Field"], "maxGatherers": 8 });
		return world.addEntity(makeHqEntity({
			"id": id, "owner": PLAYER, "position": position,
			"classes": ["Structure", "Field"], "templateName": "foundation|structures/athen/field"
		}, { "foundationProgress": () => 0.3, "getBuildersNb": () => 0, "needsRepair": () => true },
		access === undefined ? { "base": baseID } : { "base": baseID, "access": access }));
	}

	it("a hungry hand works the colony's field when its own town has none", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 7101, [240, 240]);
		field(world, 7102, [230, 230], colony.ID);
		const gathered: number[] = [];
		const ent = hand(world, base, 7103, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [7102]);
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID);
	});

	it("a hungry hand raises the colony's field when no field stands anywhere", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 7111, [240, 240]);
		fieldFoundation(world, 7112, [230, 230], colony.ID);
		const repaired: number[] = [];
		const ent = hand(world, base, 7113, { "gather-type": "food" }, { "repair": ids(repaired) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(repaired, [7112]);
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID);
	});

	it("a woodcutter works the colony's mid-range stand when nothing is nearer", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 7121, [240, 240]);
		rawSupply(world, 7122, [230, 110], "wood", "tree");
		colony.assignEntity(world.gameState, storehouse(world, 7123, [230, 230]));
		const gathered: number[] = [];
		const ent = hand(world, base, 7124, { "gather-type": "wood" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.deepEqual(booked(colony, "wood", "medium"), [7122], "the stand is mid-range for the colony");
		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [7122]);
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID);
	});

	it("a woodcutter works the colony's far stand when nothing is nearer", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 7131, [240, 240]);
		rawSupply(world, 7132, [10, 300], "wood", "tree");
		colony.assignEntity(world.gameState, storehouse(world, 7133, [230, 230]));
		const gathered: number[] = [];
		const ent = hand(world, base, 7134, { "gather-type": "wood" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.deepEqual(booked(colony, "wood", "faraway"), [7132], "the stand is far for the colony");
		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [7132]);
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID);
	});

	it("a woodcutter will not raise a building that takes no wood", () =>
	{
		const { world, base, worker } = seat();
		world.templates["structures/athen/farmstead"] = structureTemplate("structures/athen/farmstead",
			{ "classes": ["Structure", "Farmstead"], "dropsiteTypes": ["food"] });
		world.addEntity(makeHqEntity({
			"id": 7141, "owner": PLAYER, "position": [40, 40],
			"classes": ["Structure", "Farmstead"], "templateName": "foundation|structures/athen/farmstead"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }, { "base": base.ID }));
		const repaired: number[] = [];
		const ent = hand(world, base, 7142, { "gather-type": "wood" }, { "repair": ids(repaired) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), false);
		assert.deepEqual(repaired, []);
	});

	it("a hungry hand on a map without fields or corrals may roam to the far berries", () =>
	{
		const { world, base, worker } = seat({ "disabledTemplates": ["structures/athen/field", "structures/athen/corral"] });
		world.templates["structures/athen/field"] = structureTemplate("structures/athen/field",
			{ "classes": ["Structure", "Field"], "maxGatherers": 8 });
		rawSupply(world, 7151, [260, 10], "food", "fruit");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 7152, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [7151], "no field can be built, so the far bush is worth the walk");
	});

	it("a hungry hand whose town can farm leaves the far berries alone", () =>
	{
		const { world, hq, base, worker } = seat();
		rawSupply(world, 7161, [260, 10], "food", "fruit");
		bookCentreSupplies(world, base);
		(hq as unknown as { turnCache: Record<string, unknown> }).turnCache.allowDistantFood = false;
		const gathered: number[] = [];
		const ent = hand(world, base, 7162, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), false);
		assert.deepEqual(gathered, []);
	});

	it("a hungry hand books a passage to the island's field", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7171, [240, 240]);
		field(world, 7172, [230, 230], island.ID, 3);
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7173, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(passages, [3]);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID);
	});

	it("a hungry hand books a passage to raise the island's field", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7181, [240, 240]);
		fieldFoundation(world, 7182, [230, 230], island.ID, 3);
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7183, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(passages, [3]);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID);
	});

	it("a woodcutter books a passage to the island's mid-range stand", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7191, [240, 240]);
		world.accessAt.set("230,230", 3);
		world.accessAt.set("230,110", 3);
		rawSupply(world, 7192, [230, 110], "wood", "tree");
		island.assignEntity(world.gameState, storehouse(world, 7193, [230, 230]));
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7194, { "gather-type": "wood" });
		prime(worker, ent);

		assert.deepEqual(booked(island, "wood", "medium"), [7192]);
		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(passages, [3]);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID);
	});

	it("a woodcutter books a passage to the island's far stand", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7201, [240, 240]);
		world.accessAt.set("230,230", 3);
		world.accessAt.set("300,10", 3);
		rawSupply(world, 7202, [300, 10], "wood", "tree");
		island.assignEntity(world.gameState, storehouse(world, 7203, [230, 230]));
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7204, { "gather-type": "wood" });
		prime(worker, ent);

		assert.deepEqual(booked(island, "wood", "faraway"), [7202]);
		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(passages, [3]);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID);
	});

	it("a woodcutter books a passage to raise a storehouse on the island", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7210, [240, 240]);
		world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse",
			{ "classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood"] });
		world.addEntity(makeHqEntity({
			"id": 7211, "owner": PLAYER, "position": [230, 230],
			"classes": ["Structure", "Storehouse"], "templateName": "foundation|structures/athen/storehouse"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }, { "base": island.ID, "access": 3 }));
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7212, { "gather-type": "wood" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(passages, [3]);
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER);
		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), 7211);
		assert.equal(ent.getMetadata(PlayerID, "base"), island.ID, "the hand answers to the foundation's town");
	});

	it("a woodcutter books no passage to raise an island building that takes no wood", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		const island = secondTown(world, hq, 7220, [240, 240]);
		world.templates["structures/athen/farmstead"] = structureTemplate("structures/athen/farmstead",
			{ "classes": ["Structure", "Farmstead"], "dropsiteTypes": ["food"] });
		world.addEntity(makeHqEntity({
			"id": 7221, "owner": PLAYER, "position": [230, 230],
			"classes": ["Structure", "Farmstead"], "templateName": "foundation|structures/athen/farmstead"
		}, { "foundationProgress": () => 0.3, "needsRepair": () => true }, { "base": island.ID, "access": 3 }));
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = hand(world, base, 7222, { "gather-type": "wood" });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), false);
		assert.deepEqual(passages, []);
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE);
	});
});

describe("a worker's smaller judgements", () =>
{
	it("an idle hand has no trade to return to", () =>
	{
		const { world, base, worker } = seat();
		const ent = hand(world, base, 7301, { "subrole": Worker.SUBROLE_IDLE });
		prime(worker, ent);

		assert.equal(worker.retryWorking(world.gameState, Worker.SUBROLE_IDLE), false);
	});

	it("a hungry hand leaves cattle grazing too far from any dropsite of ours", () =>
	{
		const { world, base, worker } = seat();
		world.addEntity(makeGaiaSupply({
			"id": 7311, "position": [200, 200], "generic": "food", "specific": "meat", "classes": ["Animal", "Domestic"]
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.meat" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8
		}));
		bookCentreSupplies(world, base);
		const ent = hand(world, base, 7312, { "gather-type": "food" }, {}, [180, 180]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false, "the meat would spoil on the way home");
	});

	it("a fisher whose sea holds no more shoals is scuttled, and only its sea's fleet is told", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 6;
		world.addEntity(makeGaiaSupply({
			"id": 7321, "position": [60, 60], "generic": "food", "specific": "fish", "classes": ["SeaCreature"]
		}, { "get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
			"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8 }));
		const scuttled: number[] = [];
		const ent = world.addEntity(makeHqEntity({
			"id": 7322, "owner": PLAYER, "position": [60, 60], "classes": ["Unit", "Ship", "FishingBoat"]
		}, { "resourceGatherRates": () => ({ "food.fish": 1 }), "destroy": () => scuttled.push(1) },
		{ "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
		base.assignEntity(world.gameState, ent);
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), false);
		assert.equal(scuttled.length, 1);
		const resets = (hq.navalManagerCalls as Array<[string, unknown[]]>).filter(([m]) => m === "resetFishingBoats");
		assert.deepEqual(resets.map(([, args]) => args[1]), [5], "the fleet of sea 5 is told");
	});

	it("a hungry hand leaves a thinned field when a new one waits to be raised", () =>
	{
		const { world, base, worker } = seat();
		world.addEntity(makeHqEntity({
			"id": 7331, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Field"], "templateName": "structures/athen/field"
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.grain" : undefined,
			"resourceSupplyNumGatherers": () => 2, "resourceSupplyAmount": () => 1000,
			"getDiminishingReturns": () => 0.5, "maxGatherers": () => 8
		}, { "base": base.ID }));
		world.addEntity(makeHqEntity({
			"id": 7332, "owner": PLAYER, "position": [44, 44],
			"classes": ["Structure", "Field"], "templateName": "foundation|structures/athen/field"
		}, { "foundationProgress": () => 0.3 }, { "base": base.ID }));
		const ent = hand(world, base, 7333, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal(worker.gatherNearestField(world.gameState, base.ID), false);
	});

	it("a dropsite-bearer does not follow gatherers who are idle or waiting for a boat", () =>
	{
		const { world, base, worker } = seat();
		hand(world, base, 7341, { "gather-type": "wood" }, { "isIdle": () => true }, [50, 50]);
		hand(world, base, 7342, { "gather-type": "wood", "transport": 4 }, { "isIdle": () => false }, [70, 70]);
		const moved: number[] = [];
		const bearer = world.addEntity(makeHqEntity({
			"id": 7343, "owner": PLAYER, "position": [20, 20], "classes": ["Unit", "Support", "Elephant"]
		}, { "resourceDropsiteTypes": () => ["wood"], "move": (x: number) => moved.push(x) }));

		worker.moveToGatherer(world.gameState, bearer, true);

		assert.deepEqual(moved, []);
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		assert.equal(bearer.getMetadata(PlayerID, "nextMoveToGatherer"), gs.ai.elapsedTime + 5, "it looks again soon");
	});

	it("a hand only a moment into its approach is not yet judged stuck", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7351, [30, 30], "wood", "tree");
		const ent = hand(world, base, 7352, {}, { "unitAIOrderData": () => [{ "target": 7351 }] });
		prime(worker, ent);
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };

		assert.equal(worker.isInaccessibleSupply(world.gameState), false);
		const since = ent.getMetadata(PlayerID, "approachingTime");
		gs.ai.elapsedTime += 2;
		assert.equal(worker.isInaccessibleSupply(world.gameState), false);
		assert.equal(ent.getMetadata(PlayerID, "approachingTime"), since, "the clock is not restarted");
	});
});

/** cattle on the map (gaia's unless another owner is given) */
function herd(world: HqWorld, id: number, position: [number, number], methods: Record<string, unknown> = {},
	classes: string[] = ["Animal", "Domestic"])
{
	return world.addEntity(makeGaiaSupply({ id, position, "generic": "food", "specific": "meat", classes }, {
		"get": (p: string) => p === "ResourceSupply/Type" ? "food.meat" : undefined,
		"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8,
		...methods
	}));
}

/** a shoal of fish on the sea the fishers sail */
function shoal(world: HqWorld, id: number, position: [number, number], methods: Record<string, unknown> = {},
	amount?: number)
{
	return world.addEntity(makeGaiaSupply({ id, position, "generic": "food", "specific": "fish",
		"classes": ["SeaCreature"], amount }, {
		"get": (p: string) => p === "ResourceSupply/Type" ? "food.fish" : undefined,
		"resourceSupplyNumGatherers": () => 0, "maxGatherers": () => 8,
		...methods
	}));
}

/** a dock on the given sea, ours unless another owner is given */
function dock(world: HqWorld, id: number, position: [number, number], sea: number, owner = PLAYER,
	methods: Record<string, unknown> = {})
{
	return world.addEntity(makeHqEntity({ id, owner, position,
		"classes": ["Structure", "Dock"], "templateName": "structures/athen/dock" }, {
		"resourceDropsiteTypes": () => ["food"],
		"isResourceDropsite": (r?: string) => !r || r === "food",
		...methods
	}, { "sea": sea }));
}

/** a fishing boat of the town, on sea 5 */
function boat(world: HqWorld, host: Base, id: number, methods: Record<string, unknown> = {},
	position: [number, number] = [60, 60])
{
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position,
		"classes": ["Unit", "Ship", "FishingBoat"] }, {
		"resourceGatherRates": () => ({ "food.fish": 1 }),
		...methods
	}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_FISHER, "sea": 5 }));
	host.assignEntity(world.gameState, ent);
	return ent;
}

/** the diplomacy rows an ally of ours carries */
function ally(world: HqWorld, player: number): void
{
	const pd = world.gameState.playerData as unknown as { isAlly: boolean[]; isMutualAlly: boolean[]; isEnemy: boolean[] };
	pd.isAlly[player] = true;
	pd.isMutualAlly[player] = true;
	pd.isEnemy[player] = false;
}

/**
 * Turn the shared dropsites on (Diplomacy.HasSharedDropsites), with the
 * gameState question it unlocks: GameState.getAnyDropsites reads every
 * player's dropsites accepting the resource.
 */
function shareDropsites(world: HqWorld): void
{
	(world.gameState.playerData as unknown as { hasSharedDropsites: boolean }).hasSharedDropsites = true;
	const gs = world.gameState as unknown as {
		getEntities(): { filter(f: (e: FakeEnt) => boolean): unknown };
		getAnyDropsites?: (resource: string) => unknown;
	};
	gs.getAnyDropsites = (resource: string) =>
		gs.getEntities().filter((e: FakeEnt) => e.isResourceDropsite?.(resource) ?? false);
}

/** a foundation of ours, a house unless told otherwise */
function scaffold(world: HqWorld, id: number, position: [number, number], metadata: Record<string, unknown> = {},
	classes: string[] = ["Structure", "House"], templateName = "foundation|structures/athen/house")
{
	return world.addEntity(makeHqEntity({ id, "owner": PLAYER, position, classes, templateName },
		{ "foundationProgress": () => 0.3, "needsRepair": () => true }, metadata));
}

describe("a builder through its turn: update", () =>
{
	/** a builder of the town on its foundation, in the given UnitAI state */
	function builder(world: HqWorld, base: Base, id: number, foundation: number, state: string,
		orderTarget?: number, methods: Record<string, unknown> = {})
	{
		return hand(world, base, id, { "subrole": Worker.SUBROLE_BUILDER, "target-foundation": foundation }, {
			"isIdle": () => state === "INDIVIDUAL.IDLE",
			"unitAIState": () => state,
			"unitAIOrderData": () => orderTarget === undefined ? [] : [{ "target": orderTarget }],
			...methods
		});
	}

	it("a builder UnitAI carried on to the next house follows it there", () =>
	{
		const { world, base, worker } = seat();
		scaffold(world, 7401, [40, 40]);
		scaffold(world, 7402, [48, 40]);
		// a house's crew keeps on to the foundations nearby (repair with autocontinue)
		const ent = builder(world, base, 7403, 7401, "INDIVIDUAL.REPAIR.REPAIRING", 7402);

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), 7402);
		assert.equal(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER);
	});

	it("a builder UnitAI carried on to a field leaves it and is put to other work", () =>
	{
		const { world, base, worker } = seat();
		scaffold(world, 7411, [40, 40]);
		scaffold(world, 7412, [48, 40], { "base": base.ID }, ["Structure", "Field"], "foundation|structures/athen/field");
		const stops: number[] = [];
		const ent = builder(world, base, 7413, 7411, "INDIVIDUAL.REPAIR.REPAIRING", 7412,
			{ "stopMoving": () => stops.push(1) });

		worker.update(world.gameState, ent);

		assert.ok(stops.length >= 1, "the builder stops at the field");
		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), undefined);
		assert.notEqual(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER, "fields are raised only when needed");
	});

	it("a builder whose foundation was razed on the way is put to other work", () =>
	{
		const { world, base, worker } = seat();
		const stops: number[] = [];
		// the foundation 7421 is gone; UnitAI still walks to it
		const ent = builder(world, base, 7422, 7421, "INDIVIDUAL.REPAIR.APPROACHING", 7421,
			{ "stopMoving": () => stops.push(1) });

		worker.update(world.gameState, ent);

		assert.ok(stops.length >= 1);
		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), undefined);
		assert.notEqual(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER);
	});

	it("a builder whose building stands finished is put to other work", () =>
	{
		const { world, base, worker } = seat();
		storehouse(world, 7431, [40, 40]);
		const ent = builder(world, base, 7432, 7431, "INDIVIDUAL.IDLE");

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "target-foundation"), undefined);
		assert.notEqual(ent.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_BUILDER);
	});

	it("a worker elephant done building steps aside to the nearest gatherer", () =>
	{
		const { world, base, worker } = seat();
		storehouse(world, 7441, [40, 40]);
		hand(world, base, 7442, { "gather-type": "wood" }, { "isIdle": () => false }, [50, 50]);
		const moved: Array<[number, number]> = [];
		// the worker elephant: Support, Builder, Elephant, a dropsite for every resource
		const elephant = world.addEntity(makeHqEntity({
			"id": 7443, "owner": PLAYER, "position": [20, 20], "classes": ["Unit", "Support", "Builder", "Elephant"]
		}, {
			"isIdle": () => true, "unitAIState": () => "INDIVIDUAL.IDLE",
			"resourceDropsiteTypes": () => ["food", "wood", "stone", "metal"],
			"move": (x: number, z: number) => moved.push([x, z])
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_BUILDER, "target-foundation": 7441 }));
		base.assignEntity(world.gameState, elephant);

		worker.update(world.gameState, elephant);

		assert.deepEqual(moved, [[50, 50]], "the elephant joins the woodcutter, out of the builders' way");
		assert.equal(elephant.getMetadata(PlayerID, "subrole"), Worker.SUBROLE_IDLE);
	});

	it("an idle builder goes back to its standing foundation", () =>
	{
		const { world, base, worker } = seat();
		const rising = scaffold(world, 7451, [40, 40]);
		const repaired: unknown[] = [];
		const ent = builder(world, base, 7452, 7451, "INDIVIDUAL.IDLE", undefined,
			{ "repair": (t: unknown, auto: boolean, queued: boolean) => repaired.push([t, auto, queued]) });

		worker.update(world.gameState, ent);

		assert.deepEqual(repaired, [[rising, true, false]], "a house: the builder stays on to the next one");
	});

	it("an idle builder carrying wood drops it at the centre before going back to build", () =>
	{
		const { world, base, worker } = seat();
		bookCentreSupplies(world, base);
		scaffold(world, 7461, [40, 40]);
		const returned: number[] = [];
		const repaired: unknown[] = [];
		const ent = builder(world, base, 7462, 7461, "INDIVIDUAL.IDLE", undefined, {
			"resourceCarrying": () => [{ "type": "wood", "amount": 10 }],
			"returnResources": ids(returned),
			"repair": (t: unknown, auto: boolean, queued: boolean) => repaired.push([(t as FakeEnt).id(), queued])
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(returned, [1000]);
		assert.deepEqual(repaired, [[7461, true]], "the building is queued after the drop");
	});

	it("an idle builder whose foundation is across the water books a passage", () =>
	{
		const { world, hq, base, worker } = islandSeat();
		scaffold(world, 7471, [240, 240], { "access": 3 });
		const passages: unknown[] = [];
		naval(hq).requireTransport = (...args: unknown[]) => passages.push(args[3]) > 0;
		const ent = builder(world, base, 7472, 7471, "INDIVIDUAL.IDLE");

		worker.update(world.gameState, ent);

		assert.deepEqual(passages, [3]);
	});
});

describe("a hunter and a fisher through their turn: update", () =>
{
	it("a rider with nothing to hunt anywhere notes the search and waits", () =>
	{
		const { world, base, worker } = seat();
		const ent = rider(world, base, 7501);
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };

		worker.update(world.gameState, ent);

		assert.equal(ent.getMetadata(PlayerID, "lastHuntSearch"), gs.ai.elapsedTime);
	});

	it("a rider that searched in vain moments ago does not search again yet", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7511, [40, 40]);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		const ent = rider(world, base, 7512, { "lastHuntSearch": gs.ai.elapsedTime - 5 }, { "gather": ids(gathered) });

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [], "the next search waits 20 s");
	});

	it("a rider that drifted into enemy ground while hunting turns to a herd at home", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7521, [100, 60]);
		herd(world, 7522, [30, 30]);
		bookCentreSupplies(world, base);
		// the rider and its carcass stand on the enemy's ground
		world.map.setTerritoryOwner(12, 7, ENEMY);
		const gathered: number[] = [];
		const ent = rider(world, base, 7523, {}, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.GATHERING",
			"unitAIOrderData": () => [{ "target": 7521 }],
			"gather": ids(gathered)
		}, [100, 60]);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [7522]);
	});

	it("a rider carrying meat to a dropsite across the water is sent to one it can reach", () =>
	{
		const { world, base, worker } = seat();
		bookCentreSupplies(world, base);
		storehouse(world, 7531, [170, 170], ["food"]).setMetadata(PlayerID, "access", 3);
		const returned: number[] = [];
		const ent = rider(world, base, 7532, {}, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING",
			"unitAIOrderData": () => [{ "target": 7531 }],
			"resourceCarrying": () => [{ "type": "food", "amount": 20 }],
			"returnResources": ids(returned)
		}, [150, 150]);

		worker.update(world.gameState, ent);

		assert.deepEqual(returned, [1000]);
	});

	it("a fishing boat that drifted into enemy waters goes back to a safe shoal", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 5;
		naval(hq).canFishSafely = () => true;
		dock(world, 7541, [30, 30], 5);
		shoal(world, 7542, [40, 60]);
		world.map.setTerritoryOwner(12, 12, ENEMY);
		const gathered: number[] = [];
		const ent = boat(world, base, 7543, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.GATHERING",
			"unitAIOrderData": () => [{ "target": 7542 }],
			"gather": ids(gathered)
		}, [100, 100]);

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [7542]);
	});
});

describe("what a worker takes up first: treasure and the hunt", () =>
{
	/** a treasure on the map, with the office's list refreshed as its updates keep it */
	function treasure(world: HqWorld, hq: HqInstance, id: number, position: [number, number])
	{
		world.addEntity(makeHqEntity({ id, "owner": 0, position, "classes": ["Treasure"] }, { "isTreasure": () => true }));
		// Headquarters.init filters the world's entities by isTreasure, and the
		// collection's updates add the ones found later
		hq.treasures = (world.gameState as unknown as { getEntities(): { filter(f: (e: FakeEnt) => boolean): unknown } })
			.getEntities().filter((e: FakeEnt) => (e as unknown as { isTreasure(): boolean }).isTreasure());
	}

	it("a woodcutter picks up a treasure near it before going back to the trees", () =>
	{
		const { world, hq, base, worker } = seat();
		rawSupply(world, 7601, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		treasure(world, hq, 7602, [70, 70]);
		const collected: number[] = [];
		const gathered: number[] = [];
		const ent = hand(world, base, 7603, { "gather-type": "wood" }, {
			"isTreasureCollector": () => true, "collectTreasure": ids(collected), "gather": ids(gathered)
		});
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(collected, [7602]);
		assert.deepEqual(gathered, []);
	});

	it("an idle rider picks up a treasure before the hunt", () =>
	{
		const { world, hq, base, worker } = seat();
		herd(world, 7611, [40, 40]);
		bookCentreSupplies(world, base);
		treasure(world, hq, 7612, [70, 70]);
		const collected: number[] = [];
		const gathered: number[] = [];
		const ent = rider(world, base, 7613, {}, {
			"isTreasureCollector": () => true, "collectTreasure": ids(collected), "gather": ids(gathered)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(collected, [7612]);
		assert.deepEqual(gathered, []);
	});

	it("a hungry hand hunts the cattle before working the field", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7621, [40, 40]);
		bookCentreSupplies(world, base);
		world.addEntity(makeHqEntity({
			"id": 7622, "owner": PLAYER, "position": [30, 30],
			"classes": ["Structure", "Field"], "templateName": "structures/athen/field"
		}, {
			"get": (p: string) => p === "ResourceSupply/Type" ? "food.grain" : undefined,
			"resourceSupplyNumGatherers": () => 0, "resourceSupplyAmount": () => 1000,
			"getDiminishingReturns": () => 1, "maxGatherers": () => 8
		}, { "base": base.ID }));
		const gathered: number[] = [];
		const ent = hand(world, base, 7623, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(gathered, [7621]);
	});
});

describe("which crop a worker passes over: startGathering and startHunting", () =>
{
	it("a woodcutter passes over a tree marked unreachable", () =>
	{
		const { world, base, worker } = seat();
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		rawSupply(world, 7701, [30, 30], "wood", "tree", {}).setMetadata(PlayerID, "inaccessibleTime", gs.ai.elapsedTime + 300);
		rawSupply(world, 7702, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 7703, { "gather-type": "wood" }, { "gather": ids(gathered) });
		prime(worker, ent);

		worker.startGathering(world.gameState);

		assert.deepEqual(gathered, [7702]);
	});

	it("a woodcutter passes over a tree with all the hands it can take", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7705, [30, 30], "wood", "tree", { "resourceSupplyNumGatherers": () => 8 });
		rawSupply(world, 7706, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 7707, { "gather-type": "wood" }, { "gather": ids(gathered) });
		prime(worker, ent);

		worker.startGathering(world.gameState);

		assert.deepEqual(gathered, [7706]);
	});

	it("a woodcutter passes over a tree on the enemy's ground", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7711, [40, 10], "wood", "tree");
		rawSupply(world, 7712, [10, 45], "wood", "tree");
		bookCentreSupplies(world, base);
		world.map.setTerritoryOwner(5, 1, ENEMY);
		const gathered: number[] = [];
		const ent = hand(world, base, 7713, { "gather-type": "wood" }, { "gather": ids(gathered) });
		prime(worker, ent);

		worker.startGathering(world.gameState);

		assert.deepEqual(gathered, [7712]);
	});

	it("a hungry hand passes over cattle marked unreachable", () =>
	{
		const { world, base, worker } = seat();
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		herd(world, 7721, [40, 40]).setMetadata(PlayerID, "inaccessibleTime", gs.ai.elapsedTime + 300);
		herd(world, 7722, [44, 40]);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 7723, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [7722]);
	});

	it("a hungry hand passes over a full carcass and a picked-clean one for fresh cattle", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7731, [40, 40], { "resourceSupplyNumGatherers": () => 8 });
		herd(world, 7732, [42, 40], { "resourceSupplyNumGatherers": () => 1, "resourceSupplyAmount": () => 40 });
		herd(world, 7733, [44, 40]);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 7734, { "gather-type": "food" }, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [7733]);
	});

	it("a hungry hand does not hunt cattle on another land", () =>
	{
		const { world, base, worker } = seat();
		world.accessAt.set("150,150", 3);
		herd(world, 7741, [150, 150]);
		storehouse(world, 7742, [160, 160], ["food"]).setMetadata(PlayerID, "access", 3);
		const ent = hand(world, base, 7743, { "gather-type": "food" }, {}, [140, 140]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a hungry hand hunts the nearer of two herds", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7751, [40, 40]);
		herd(world, 7752, [90, 90]);
		bookCentreSupplies(world, base);
		storehouse(world, 7753, [95, 95], ["food"]);
		const gathered: number[] = [];
		const ent = hand(world, base, 7754, { "gather-type": "food" }, { "gather": ids(gathered) }, [50, 50]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [7751]);
	});

	it("an infantryman does not walk to cattle far away, where a rider would ride", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7761, [250, 250]);
		storehouse(world, 7762, [240, 240], ["food"]);
		const foot = hand(world, base, 7763, { "gather-type": "food" });
		prime(worker, foot);
		assert.equal(worker.startHunting(world.gameState), false, "about 270 m on foot is too far");

		const gathered: number[] = [];
		const horse = rider(world, base, 7764, {}, { "gather": ids(gathered) });
		prime(worker, horse);
		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [7761]);
	});

	it("a hungry hand leaves an ally's cattle on the ally's ground", () =>
	{
		const { world, base, worker } = seat();
		ally(world, 3);
		world.map.setTerritoryOwner(5, 5, 3);
		herd(world, 7771, [40, 40], { "owner": () => 3 });
		bookCentreSupplies(world, base);
		const ent = hand(world, base, 7772, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	/** an archer of the town, able to shoot fleeing game */
	function archer(world: HqWorld, base: Base, id: number, sink: number[])
	{
		const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, "position": [60, 60],
			"classes": ["Unit", "Infantry", "Ranged", "CitizenSoldier", "Worker"] }, {
			"resourceGatherRates": () => ({ "food.meat": 1 }), "gather": ids(sink)
		}, { "role": Worker.ROLE_WORKER, "subrole": Worker.SUBROLE_GATHERER, "gather-type": "food" }));
		base.assignEntity(world.gameState, ent);
		return ent;
	}

	it("an archer shoots a deer on our ground near the centre", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7781, [40, 40], {}, ["Animal"]);
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		prime(worker, archer(world, base, 7782, gathered));

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [7781]);
	});

	it("an archer leaves a deer on no one's ground, where it would flee from the dropsites", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 7791, [40, 40], {}, ["Animal"]);
		bookCentreSupplies(world, base);
		world.map.setTerritoryOwner(5, 5, 0);
		const gathered: number[] = [];
		prime(worker, archer(world, base, 7792, gathered));

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a hungry hand passes over a field already full", () =>
	{
		const { world, base, worker } = seat();
		const fieldOf = (id: number, position: [number, number], numGatherers: number) =>
			world.addEntity(makeHqEntity({
				id, "owner": PLAYER, position, "classes": ["Structure", "Field"], "templateName": "structures/athen/field"
			}, {
				"get": (p: string) => p === "ResourceSupply/Type" ? "food.grain" : undefined,
				"resourceSupplyNumGatherers": () => numGatherers, "resourceSupplyAmount": () => 1000,
				"getDiminishingReturns": () => 1, "maxGatherers": () => 8
			}, { "base": base.ID }));
		fieldOf(7801, [50, 50], 8);
		fieldOf(7802, [30, 30], 0);
		const ent = hand(world, base, 7803, { "gather-type": "food" });
		prime(worker, ent);

		assert.equal((worker.gatherNearestField(world.gameState, base.ID) as FakeEnt).id(), 7802);
	});

	it("a fisher passes over a full shoal, a fished-out one and one in unsafe waters", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 5;
		naval(hq).canFishSafely = (_g: unknown, e: unknown) => (e as FakeEnt).id() !== 7813;
		shoal(world, 7811, [40, 60], { "resourceSupplyNumGatherers": () => 8 });
		shoal(world, 7812, [50, 60], { "resourceSupplyNumGatherers": () => 1 }, 40);
		shoal(world, 7813, [60, 60]);
		shoal(world, 7814, [70, 60]);
		const gathered: number[] = [];
		const ent = boat(world, base, 7815, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), true);
		assert.deepEqual(gathered, [7814]);
	});

	it("a woodcutter joins the raising of a colony's storehouse and answers to the colony", () =>
	{
		const { world, hq, base, worker } = seat();
		const colony = secondTown(world, hq, 7821, [240, 240]);
		world.templates["structures/athen/storehouse"] = structureTemplate("structures/athen/storehouse",
			{ "classes": ["Structure", "Storehouse"], "dropsiteTypes": ["wood"] });
		scaffold(world, 7822, [230, 230], { "base": colony.ID }, ["Structure", "Storehouse"],
			"foundation|structures/athen/storehouse");
		const repaired: number[] = [];
		const ent = hand(world, base, 7823, { "gather-type": "wood" }, { "repair": ids(repaired) });
		prime(worker, ent);

		assert.equal(worker.startGathering(world.gameState), true);
		assert.deepEqual(repaired, [7822]);
		assert.equal(ent.getMetadata(PlayerID, "base"), colony.ID);
	});
});

describe("a worker of a town in trouble: update", () =>
{
	it("a woodcutter carrying food after the centre fell drops the idea and cuts wood", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 7901, [44, 40], "wood", "tree");
		base.assignEntity(world.gameState, storehouse(world, 7902, [40, 40]));
		// the town centre falls: the town keeps its hands, only the wood storehouse stands
		world.removeEntity(1000);
		base.anchorLost(world.gameState);
		const returned: number[] = [];
		const gathered: number[] = [];
		const ent = hand(world, base, 7903, { "gather-type": "wood" }, {
			"resourceCarrying": () => [{ "type": "food", "amount": 10 }],
			"returnResources": ids(returned), "gather": ids(gathered)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(returned, [], "no dropsite takes food");
		assert.deepEqual(gathered, [7901]);
	});

	it("a woodcutter of no town works the nearest town's wood and joins that town", () =>
	{
		const { world, hq, base } = seat();
		rawSupply(world, 7911, [30, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const baseless = hq.basesManager.baselessBase() as Base;
		const gathered: number[] = [];
		const ent = hand(world, baseless, 7912, { "gather-type": "wood" }, { "gather": ids(gathered) });

		baseless.workerObject.update(world.gameState, ent);

		assert.deepEqual(gathered, [7911]);
		assert.equal(ent.getMetadata(PlayerID, "base"), base.ID);
	});
});

describe("a worker's memory of unreachable crops: isInaccessibleSupply", () =>
{
	it("a woodcutter heading for a tree another hand found unreachable turns to the next one", () =>
	{
		const { world, base, worker } = seat();
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		rawSupply(world, 8001, [30, 30], "wood", "tree").setMetadata(PlayerID, "inaccessibleTime", gs.ai.elapsedTime + 300);
		rawSupply(world, 8002, [34, 30], "wood", "tree");
		bookCentreSupplies(world, base);
		const gathered: number[] = [];
		const ent = hand(world, base, 8003, { "gather-type": "wood" }, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.GATHER.APPROACHING",
			"unitAIOrderData": () => [{ "target": 8001 }],
			"gather": ids(gathered)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(gathered, [8002]);
	});

	it("a crop marked unreachable is cleared once a hand gathers from it after all", () =>
	{
		const { world, base, worker } = seat();
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		const tree = rawSupply(world, 8011, [30, 30], "wood", "tree");
		tree.setMetadata(PlayerID, "inaccessibleTime", gs.ai.elapsedTime + 300);
		let carrying = 0;
		const ent = hand(world, base, 8012, {}, {
			"unitAIOrderData": () => [{ "target": 8011 }],
			"resourceCarrying": () => carrying ? [{ "type": "wood", "amount": carrying }] : []
		});
		prime(worker, ent);

		assert.equal(worker.isInaccessibleSupply(world.gameState), true, "marked: the hand is stuck");
		carrying = 5;
		assert.equal(worker.isInaccessibleSupply(world.gameState), false);
		assert.equal(tree.getMetadata(PlayerID, "inaccessibleTime"), 0, "the mark is lifted");
	});

	it("a hand approaching a new crop forgets the retry it spent on another", () =>
	{
		const { world, base, worker } = seat();
		rawSupply(world, 8021, [30, 30], "wood", "tree");
		const ent = hand(world, base, 8022, { "alreadyTried": 8099 }, { "unitAIOrderData": () => [{ "target": 8021 }] });
		prime(worker, ent);

		worker.isInaccessibleSupply(world.gameState);

		assert.equal(ent.getMetadata(PlayerID, "alreadyTried"), undefined);
	});
});

describe("a worker elephant following the gatherers: moveToGatherer", () =>
{
	function elephant(world: HqWorld, id: number, metadata: Record<string, unknown>, moved: number[])
	{
		return world.addEntity(makeHqEntity({
			id, "owner": PLAYER, "position": [20, 20], "classes": ["Unit", "Support", "Builder", "Elephant"]
		}, {
			"resourceDropsiteTypes": () => ["food", "wood", "stone", "metal"],
			"move": (x: number) => moved.push(x)
		}, metadata));
	}

	it("an elephant at work on a foundation stays there", () =>
	{
		const { world, base, worker } = seat();
		hand(world, base, 8101, { "gather-type": "wood" }, { "isIdle": () => false }, [50, 50]);
		const moved: number[] = [];

		worker.moveToGatherer(world.gameState, elephant(world, 8102, { "target-foundation": 8199 }, moved), true);

		assert.deepEqual(moved, []);
	});

	it("an elephant that moved moments ago waits before following again", () =>
	{
		const { world, base, worker } = seat();
		hand(world, base, 8111, { "gather-type": "wood" }, { "isIdle": () => false }, [50, 50]);
		const gs = world.gameState as unknown as { ai: { elapsedTime: number } };
		const moved: number[] = [];

		// the town's turn asks without forcing it (baseManager.update)
		worker.moveToGatherer(world.gameState,
			elephant(world, 8112, { "nextMoveToGatherer": gs.ai.elapsedTime + 4 }, moved), false);

		assert.deepEqual(moved, []);
	});

	it("an elephant follows the nearer of two gatherers", () =>
	{
		const { world, base, worker } = seat();
		hand(world, base, 8121, { "gather-type": "wood" }, { "isIdle": () => false }, [50, 50]);
		hand(world, base, 8122, { "gather-type": "stone" }, { "isIdle": () => false }, [150, 150]);
		const moved: number[] = [];

		worker.moveToGatherer(world.gameState, elephant(world, 8123, {}, moved), false);

		assert.deepEqual(moved, [50]);
	});
});

describe("allies' dropsites, when shared", () =>
{
	it("a hungry hand hunts cattle beside an ally's shared farmstead", () =>
	{
		const { world, base, worker } = seat();
		ally(world, 3);
		shareDropsites(world);
		herd(world, 8201, [200, 200]);
		// our worker elephant aboard a ship (no position) counts for nothing
		world.addEntity(makeHqEntity({ "id": 8202, "owner": PLAYER, "position": undefined,
			"classes": ["Unit", "Support", "Elephant"] }, { "isResourceDropsite": (r?: string) => !r || r === "food" }));
		world.addEntity(makeHqEntity({ "id": 8203, "owner": 3, "position": [210, 210], "classes": ["Structure", "Farmstead"] },
			{ "isResourceDropsite": (r?: string) => !r || r === "food", "isSharedDropsite": () => true }));
		const gathered: number[] = [];
		const ent = hand(world, base, 8204, { "gather-type": "food" }, { "gather": ids(gathered) }, [190, 190]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), true);
		assert.deepEqual(gathered, [8201]);
	});

	it("an ally's farmstead it does not share takes none of our meat", () =>
	{
		const { world, base, worker } = seat();
		ally(world, 3);
		shareDropsites(world);
		herd(world, 8211, [200, 200]);
		world.addEntity(makeHqEntity({ "id": 8212, "owner": 3, "position": [210, 210], "classes": ["Structure", "Farmstead"] },
			{ "isResourceDropsite": (r?: string) => !r || r === "food", "isSharedDropsite": () => false }));
		const ent = hand(world, base, 8213, { "gather-type": "food" }, {}, [190, 190]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a farmstead of ours across the water takes none of the meat", () =>
	{
		const { world, base, worker } = seat();
		herd(world, 8221, [150, 150]);
		storehouse(world, 8222, [170, 170], ["food"]).setMetadata(PlayerID, "access", 3);
		const ent = hand(world, base, 8223, { "gather-type": "food" }, {}, [140, 140]);
		prime(worker, ent);

		assert.equal(worker.startHunting(world.gameState), false);
	});

	it("a rider chasing into neutral ground carries on beside an ally's shared farmstead", () =>
	{
		const { world, base, worker } = seat();
		// player 3 is neutral and owns the ground; player 4 is our ally
		(world.gameState.playerData as unknown as { isEnemy: boolean[] }).isEnemy[3] = false;
		world.map.setTerritoryOwner(31, 31, 3);
		ally(world, 4);
		shareDropsites(world);
		herd(world, 8231, [250, 250]);
		bookCentreSupplies(world, base);
		// ours across the water, and an ally's it does not share, count for nothing
		storehouse(world, 8232, [245, 245], ["food"]).setMetadata(PlayerID, "access", 3);
		world.addEntity(makeHqEntity({ "id": 8233, "owner": 4, "position": [240, 240], "classes": ["Structure", "Farmstead"] },
			{ "isResourceDropsite": (r?: string) => !r || r === "food", "isSharedDropsite": () => false }));
		world.addEntity(makeHqEntity({ "id": 8234, "owner": 4, "position": [255, 255], "classes": ["Structure", "Farmstead"] },
			{ "isResourceDropsite": (r?: string) => !r || r === "food", "isSharedDropsite": () => true }));
		const stops: number[] = [];
		const ent = rider(world, base, 8235, {}, {
			"isIdle": () => false,
			"unitAIState": () => "INDIVIDUAL.COMBAT.APPROACHING",
			"unitAIOrderData": () => [{ "target": 8231 }],
			"stopMoving": () => stops.push(1)
		});

		worker.update(world.gameState, ent);

		assert.deepEqual(stops, [], "the ally's farmstead takes the meat");
	});

	it("a fisher casts at the shoal beside an ally's shared dock", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 5;
		naval(hq).canFishSafely = () => true;
		ally(world, 3);
		shareDropsites(world);
		shoal(world, 8241, [60, 200]);
		shoal(world, 8242, [200, 60]);
		dock(world, 8243, [60, 210], 5, 3, { "isSharedDropsite": () => true });
		const gathered: number[] = [];
		const ent = boat(world, base, 8244, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), true);
		assert.deepEqual(gathered, [8241]);
	});

	it("a fisher reckons only docks on its own sea, and allies' it may use", () =>
	{
		const { world, hq, base, worker } = seat();
		naval(hq).getFishSea = () => 5;
		naval(hq).canFishSafely = () => true;
		ally(world, 3);
		shareDropsites(world);
		shoal(world, 8251, [200, 60]);
		shoal(world, 8252, [60, 200]);
		dock(world, 8253, [210, 60], 5);
		// beside the second shoal: our dock on another sea, and an ally's it does not share
		dock(world, 8254, [60, 210], 6);
		dock(world, 8255, [70, 210], 5, 3, { "isSharedDropsite": () => false });
		const gathered: number[] = [];
		const ent = boat(world, base, 8256, { "gather": ids(gathered) });
		prime(worker, ent);

		assert.equal(worker.startFishing(world.gameState), true);
		assert.deepEqual(gathered, [8251]);
	});
});
