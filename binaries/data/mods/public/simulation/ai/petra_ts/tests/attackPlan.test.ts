/**
 * AttackPlan: how Petra turns a unit collection into an attack.
 *
 * The plan covers the plan's whole life: the constructor's unit-stat table and
 * rally point, the preparation loop that fills queues and assigns units, the
 * moment the attack starts, and the walks, transports and retaliations that
 * follow. Each step needs a different slice of the world, so the fake world
 * below is built per test from shared factories, and every entity answers
 * exactly what its test declared.
 *
 * The entity collections, filters and queues are the game's own code
 * (common-api and Petra's QueueManager); the plan is measured as it would run
 * in game, with fake entities behind them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commands, logs, resetRecorder, sent } from "./harness/engine.ts";
import {
	emptyEvents, fake, makeEntity, makeTemplate, type Methods, override, restoreEngine, stubEngine,
	withPath
} from "./harness/fakes.ts";
import { collectionOf, ENEMY, GAIA, makeWorld, mapOf, PLAYER, type World } from "./harness/world.ts";

import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import * as filtersModule from "simulation/ai/common-api/filters.js";

import {
	entityId, landRegion, playerId, seaRegion, seconds, templateName, worldPos
} from "../adapter/brands.ts";
import { EASY, SANDBOX, VERY_EASY } from "../decision/difficultyLevel.ts";
import type { VictoryManager } from "../decision/victoryManager.ts";
import { AttackPlan, type AttackType, type AttackUnitStat } from "../execution/attackPlan.ts";
import type { Queue } from "../execution/queue.ts";

/** the relic raids a victory manager books, its own private record */
function raids(manager: VictoryManager): Map<EntityId, number[]>
{
	return fake<{ targetedGaiaRelics: Map<EntityId, number[]> }>(manager).targetedGaiaRelics;
}

/** A standard plan, driven like headquarters drives it. */
interface PlanOptions
{
	name?: number;
	type?: AttackType;
	deserialized?: boolean;
	data?: ConstructorParameters<typeof AttackPlan>[4];
	init?: boolean;
}

function makePlan(world: World, options: PlanOptions = {}): AttackPlan
{
	const plan = new AttackPlan(world.gameState, world.ai.Config, options.name ?? 1, options.type ?? "Attack", options.data, options.deserialized ?? true);
	// headquarters registers the queues before the plan is initialized.
	if (options.init)
	{
		const name = options.name ?? 1;
		world.ai.queueManager.addQueue(`plan_${name}`, 70);
		world.ai.queueManager.addQueue(`plan_${name}_champ`, 71);
		world.ai.queueManager.addQueue(`plan_${name}_siege`, 70);
		plan.init(world.gameState);
	}
	return plan;
}

/** A plan for the enemy civil centre, on the same land as the base. */
function makeTarget(world: World, detail: Methods = {}, id = 2000): CommonEntity
{
	return world.addEntity(makeEntity({
		id,
		owner: ENEMY,
		position: [30, 40],
		classes: ["Structure", "CivCentre"],
		templateName: "structures/athen_civil_centre"
	}, detail));
}

/** A spearman the best-trainable choice can name as its answer. */
function registerSpearman(world: World): void
{
	world.templates["units/athen_spearman"] = makeTemplate("units/athen_spearman", {
		classes: ["Infantry", "Melee", "CitizenSoldier"],
		cost: { "food": 100, "wood": 20 }
	});
}

describe("construction", () =>
{
	it("takes its rally point from the first base and lays out the attack sizes", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 3 });

		assert.equal(plan.getName(), 3, "the plan keeps its name");
		assert.equal(plan.getType(), "Attack", "the default type is a plain attack");
		assert.equal(plan.state, "unexecuted", "the plan starts unexecuted");
		assert.equal(plan.rallyPoint?.[0], 10, "the rally point is the anchor's");
		assert.deepEqual(plan.unitStat.RangedInfantry, {
			"priority": 1, "minSize": 6, "targetSize": 16, "batchSize": 3,
			"classes": ["Infantry+Ranged"],
			"interests": [["canGather", 1], ["strength", 1.6], ["costsResource", 0.3, "stone"], ["costsResource", 0.3, "metal"]]
		}, "the ranged infantry stat table");
		assert.deepEqual(plan.unitStat.MeleeInfantry, {
			"priority": 1, "minSize": 6, "targetSize": 16, "batchSize": 3,
			"classes": ["Infantry+Melee"],
			"interests": [["canGather", 1], ["strength", 1.6], ["costsResource", 0.3, "stone"], ["costsResource", 0.3, "metal"]]
		}, "the melee infantry stat table");
		assert.deepEqual(plan.unitStat.FastMoving, {
			"priority": 1, "minSize": 2, "targetSize": 6, "batchSize": 2,
			"classes": ["FastMoving+CitizenSoldier"], "interests": [["strength", 1]]
		}, "the fast-moving stat table");
		assert.equal(plan.neededShips, 3, "a plain attack needs three ships");
		assert.equal(plan.siegeState, 0, "siege units are untested");
		assert.equal(plan.isBlocked, false, "no walls are known");
		assert.equal(plan.failed, undefined, "the plan has not failed");
		assert.equal(plan.buildOrders.length, 0, "no build orders yet");
		assert.equal(plan.canBuildUnits, true, "the HQ says the plan can build units");
	});

	it("registers its three queues with the right priorities, unless deserialized", () =>
	{
		const world = makeWorld();
		resetRecorder();
		makePlan(world, { name: 2, deserialized: false });

		assert.deepEqual(Object.keys(world.ai.queues).filter((name) => name.startsWith("plan_")),
			["plan_2", "plan_2_champ", "plan_2_siege"], "the plan queues exist");
		assert.equal(world.ai.queueManager.getPriority("plan_2"), 70, "the main queue's priority");
		assert.equal(world.ai.queueManager.getPriority("plan_2_champ"), 71, "the champion queue runs after");
		assert.equal(world.ai.queueManager.getPriority("plan_2_siege"), 70, "the siege queue keeps up");
	});

	it("gives every type its own army layout", () =>
	{
		const rush = makePlan(makeWorld(), { name: 1, type: "Rush" });
		assert.equal(rush.getType(), "Rush");
		assert.deepEqual(rush.unitStat.Infantry, {
			"priority": 1, "minSize": 10, "targetSize": 20, "batchSize": 2,
			"classes": ["Infantry"],
			"interests": [["strength", 1], ["costsResource", 0.5, "stone"], ["costsResource", 0.6, "metal"]]
		}, "the rush infantry");
		assert.deepEqual(rush.unitStat.FastMoving, {
			"priority": 1, "minSize": 2, "targetSize": 4, "batchSize": 2,
			"classes": ["FastMoving+CitizenSoldier"], "interests": [["strength", 1]]
		}, "the rush fast-movers");
		assert.equal(rush.neededShips, 1, "a rush needs one ship");
		assert.equal(Object.keys(rush.unitStat).length, 2, "and nothing else");

		const raid = makePlan(makeWorld(), { name: 1, type: "Raid" });
		assert.deepEqual(raid.unitStat.FastMoving, {
			"priority": 1, "minSize": 3, "targetSize": 4, "batchSize": 2,
			"classes": ["FastMoving+CitizenSoldier"], "interests": [["strength", 1]]
		}, "the raid fast-movers");
		assert.equal(raid.neededShips, 1, "a raid needs one ship");
		assert.equal(Object.keys(raid.unitStat).length, 1, "raids are fast-movers only");

		const huge = makePlan(makeWorld(), { name: 1, type: "HugeAttack" });
		assert.equal(Object.keys(huge.unitStat).length, 9, "the huge attack mixes nine unit kinds");
		assert.deepEqual(huge.unitStat.Hero, {
			"priority": 1, "minSize": 0, "targetSize": 1, "batchSize": 1,
			"classes": ["Hero"], "interests": [["strength", 2]]
		}, "one hero wanted");
		assert.equal(huge.neededShips, 5, "a huge attack needs five ships");
	});

	it("keeps the target it is given, and a rush's wanted size", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world);
		const plan = makePlan(world, { name: 1, type: "Rush", data: { target, uniqueTargetId: target.id(), targetSize: 7 } });

		assert.equal(plan.target, target, "the plan keeps the entity");
		assert.deepEqual(plan.targetPos, [30, 40], "and its position");
		assert.equal(plan.targetPlayer, ENEMY, "and the owner");
		assert.equal(plan.uniqueTargetId, target.id(), "and the unique id");
		assert.equal(plan.unitStat.Infantry.targetSize, 7, "the rush honours the wanted size");
	});

	it("falls back to any owned entity when there is no base anchor", () =>
	{
		const world = makeWorld();
		world.bases[0].anchor = undefined;
		const unit = world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [12, 14], classes: ["Unit", "Infantry"] }));

		const plan = makePlan(world, { name: 1 });
		assert.deepEqual(plan.rallyPoint, [12, 14], "the plan rallies at the entity");
		assert.equal(world.ai.accessibility.getAccessValue(plan.rallyPoint), 2, "on its land");
		// and the entity is untouched by the choice
		assert.equal(unit.getMetadata(PLAYER, "plan"), undefined, "no plan metadata on the entity");
	});

	it("fails when the player has nothing to rally at", () =>
	{
		const world = makeWorld();
		world.bases[0].anchor = undefined;
		world.removeEntity(1000);

		const plan = makePlan(world, { name: 1 });
		assert.equal(plan.failed, true, "the plan declares failure");
	});

	it("plans a sea crossing when the enemy is overseas", () =>
	{
		const world = makeWorld({ navalMap: true, sea: 4 });
		const structure = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [50, 50],
			classes: ["Structure", "Tower"]
		}));
		world.accessAt.set("50,50", 3);
		// the plan's target: this very structure, reached only over sea 4
		const plan = makePlan(world, {
			name: 1, type: "Attack",
			data: { target: structure }
		});

		assert.equal(plan.overseas, 4, "the plan is overseas");
		assert.deepEqual(world.minimalShipCalls, [[4, 1]], "the naval manager is told one ship is minimal");
	});

	it("re-rallies at the base on the target's land when there is one", () =>
	{
		const world = makeWorld({ navalMap: true, sea: 4 });
		// a GAIA structure on the player's land: it is the first enemy
		// structure the loop looks at, and its access is the base's.
		world.addEntity(makeEntity({
			id: 3001, owner: GAIA, position: [15, 15], classes: ["Structure", "Tower"]
		}));
		const plan = makePlan(world, { name: 1, type: "Attack" });

		assert.equal(plan.overseas, 0, "no sea crossing planned");
		assert.deepEqual(plan.rallyPoint, [10, 10], "the rally point stays on the base's land");
	});

	it("fails when the overseas target sits on an inaccessible island", () =>
	{
		const world = makeWorld({ navalMap: true, sea: undefined });
		// the base is on land 2; the enemy structure on an island with no sea
		world.accessAt.set("15,15", 3);
		resetRecorder();
		const plan = makePlan(world, {
			name: 1, type: "Attack",
			data: { target: world.addEntity(makeEntity({ id: 3002, owner: ENEMY, position: [15, 15], classes: ["Structure"] })) }
		});

		assert.equal(plan.failed, true, "the plan gives up");
		assert.ok(logs.some((entry) => /has an inaccessible target/.test(entry)), "the reason is logged");
	});

	it("shrinks the army on a low difficulty, and snaps on top of it", () =>
	{
		const veryEasy = makePlan(makeWorld({ difficulty: VERY_EASY }), { name: 1 });
		assert.deepEqual(
			["RangedInfantry", "MeleeInfantry", "FastMoving"].map((cat) => veryEasy.unitStat[cat].targetSize),
			[4, 4, 2], "target sizes shrink to a fifth and round up");
		assert.deepEqual(
			["RangedInfantry", "MeleeInfantry", "FastMoving"].map((cat) => veryEasy.unitStat[cat].minSize),
			[2, 2, 2], "min sizes drop to two at most");
		assert.deepEqual(
			["RangedInfantry", "MeleeInfantry", "FastMoving"].map((cat) => veryEasy.unitStat[cat].batchSize),
			[2, 2, 2], "batch size equals min size");

		const sandbox = makePlan(makeWorld({ difficulty: SANDBOX }), { name: 1 });
		assert.equal(sandbox.unitStat.RangedInfantry.minSize, 2, "the same rule for the sandbox");
	});

	it("scales the army with the player's population settings", () =>
	{
		const plan = makePlan(makeWorld({ popScaling: 2 }), { name: 1 });
		assert.equal(plan.neededShips, 6, "twice the ships");
		assert.equal(plan.unitStat.RangedInfantry.targetSize, 32, "twice the ranged infantry");
		assert.equal(plan.unitStat.FastMoving.targetSize, 12, "twice the fast-movers");
		assert.equal(plan.unitStat.FastMoving.minSize, 4, "twice the min fast-movers");
	});
});

describe("queues, queries and build orders", () =>
{
	it("links its queues and builds its unit collections", () =>
	{
		const world = makeWorld();
		// three soldiers fit the melee infantry; one is already on another plan
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "Melee", "CitizenSoldier"]
			}, {}, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1020, owner: PLAYER, position: [11, 12],
			classes: ["Unit", "Infantry", "Melee", "CitizenSoldier"]
		}, {}, { "plan": 2 }));

		const plan = makePlan(world, { name: 1, init: true });

		assert.equal(plan.unitCollection.length, 3, "the collection holds this plan's units");
		assert.equal(plan.queue, world.ai.queues["plan_1"], "the main queue is linked");
		assert.equal(plan.queueChamp, world.ai.queues["plan_1_champ"], "as are the others");
		assert.equal(plan.queueSiege, world.ai.queues["plan_1_siege"], "all three");
		assert.deepEqual(plan.unit.MeleeInfantry.toIdArray(), [1010, 1011, 1012], "the melee collection");
		assert.equal(plan.unit.FastMoving.length, 0, "empty fast-mover collection");
		assert.equal(plan.buildOrders.length, 3, "one build order per stat category");
		assert.deepEqual(plan.buildOrders.map((order) => order[0]), [0, 0, 0], "progress starts at zero");
		assert.equal(plan.buildOrders[0][4], "RangedInfantry", "the build order names its category");
		assert.equal(world.collections.registered.length, 4, "four collections registered for updates");
	});

	it("answers the easy questions", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.isStarted(), false, "unexecuted is not started");
		assert.equal(plan.isPaused(), false, "not paused");
		plan.setPaused(true);
		assert.equal(plan.isPaused(), true, "paused now");
	});

	it("can start when every category passed its min size", () =>
	{
		const world = makeWorld();
		for (let i = 0; i < 6; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "Melee", "CitizenSoldier"]
			}, {}, { "plan": 1 }));
		for (let i = 0; i < 6; ++i)
			world.addEntity(makeEntity({
				id: 1040 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "Ranged", "CitizenSoldier"]
			}, {}, { "plan": 1 }));
		for (let i = 0; i < 2; ++i)
			world.addEntity(makeEntity({
				id: 1020 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.canStart(), true, "all categories at min size");
		assert.equal(plan.mustStart(), false, "but not yet at target sizes");

		plan.unitStat.FastMoving.minSize = 3;
		assert.equal(plan.canStart(), false, "one short keeps waiting");
	});

	it("starts one shortfall in a category only when every category is at target size", () =>
	{
		const world = makeWorld({ canBuildUnits: false });
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.mustStart(), true, "without building, units in collection mean must start");
	});

	it("force-starts by emptying the wanted sizes", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.forceStart();
		assert.equal(plan.forced, true, "the plan is forced");
		for (const cat in plan.unitStat)
		{
			assert.equal(plan.unitStat[cat].targetSize, 0, cat + " wants nothing");
			assert.equal(plan.unitStat[cat].minSize, 0, cat + " requires nothing");
		}
	});

	it("empties and removes its own queues", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });

		const emptyCalls: string[] = [];
		const countEmpty = (queue: Queue, name: string) => {
			const original = queue.empty;
			queue.empty = () => {
				emptyCalls.push(name);
				original.call(queue);
			};
			return queue;
		};
		countEmpty(plan.queue, "main");
		countEmpty(plan.queueChamp, "champ");
		countEmpty(plan.queueSiege, "siege");
		plan.emptyQueues();
		assert.deepEqual(emptyCalls, ["main", "champ", "siege"], "all three queues emptied");

		const removed: string[] = [];
		world.ai.queueManager.removeQueue = (name: string) => removed.push(name);
		plan.removeQueues(world.gameState);
		assert.deepEqual(removed, ["plan_1", "plan_1_champ", "plan_1_siege"], "all three queues removed");
	});

	it("skips building orders and refuses to add them while the attack is on", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });

		const stat = { "priority": 1, "minSize": 0, "targetSize": 5, "batchSize": 2, "classes": ["Siege"] };
		plan.addBuildOrder(world.gameState, "Siege", stat, true);
		assert.equal(plan.buildOrders.length, 4, "the order is added");
		assert.equal(plan.unitStat.Siege, stat, "the stat is kept");
		assert.equal(plan.buildOrders[3][4], "Siege", "under its name");
		assert.equal(plan.unit.Siege.length, 0, "and its collection built");

		// resetQueue empties the queues
		const emptied: number[] = [];
		for (const queue of [plan.queue, plan.queueChamp, plan.queueSiege])
			queue.empty = () => {
				emptied.push(1);
			};
		plan.addBuildOrder(world.gameState, "Siege2", stat, true);
		assert.equal(emptied.length, 3, "the queues were emptied");

		plan.state = "walking";
		plan.addBuildOrder(world.gameState, "Siege3", stat, true);
		assert.equal(plan.buildOrders.length, 5, "a started plan takes no new orders");
	});
});

describe("siege units", () =>
{
	/** A barracks able to train the given templates. */
	it("finds nothing when the player has no siege trainer", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.addSiegeUnits(world.gameState), false, "no trainer, no siege");
		assert.equal(plan.siegeState, 1, "the plan remembers there is no trainer");
		assert.equal(plan.buildOrders.length, 3, "no order was added");
	});

	it("skips trainers whose trainables are disabled or missing", () =>
	{
		const world = makeWorld();
		// the game lists trainers by a truthy trainingQueue (gamestate
		// .findTrainers runs filters.byTrainingQueue), so the fixture gives
		// one (an idle camp answers a truthy empty array)
		const barracks = world.addEntity(makeEntity({
			id: 900, owner: PLAYER, position: [14, 14],
			classes: ["Structure", "Trainer"]
		}, { trainingQueue: () => [] }));
		barracks.trainableEntities = () => [templateName("units/gone_siege")];
		// the game says the template is disabled
		const gameState = world.gameState;
		gameState["isTemplateDisabled"] = () => true;

		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.addSiegeUnits(world.gameState), false, "no usable trainable");
		assert.equal(plan.siegeState, 1, "remembered as no trainer");
	});

	it("adds the kind of siege unit it has a trainer for", () =>
	{
		const world = makeWorld();
		// the game lists trainers by a truthy trainingQueue (gamestate
		// .findTrainers runs filters.byTrainingQueue); see the disabled camp
		const barracks = world.addEntity(makeEntity({
			id: 900, owner: PLAYER, position: [14, 14],
			classes: ["Structure", "Trainer"]
		}, { trainingQueue: () => [] }));
		barracks.trainableEntities = () => [templateName("units/siege_ram")];
		world.templates["units/siege_ram"] = makeTemplate("units/siege_ram", { classes: ["Siege", "Melee"] });

		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.addSiegeUnits(world.gameState), true, "the siege was added");
		assert.equal(plan.siegeState, 2, "and marked as such");
		const siegeOrder = plan.buildOrders[plan.buildOrders.length - 1];
		assert.equal(siegeOrder[4], "Siege", "the order named Siege");
		assert.deepEqual(siegeOrder[1], ["Siege+Melee"], "it wants melee siege units");
		assert.equal(siegeOrder[3].targetSize, 2, "two units on medium difficulty");
		assert.equal(siegeOrder[3].minSize, 0, "and no min size");

		assert.equal(plan.addSiegeUnits(world.gameState), false, "a second call adds nothing");
	});

	it("starts at hard difficulty sizes and skips when the size is zero", () =>
	{
		const world = makeWorld({ difficulty: SANDBOX });
		// the game lists trainers by a truthy trainingQueue (see above)
		const barracks = world.addEntity(makeEntity({
			id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Trainer"]
		}, { trainingQueue: () => [] }));
		barracks.trainableEntities = () => [templateName("units/siege_balista")];
		world.templates["units/siege_balista"] = makeTemplate("units/siege_cloud", { classes: ["Siege", "Ranged"] });

		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.addSiegeUnits(world.gameState), true, "still a yes");
		assert.equal(plan.siegeState, 2, "marked");
		assert.deepEqual(plan.buildOrders.map((order) => order[4]), ["RangedInfantry", "MeleeInfantry", "FastMoving"],
			"no siege order on the sandbox difficulty");
	});

	it("stops when the plan is no longer unexecuted", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.siegeState = 2;
		assert.equal(plan.addSiegeUnits(world.gameState), false, "already added");
		plan.siegeState = 0;
		plan.state = "walking";
		assert.equal(plan.addSiegeUnits(world.gameState), false, "or already started");
	});
});

describe("choosing a target", () =>
{
	it("picks the enemy civil centre nearest to the rally point", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [60, 60], classes: ["Structure", "CivCentre"]
		}));
		const target = makeTarget(world); // [30,40], also a civ centre

		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "a target was chosen");
		});
		assert.equal(plan.target, target, "the nearer centre");
		assert.deepEqual(plan.targetPos, [30, 40], "at its position");
		assert.equal(plan.targetPlayer, ENEMY, "from the right player");
		assert.deepEqual(plan.rallyPoint, [10, 10], "the rally point stands");
		assert.equal(plan.overseas, 0, "the attack is not overseas");
	});

	it("fails when no enemy has anything to attack", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.chooseTarget(world.gameState), false, "nothing to attack");
		assert.equal(plan.target, undefined, "and no target");
	});

	it("moves the rally point to the base nearest to the target's island", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		world.accessAt.set("55,55", 3);
		const otherAnchor = world.addEntity(makeEntity({
			id: 1300, owner: PLAYER, position: [40, 45], classes: ["Structure", "CivCentre"]
		}));
		world.bases.push({ anchor: otherAnchor, accessIndex: 3 });
		world.addEntity(makeEntity({
			id: 2100, owner: ENEMY, position: [55, 55], classes: ["Structure", "CivCentre"]
		}));

		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 55, "y": 55 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "the target was chosen");
		});
		assert.deepEqual(plan.rallyPoint, [40, 45], "the rally point moved to the island");
		assert.equal(plan.overseas, 0, "no sea crossing needed");
	});

	it("took the crossing from the earlier base, needing ships", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY, sea: 4 });
		world.accessAt.set("55,55", 3);
		world.addEntity(makeEntity({
			id: 2100, owner: ENEMY, position: [55, 55], classes: ["Structure", "CivCentre"]
		}));

		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 55, "y": 55 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "the target was chosen");
		});
		assert.deepEqual(plan.rallyPoint, [10, 10], "the rally point kept");
		assert.equal(plan.overseas, 4, "the attack is overseas");
		assert.deepEqual(world.minimalShipCalls, [[4, 3]], "the manager asks three ships");
	});

	it("gives up when the crossing's sea is unknown", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY, sea: undefined });
		world.accessAt.set("55,55", 3);
		world.addEntity(makeEntity({
			id: 2100, owner: ENEMY, position: [55, 55], classes: ["Structure", "CivCentre"]
		}));

		resetRecorder();
		const plan = makePlan(world, { name: 1, init: true });
		let result;
		withPath([{ "x": 55, "y": 55 }], () =>
		{
			result = plan.chooseTarget(world.gameState);
		});
		assert.equal(result, false, "no path over the sea");
		assert.ok(logs.some((entry) => /has an inaccessible target/.test(entry)), "the reason is logged");
	});

	it("targets the relic marked by the victory condition", () =>
	{
		const world = makeWorld({
			enemyPlayer: ENEMY,
			victoryConditions: ["wonder", "regicide", "capture_the_relic"]
		});
		const wonder = world.addEntity(makeEntity({
			id: 2200, owner: ENEMY, position: [70, 70], classes: ["Structure", "Wonder"]
		}));
		const hero = world.addEntity(makeEntity({
			id: 2201, owner: ENEMY, position: [20, 20], classes: ["Unit", "Hero"]
		}));
		const relic = world.addEntity(makeEntity({
			id: 2202, owner: ENEMY, position: [15, 15], classes: ["Unit", "Relic"]
		}));
		world.addEntity(makeEntity({ id: 2203, owner: GAIA, position: [40, 40], classes: ["Unit", "Relic"] }));

		// HugeAttack routes straight to the victory-condition finder.
		const plan = makePlan(world, { name: 1, type: "HugeAttack", init: true });
		withPath([{ "x": 15, "y": 15 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "a relic was chosen");
		});
		assert.equal(plan.target, relic, "the relic owned by the enemy");
		assert.equal(plan.targetPlayer, ENEMY, "the relic's owner");

		for (const ent of [wonder, hero, relic])
		{
			assert.ok(ent, "the sibling entities were present");
		}
		assert.ok(world.ai.HQ.victoryManager.criticalEnts, "the victory manager was untouched");
	});

	it("marks the chosen gaia relic as targeted", () =>
	{
		const world = makeWorld({
			enemyPlayer: GAIA,
			victoryConditions: ["capture_the_relic"]
		});
		const relic = world.addEntity(makeEntity({
			id: 2210, owner: GAIA, position: [25, 25], classes: ["Unit", "Relic"]
		}));

		const plan = makePlan(world, { name: 5, type: "HugeAttack", init: true });
		withPath([{ "x": 25, "y": 25 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "the relic was chosen");
		});
		assert.equal(plan.target, relic, "the gaia relic");
		assert.deepEqual(raids(world.ai.HQ.victoryManager).get(relic.id()), [5],
			"the plan marks the relic as its target");
	});

	it("takes the centre whose builder was attacked, when raiding", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const foundation = world.addEntity(makeEntity({
			id: 2300, owner: ENEMY, position: [35, 40], classes: ["Structure"]
		}));
		world.ai.HQ.defenseManager.targetList.push(foundation.id());

		const plan = makePlan(world, { name: 1, type: "Raid", init: true });
		withPath([{ "x": 35, "y": 40 }], () =>
		{
			assert.equal(plan.chooseTarget(world.gameState), true, "the raid found its purpose");
		});
		assert.equal(plan.target, foundation, "the foundation under attack");
	});

	it("rushes the isolated building nearest to its unit collection", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		// our collection: one soldier at [11,12]
		const soldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });

		// a tower and its defended hut: the hut is skipped, the barn is not
		const defendedHut = world.addEntity(makeEntity({
			id: 2301, owner: ENEMY, position: [130, 130], classes: ["Structure", "House"]
		}));
		const tower = world.addEntity(makeEntity({
			id: 2302, owner: ENEMY, position: [150, 150], classes: ["Structure", "Tower"]
		}, { hasDefensiveFire: () => true }));
		const barn = world.addEntity(makeEntity({
			id: 2303, owner: ENEMY, position: [30, 32], classes: ["Structure", "Farmstead"]
		}));

		plan.targetPlayer = ENEMY;
		withPath([{ "x": 30, "y": 32 }], () =>
		{
			const target = plan.getNearestTarget(world.gameState, plan.rallyPoint);
			assert.equal(target, barn, "the nearest isolated building");
		});
		assert.deepEqual(plan.position, [11, 12], "the plan positioned itself");
		assert.ok(soldier && defendedHut && tower, "the scaffolding bits existed");
	});

	it("keeps the smallest distance unit when the plan prefers its island", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const local = makeTarget(world); // [30,40], land 2
		const far = world.addEntity(makeEntity({
			id: 2101, owner: ENEMY, position: [55, 55], classes: ["Structure", "CivCentre"]
		}));
		world.accessAt.set("55,55", 3);

		const plan = makePlan(world, { name: 1, init: true });
		plan.targetPlayer = ENEMY;
		withPath([{ "x": 30, "y": 40 }], () =>
		{
			const target = plan.getNearestTarget(world.gameState, plan.rallyPoint, landRegion(2));
			assert.equal(target, local, "the target stays on the plan's island");
		});
		assert.equal(plan.sameLand, 2, "the plan remembered its land");
		assert.ok(far, "the far centre was there");
	});

	it("ignores decaying structures nobody mans", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		// houses really decay (a Carthaginian apartment or a field, never a civic centre)
		const decayed = world.addEntity(makeEntity({
			id: 2400, owner: ENEMY, position: [20, 20], classes: ["Structure", "Village", "House"]
		}, { decaying: () => true }));
		const manned = world.addEntity(makeEntity({
			id: 2401, owner: ENEMY, position: [30, 40], classes: ["Structure", "Village", "House"]
		}, { decaying: () => true, getDefaultArrow: () => 1 }));

		const plan = makePlan(world, { name: 1, init: true });
		plan.targetPlayer = ENEMY;
		withPath([{ "x": 30, "y": 40 }], () =>
		{
			const target = plan.getNearestTarget(world.gameState, plan.rallyPoint);
			assert.equal(target, manned, "the manned centre wins");
		});
		assert.ok(decayed, "the decayed one was there");
	});
});

describe("training units", () =>
{
	it("queues the best unit for the category that needs it most", () =>
	{
		const world = makeWorld();
		registerSpearman(world);
		world.knobs.bestTrainable = "units/athen_spearman";
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });

		plan.trainMoreUnits(world.gameState);
		assert.equal(plan.queue.length(), 1, "one plan queued");
		const queued = plan.queue.plans[0];
		assert.ok(queued.metadata, "the queued plan carries metadata");
		assert.equal(queued.type, "units/athen_spearman", "the named unit");
		assert.equal(queued.number, 2, "a batch of the rush's batch size");
		assert.equal(queued.metadata?.plan, 1, "for this plan");
		assert.equal(queued.metadata?.special, "Plan_1_Infantry", "with the plan's special tag");
		assert.equal(queued.metadata?.role, "worker", "a citizen soldier trains as a worker");
		assert.equal(queued.metadata?.base, 0, "at no base in particular");

		// a second run, on the full queue path: the queue holds the wanted units
		const first = plan.queue.plans[0];
		assert.ok(first.category === "unit" && first.template.available(world.gameState), "the template is available");
	});

	it("trains a mercenary for the attack as an attacker, not as a worker", () =>
	{
		const world = makeWorld();
		world.templates["units/athen_mercenary"] = makeTemplate("units/athen_mercenary", {
			classes: ["Infantry", "Ranged", "CitizenSoldier", "Worker", "Mercenary"],
			cost: { "food": 50, "metal": 50 }
		});
		world.knobs.bestTrainable = "units/athen_mercenary";
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });

		plan.trainMoreUnits(world.gameState);

		assert.equal(plan.queue.plans[0]?.type, "units/athen_mercenary");
		assert.equal(plan.queue.plans[0]?.metadata?.role, "attack");
	});

	it("queues champions and heroes in their own queues", () =>
	{
		const world = makeWorld();
		registerSpearman(world);
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });
		world.knobs.bestTrainable = "units/athen_spearman";

		// inject a champion and a hero order directly, replacing the rush's
		// orders: each category trains in the queue its class demands, one
		// order per call
		for (const [cat, classes, wanted] of [
			["Champ", ["Infantry", "Champion"], plan.queueChamp],
			["Hero", ["Hero", "Infantry"], plan.queueSiege]
		] as Array<[string, string[], Queue]>)
		{
			const stat: AttackUnitStat = { "priority": 1, "minSize": 0, "targetSize": 4, "batchSize": 2, "classes": [...classes], "interests": [["strength", 1]] };
			plan.unitStat[cat] = stat;
			const collection = plan.unitCollection.filter(filtersModule.byClasses(classes));
			plan.buildOrders.push([0, [...classes], collection, stat, cat]);
			assert.ok(wanted, "the queue was named");
		}
		plan.buildOrders = plan.buildOrders.filter((order) => ["Hero", "Champ"].indexOf(order[4]) !== -1);
		plan.trainMoreUnits(world.gameState);
		plan.trainMoreUnits(world.gameState);
		assert.equal(plan.queueChamp.length(), 1, "champions queued for the plan");
		assert.equal(plan.queueSiege.length(), 1, "heroes queued for the plan");
	});

	it("deletes a category when the world cannot train it", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, type: "Raid", init: true });
		assert.equal(plan.buildOrders.length, 1, "the raid wants fast-movers");

		world.knobs.bestTrainable = undefined;
		plan.trainMoreUnits(world.gameState);
		assert.equal(plan.buildOrders.length, 0, "the order was dropped");
		assert.equal(plan.unitStat.FastMoving, undefined, "and its stat removed");
	});

	it("leaves the queue alone when it is full or the size is reached", () =>
	{
		const world = makeWorld();
		registerSpearman(world);
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });

		// a full queue: nothing is queued this turn (the filler carries an
		// empty metadata so queues in every target can count it)
		const filler = fake<PetraRuntime.ConcretePlan>({ "type": "units/other", "metadata": {} });
		for (let i = 0; i < 6; ++i)
			plan.queue.plans.push(filler);
		plan.trainMoreUnits(world.gameState);
		assert.equal(plan.queue.length(), 6, "the queue just held its own");
		plan.queue.plans = [];

		// the category at target size: no training
		plan.unitStat.Infantry.targetSize = 0;
		plan.trainMoreUnits(world.gameState);
		assert.equal(plan.queue.length(), 0, "nothing queued");
	});
});

describe("assigning units", () =>
{
	it("takes everything available when the plan cannot build more units", () =>
	{
		const world = makeWorld({ canBuildUnits: false });
		const plan = makePlan(world, { name: 1, init: true });

		// a soldier already busy on another plan: skipped
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 5 }));
		// a soldier defending an ally: skipped
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "allied": true }));
		// a free soldier: assigned
		const free = world.addEntity(makeEntity({
			id: 1012, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": -1 }));

		assert.equal(plan.assignUnits(world.gameState), true, "one unit was added");
		assert.equal(free.getMetadata(PLAYER, "plan"), 1, "the free soldier joined");
		assert.equal(plan.unitCollection.hasEntId(entityId(1012)), true, "and sits in the collection");
		assert.equal(plan.unitCollection.hasEntId(entityId(1010)), false, "the busy one did not");
	});

	it("leaves two fast soldiers for the hunt during raids", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, type: "Raid", init: true });
		// three fast soldiers and two others
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving"]
			}));
		world.addEntity(makeEntity({
			id: 1030, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry"]
		}));

		assert.equal(plan.assignUnits(world.gameState), true, "fast soldiers were added");
		const listed = [...plan.unitCollection.values()].map((ent) => ent.id()).sort();
		assert.equal(listed.length, 1, "one of the three joined");
		for (const ent of world.units)
			assert.equal(ent.getMetadata(PLAYER, "plan") == 1, ent.id() === listed[0], ent.id() + " plan metadata");
	});

	it("picks up role-free attackers and exiled units", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });

		const attacker = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, { attackTypes: () => ["Melee"] }));
		// a support civilian: skipped (no attack types)
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Support"]
		}, { attackTypes: () => undefined }));
		// a unit doing something else: not handed to the plan
		world.addEntity(makeEntity({
			id: 1012, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }, { "role": "attack" }));
		// exile from another plan, waiting in the attack manager: re-enlisted
		// (it keeps the attack role of its old plan, so only the exile list brings it back)
		const exile = world.addEntity(makeEntity({
			id: 1013, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }, { "role": "attack", "plan": -1 }));
		world.ai.HQ.attackManager.outOfPlan.addEnt(exile);

		assert.equal(plan.assignUnits(world.gameState), true, "units were added");
		assert.equal(attacker.getMetadata(PLAYER, "plan"), 1, "the role-free attacker joined");
		assert.equal(plan.unitCollection.hasEntId(entityId(1013)), true, "the exile rejoined");
		assert.equal(plan.unitCollection.hasEntId(entityId(1012)), false, "the role-carrying unit did not");
	});

	it("leaves enough defenders home and takes idle workers beyond them", () =>
	{
		const world = makeWorld({ defensive: 0, enemyPlayer: ENEMY });
		const plan = makePlan(world, { name: 1, init: true });
		// one enemy on the map
		world.addEntity(makeEntity({
			id: 2000, owner: ENEMY, position: [40, 40], classes: ["Unit", "Melee"]
		}));
		// twelve idle citizen soldiers, all based at base 1
		for (let i = 0; i < 12; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "role": "worker", "subrole": "idle", "base": 1 }));

		const keep = 6 + 4 * 1 + 8 * 0;
		assert.equal(keep, 10, "the formula");
		assert.equal(plan.assignUnits(world.gameState), true, "surplus workers were added");
		const joined = [...plan.unitCollection.values()].map((ent) => Number(ent.id())).sort((a, b) => a - b);
		assert.deepEqual(joined, [1020, 1021], "the last two idle workers joined");
	});

	it("takes gathering workers too when rushing", () =>
	{
		const world = makeWorld({ defensive: 0 });
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });
		world.addEntity(makeEntity({
			id: 2000, owner: ENEMY, position: [40, 40], classes: ["Unit", "Melee"]
		}));
		for (let i = 0; i < 10; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "role": "worker", "base": 1 }));

		assert.equal(plan.assignUnits(world.gameState), true, "surplus workers were added");
		const joined = [...plan.unitCollection.values()].map((ent) => Number(ent.id())).sort((a, b) => a - b);
		assert.deepEqual(joined, [1018, 1019], "the rush ignores subroles");
	});

	it("warns about idle workers that have no base", () =>
	{
		const world = makeWorld({ defensive: 0 });
		const plan = makePlan(world, { name: 1, init: true });
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12],
			classes: ["Unit", "Infantry", "CitizenSoldier"]
		}, { attackTypes: () => undefined }, { "role": "worker" }));
		resetRecorder();
		plan.assignUnits(world.gameState);
		assert.ok(logs.some((entry) => /Petra problem ent without base/.test(entry)), "the warning was logged");
	});
});

describe("availability and small queries", () =>
{
	it("leans on position, plan and transport metadata", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1 });

		const positioned = world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit"] }));
		assert.equal(plan.isAvailableUnit(world.gameState, positioned), true, "a free unit is available");

		const elsewhere = world.addEntity(makeEntity({ id: 1011, owner: PLAYER, classes: ["Unit"] }));
		assert.equal(plan.isAvailableUnit(world.gameState, elsewhere), false, "a unit without position is not");

		const planned = world.addEntity(makeEntity({ id: 1012, owner: PLAYER, position: [11, 12], classes: ["Unit"] }, {}, { "plan": 5 }));
		assert.equal(plan.isAvailableUnit(world.gameState, planned), false, "another plan's unit is not");

		const cleared = world.addEntity(makeEntity({ id: 1013, owner: PLAYER, position: [11, 12], classes: ["Unit"] }, {}, { "plan": -1 }));
		assert.equal(plan.isAvailableUnit(world.gameState, cleared), true, "a cleared unit is available");

		const shipped = world.addEntity(makeEntity({ id: 1014, owner: PLAYER, position: [11, 12], classes: ["Unit"] }, {}, { "transport": 7 }));
		assert.equal(plan.isAvailableUnit(world.gameState, shipped), false, "a transported unit is not");
	});

	it("spares critical entities on health, but only on this land", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1 });
		world.ai.HQ.victoryManager.criticalEnts.set(entityId(1010), { "guardsAssigned": new Set(), "guards": new Map() });
		world.ai.HQ.victoryManager.criticalEnts.set(entityId(1011), { "guardsAssigned": new Set(), "guards": new Map() });

		const unhealthy = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit"]
		}, { healthLevel: () => 0.5 }));
		const healthy = world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit"]
		}, { healthLevel: () => 1 }));

		assert.equal(plan.isAvailableUnit(world.gameState, unhealthy), false, "an overseas-critical hurt unit stays home");
		assert.equal(plan.isAvailableUnit(world.gameState, healthy), true, "healthy criticals go");
		plan.overseas = seaRegion(1);
		assert.equal(plan.isAvailableUnit(world.gameState, healthy), false, "no critical goes overseas");
		plan.overseas = 0;
	});

	it("reports transport waiting, siege presence and forced orders", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.waitingForTransport(), false, "no transport metadata, no waiting");

		const shipped = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry"]
		}, {}, { "plan": 1, "transport": 7 }));
		plan.unitCollection.updateEnt(shipped);
		assert.equal(plan.waitingForTransport(), true, "now waiting for the transport");

		assert.equal(plan.hasSiegeUnits(), false, "no siege units yet");
		const siegeUnit = world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Siege"]
		}, {}, { "plan": 1 }));
		plan.unitCollection.updateEnt(siegeUnit);
		assert.equal(plan.hasSiegeUnits(), true, "a siege unit was seen");

		// an ordered unit, marked for the plan, carrying a forced order and
		// the metadata the data argument looks for
		const ordered = world.addEntity(makeEntity({
			id: 1012, owner: PLAYER, position: [11, 12], classes: ["Unit"]
		}, { unitAIOrderData: () => [{ "target": 5, "targetPos": [5, 5], "force": true }] },
		{ "plan": 1, "target": 5 }));
		plan.unitCollection.updateEnt(ordered);
		assert.equal(plan.hasForceOrder(), true, "the forced order was seen");
		assert.equal(plan.hasForceOrder("target", 5), true, "it matches the data filter");
		assert.equal(plan.hasForceOrder("transport", undefined), false, "another filter drops it");
		assert.ok(shipped && siegeUnit, "the scaffolding bits existed");
	});
});

/** A soldier marching call recorder the preparation loop drives. */
function recordMarches(recorder: unknown[][]): (...args: unknown[]) => unknown
{
	return (...args: unknown[]) =>
	{
		recorder.push(args);
		return undefined;
	};
}

describe("updatePreparation: the completing step", () =>
{

	it("keeps waiting while a unit is on a transport", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "completing";
		const shipped = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1, "transport": 7 }));
		plan.unitCollection.updateEnt(shipped);

		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan keeps going");
		assert.equal(plan.state, "completing", "still completing");
	});

	it("lets blocked units finish their forced order, but not past the deadline", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "completing";
		plan.maxCompletingTime = seconds(150);
		const blocked = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"],
		}, { unitAIOrderData: () => [{ "target": 5, "targetPos": [5, 5], "force": true }] },
		{ "plan": 1 }));
		plan.unitCollection.updateEnt(blocked);

		world.ai.elapsedTime = seconds(110);
		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan waits for the order");
		world.ai.elapsedTime = seconds(200);
		assert.equal(plan.updatePreparation(world.gameState), 2, "the deadline came, the plan starts");
	});

	it("starts again from scratch when the target died meanwhile", () =>
	{
		const world = makeWorld({ canBuildUnits: false, enemyPlayer: ENEMY });
		const deadTarget = makeTarget(world);
		const soldierMarches: unknown[][] = [];
		const plan = makePlan(world, { name: 1, init: true, data: { target: deadTarget } });
		plan.state = "completing";
		world.removeEntity(deadTarget.id());
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { moveToRange: recordMarches(soldierMarches) }));

		const picked = makeTarget(world, {}, 2001); // a fresh enemy centre at [30,40]
		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the plan completed its restart");
		});
		assert.equal(plan.target, picked, "a new target was picked");
		assert.equal(plan.state, "completing", "the plan is completing again");
		assert.deepEqual(soldierMarches, [[10, 10, 0, 15, false]], "the soldier marched to the rally point");
		assert.equal(world.ai.queues["plan_1"], undefined, "the plan queues are gone");
	});

	it("drops a unit from the plan while it is stuck on a transport", () =>
	{
		const world = makeWorld({ canBuildUnits: false, enemyPlayer: ENEMY });
		// the must-start step drops transported units; the non-carried one
		// marches on
		const carried = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1, "transport": 7 }));
		const marches: unknown[][] = [];
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		const target = makeTarget(world, {}, 2002);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the plan started");
		});
		assert.equal(carried.getMetadata(PLAYER, "plan"), -1, "the carried unit left the plan");
		assert.ok(marches.length > 0, "the free unit marched on");
		// the snapshot only loses the unit on the next tick
		assert.equal(plan.unitCollection.updateEnt(carried), true, "dropped from the snapshot on refresh");
	});

	it("collects units that were part of a temporary bombing attack", () =>
	{
		const world = makeWorld({ canBuildUnits: false, enemyPlayer: ENEMY });
		const marches: unknown[][] = [];
		const bomber = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		const target = makeTarget(world, {}, 2003);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		// the bomber and one more unit sent against an enemy tower
		const tower = entityId(2050);
		const bombing = new Map([[tower, new Set([bomber.id(), entityId(9999)])]]);
		world.ai.HQ.attackManager.bombingAttacks = bombing;

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the plan started");
		});
		assert.deepEqual([...bombing.get(tower) ?? []], [9999], "the bomber was taken out of the list");
		assert.ok(marches.length > 0, "the free unit marched on");
	});
});

describe("updatePreparation: unexecuted plans", () =>
{
	it("waits for transport ships before assigning any unit", () =>
	{
		const world = makeWorld();
		registerSpearman(world);
		world.knobs.bestTrainable = "units/athen_spearman";
		const target = makeTarget(world, { foundationProgress: () => 60 }, 2004);
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });
		plan.overseas = seaRegion(4);
		// three fast soldiers: a raid leaves two for the hunt
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}));

		assert.equal(plan.updatePreparation(world.gameState), 1, "no ships, keep going");
		for (const soldier of world.units)
			assert.equal(soldier.getMetadata(PLAYER, "plan"), undefined, "nothing was assigned yet");

		world.ai.HQ.navalManager.seaTransportShips[4] = collectionOf(world, [world.addEntity(makeEntity({
			id: 5000, owner: PLAYER, position: [5, 5], classes: ["Unit", "Ship"]
		}))]);
		assert.equal(plan.updatePreparation(world.gameState), 1, "with ships, the plan keeps preparing");
		const assigned = world.units.filter((soldier) => soldier.getMetadata(PLAYER, "plan") != undefined);
		assert.equal(assigned.length, 1, "only the third fast soldier joined");
	});

	it("aborts when the population is full and the plan has nothing", () =>
	{
		const world = makeWorld({ population: 396, populationMax: 400 });
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.updatePreparation(world.gameState), 0, "the plan aborts");
		assert.equal(plan.state, "unexecuted", "still listed as unexecuted");
	});

	it("pushes on when the population is full but the crowd is big enough", () =>
	{
		const world = makeWorld({ population: 396, populationMax: 400 });
		const target = makeTarget(world);
		const marches: unknown[][] = [];
		// twenty fast-moving units: no category is at min size, but the
		// crowd passes the length rule
		for (let i = 0; i < 20; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the plan pushed on");
		});
		assert.equal(plan.state, "completing", "the plan started completing");
		assert.ok(marches.length > 0, "the crowd marched");
	});

	it("waits while the queued units finish training", () =>
	{
		const world = makeWorld({ canBuildUnits: false });
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		world.knobs.queuedInTraining = 2;

		assert.equal(plan.mustStart(), true, "the units are here");
		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan waits");
		assert.equal(plan.state, "unexecuted", "and keeps waiting");
		world.knobs.queuedInTraining = 0;
	});

	it("keeps training as long as there is time, and aborts when there is nothing left", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });

		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan trains on");
		assert.equal(plan.unitStat.RangedInfantry, undefined, "its first category was dropped for lack of a trainer");
		assert.equal(plan.siegeState, 1, "siege has no trainer either");
		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan trains on");
		assert.equal(plan.unitStat.MeleeInfantry, undefined, "the next category was dropped");
		assert.equal(plan.updatePreparation(world.gameState), 0, "no orders left, the plan aborts");
	});

	it("force-starts a huge crowd with siege units and enemies about", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world);
		// a crowd of 21 with the siege unit among them, all pre-mustered
		for (let i = 0; i < 21; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "Infantry", "Melee", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1100, owner: PLAYER, position: [11, 12], classes: ["Unit", "Siege"]
		}, { attackTypes: () => undefined }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });

		assert.equal(plan.unitCollection.length, 22, "the crowd is in");
		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the plan completed");
		});
		assert.equal(plan.forced, true, "the plan was force-started");
		for (const cat in plan.unitStat)
			assert.equal(plan.unitStat[cat].targetSize, 0, cat + " is no longer wanted in sizes");
	});

	it("hands a fast soldier to a raid being prepared", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"]
		}, { attackTypes: () => undefined }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		const raid = makePlan(world, { name: 42, type: "Raid", init: true });
		world.ai.HQ.attackManager.getAttackInPreparation = (type: string) => type === "Raid" ? raid : undefined;

		assert.equal(plan.unitCollection.length, 1, "the soldier is in the crowd");
		assert.equal(plan.updatePreparation(world.gameState), 1, "the plan keeps preparing");
		assert.equal(world.units[0].getMetadata(PLAYER, "plan"), 42, "the soldier left for the raid");
	});

	it("leaves the units of a forced raid alone", () =>
	{
		const world = makeWorld();
		registerSpearman(world);
		world.knobs.bestTrainable = "units/athen_spearman";
		const plan = makePlan(world, { name: 1, type: "Raid", init: true });
		plan.forced = true;
		const fastSoldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"]
		}, { attackTypes: () => undefined }));

		assert.equal(plan.updatePreparation(world.gameState), 1, "the raid keeps preparing");
		assert.equal(fastSoldier.getMetadata(PLAYER, "plan"), undefined, "the soldier was left alone");
	});

	it("starts a raid once enough fast units are here and the foundation grows", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world);
		target.foundationProgress = () => 60;
		const marches: unknown[][] = [];
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the raid starts completing");
		});
		assert.equal(plan.state, "completing", "the raid is completing");
		assert.equal(plan.maxCompletingTime, 100 + 20, "a raid has twenty seconds to complete");
		assert.ok(marches.length > 0, "the fighters marched");
	});

	it("waits on a raid whose foundation is still fresh", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world);
		target.foundationProgress = () => 20;
		registerSpearman(world);
		world.knobs.bestTrainable = "units/athen_spearman";
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });

		assert.equal(plan.updatePreparation(world.gameState), 1, "the raid waits");
		assert.equal(plan.mustStart(), false, "the foundation is too fresh");
	});
});

describe("obstructions along the path", () =>
{
	/** An enemy structure answering the serialized obstruction queries. */
	function makeObstacle(world: World, id: number, at: [number, number], queries: Record<string, unknown>, classes: string[] = ["Structure"]): CommonEntity
	{
		return world.addEntity(makeEntity({
			id, owner: ENEMY, position: at, classes
		}, { get: (path: string) => queries[path] }));
	}

	it("returns the target unchanged when the lands differ", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true });
		world.accessAt.set("40,45", 3);

		let pathCalls = 0;
		stubEngine("ComputePath", () => { ++pathCalls; return []; });
		try
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(40, 45)), target,
				"a target across water is kept as-is");
		}
		finally
		{
			restoreEngine();
		}
		assert.equal(pathCalls, 0, "no path was computed");
	});

	it("gives up when the path is empty", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true });

		withPath([], () =>
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), undefined,
				"an unreachable target is rejected");
		});
		assert.equal(plan.isBlocked, false, "not blocked, unreachable");
	});

	it("is blocked by a static wall standing on the path", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeObstacle(world, 2100, [12, 30],
			{ "Obstruction": 1 }, ["Structure", "Field"]));
		const wall = world.addEntity(makeObstacle(world, 2101, [12, 30],
			{ "Obstruction": 1, "Obstruction/Static": 1, "Obstruction/Static/@width": "4", "Obstruction/Static/@depth": "4" }));
		wall.angle = () => Math.PI / 2;
		const plan = makePlan(world, { name: 1, init: true });

		withPath([{ "x": 12, "y": 30 }, { "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), wall,
				"the wall stands in the way");
		});
		assert.equal(plan.isBlocked, true, "the plan knows it is blocked");
		plan.isBlocked = false;
	});

	it("is blocked by a gate whose passage the path crosses", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const gate = world.addEntity(makeObstacle(world, 2100, [20, 25],
			{
				"Obstruction": 1, "Obstruction/Obstructions": 1,
				"Obstruction/Obstructions/Door/@width": "4", "Obstruction/Obstructions/Door/@depth": "2",
				"Obstruction/Obstructions/Left/@width": "0", "Obstruction/Obstructions/Left/@depth": "0",
				"Obstruction/Obstructions/Right/@width": "0", "Obstruction/Obstructions/Right/@depth": "0"
			}, ["Structure", "Gate"]));
		gate.angle = () => Math.PI / 2;
		const plan = makePlan(world, { name: 1, init: true });

		// the path runs from below the gate up to the target, crossing it
		withPath([{ "x": 30, "y": 42 }, { "x": 10, "y": 10 }], () =>
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), gate,
				"the crossed gate blocks the path");
		});
		assert.equal(plan.isBlocked, true, "gates block too");
		plan.isBlocked = false;
	});

	it("is blocked by a gate front that the path pierces", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const gate = world.addEntity(makeObstacle(world, 2100, [20, 25],
			{
				"Obstruction": 1, "Obstruction/Obstructions": 1,
				"Obstruction/Obstructions/Door/@width": "4", "Obstruction/Obstructions/Door/@depth": "2",
				"Obstruction/Obstructions/Left/@width": "2", "Obstruction/Obstructions/Left/@depth": "4",
				"Obstruction/Obstructions/Right/@width": "2", "Obstruction/Obstructions/Right/@depth": "4"
			}, ["Structure", "Gate"]));
		gate.angle = () => Math.PI / 2;
		const plan = makePlan(world, { name: 1, init: true });

		// the first waypoint already sits inside the gate's footprint once
		// the extra clearance step towards the target is taken
		withPath([{ "x": 21, "y": 25 }, { "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), gate,
				"the gate front blocked the path");
		});
		assert.equal(plan.isBlocked, true, "gate fronts block too");
		plan.isBlocked = false;
	});

	it("is blocked by a lone unit obstruction on the path", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const blocker = world.addEntity(makeObstacle(world, 2100, [12, 30],
			{ "Obstruction": 1, "Obstruction/Unit": 1, "Obstruction/Unit/@radius": "5" }));
		const plan = makePlan(world, { name: 1, init: true });

		withPath([{ "x": 12, "y": 30 }, { "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), blocker,
				"the unit obstruction blocks the path");
		});
		plan.isBlocked = false;
	});

	it("builds the path and re-rallies at our border but behind a danger", () =>
	{
		const world = makeWorld({
			territory: new Map([
				["10,10", PLAYER], ["12,12", PLAYER], ["14,14", PLAYER],
				["24,26", ENEMY], ["30,40", ENEMY]
			])
		});
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		// a dangerous spot near the border: the rally retreats a waypoint
		world.ai.HQ.isDangerousLocation = (gameState: CommonGameState, pos: [number, number], minDist: number) =>
			minDist === 20 && Math.round(pos[0]) === 14;

		withPath([{ "x": 24, "y": 26 }, { "x": 14, "y": 14 }, { "x": 12, "y": 12 }], () =>
		{
			assert.equal(plan.getPathToTarget(world.gameState), true, "the path was built");
		});
		assert.deepEqual(plan.path, [[12, 12], [14, 14], [24, 26], [30, 40]],
			"the rally was cut back to before the danger");
		assert.deepEqual(plan.rallyPoint, [12, 12], "the rally hides behind the danger");
	});

	it("re-rallies at the previous waypoint when it is safe", () =>
	{
		const world = makeWorld({
			territory: new Map([
				["10,10", PLAYER], ["12,12", PLAYER], ["14,14", PLAYER],
				["24,26", ENEMY], ["30,40", ENEMY]
			])
		});
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });

		withPath([{ "x": 24, "y": 26 }, { "x": 14, "y": 14 }, { "x": 12, "y": 12 }], () =>
		{
			assert.equal(plan.getPathToTarget(world.gameState), true, "the path was built");
		});
		assert.deepEqual(plan.path, [[14, 14], [24, 26], [30, 40]], "the safe part is kept");
		assert.deepEqual(plan.rallyPoint, [14, 14], "the rally sits at our border");
	});

	it("refuses a path across water", () =>
	{
		const world = makeWorld();
		const islandTarget = makeTarget(world, {}, 2006);
		world.accessAt.set("30,40", 3);
		const plan = makePlan(world, { name: 1, init: true, data: { target: islandTarget } });

		assert.equal(plan.getPathToTarget(world.gameState), false, "no path across water");
		assert.ok(plan.path === undefined || plan.path.length === 0, "nothing was built");
	});
});

describe("starting the attack", () =>
{
	it("marches the whole collection when target and rally share the land", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		for (let i = 0; i < 2; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
			}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts

		withPath([{ "x": 32, "y": 44 }], () =>
		{
			assert.equal(plan.getPathToTarget(world.gameState, true), true, "the path was built");
			assert.equal(plan.StartAttack(world.gameState), true, "the attack began");
		});
		assert.equal(plan.state, "walking", "the plan marches");
		assert.equal(plan.overseas, 0, "no shipping needed");
		for (const unit of world.units)
			assert.equal(unit.getMetadata(PLAYER, "subrole"), "walking", "the troops march on");
		assert.deepEqual(plan.path, [[10, 10], [32, 44], [30, 40]], "rally, waypoints, target");
		const walk = sent("walk-to-range");
		assert.equal(walk.length, 1, "one march order");
		assert.deepEqual(walk[0]?.["entities"], [1010, 1011], "the whole collection marched");
		resetRecorder();
	});

	it("ships the troops when the target is overseas", () =>
	{
		const world = makeWorld({ sea: 4 });
		const islandTarget = makeTarget(world, {}, 2006);
		world.accessAt.set("30,40", 3);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target: islandTarget } });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts

		assert.equal(plan.StartAttack(world.gameState), true, "the attack began");
		assert.equal(plan.state, "transporting", "the plan ships");
		assert.equal(plan.overseas, 4, "over sea 4");
		assert.deepEqual(world.transportCalls.map(([ent]) => ent.id()), [1010], "each unit asked for shipping");
	});

	it("aborts when the sea level is unknown", () =>
	{
		const world = makeWorld({ sea: undefined });
		const islandTarget = makeTarget(world, {}, 2006);
		world.accessAt.set("30,40", 3);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target: islandTarget } });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts

		assert.equal(plan.StartAttack(world.gameState), false, "no sea, no attack");
	});

	it("stands ground with packable troops", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const packable = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { isPackable: () => true, getStance: () => "passive" }, { "plan": 1 }));
		const stances: string[] = [];
		override(packable, { "setStance": (stance: string) => stances.push(stance) });
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts

		withPath([{ "x": 32, "y": 44 }], () =>
		{
			assert.equal(plan.getPathToTarget(world.gameState, true), true, "the path was built");
			assert.equal(plan.StartAttack(world.gameState), true, "the attack began");
		});
		assert.deepEqual(stances, ["standground"], "packable units stand ground");
	});

	it("falls back to picking a target whose owner died", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts
		plan.target = undefined;
		plan.targetPlayer = undefined;
		plan.path = [worldPos(10, 10), worldPos(30, 40)];

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.StartAttack(world.gameState), true, "the attack began");
		});
		assert.equal(plan.target, target, "the civil centre was picked");
		assert.equal(plan.targetPlayer, ENEMY, "against the right player");
	});

	it("refuses to start when no target remains", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.removeEntity(target.id());
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts

		assert.equal(plan.StartAttack(world.gameState), false, "nothing to attack");
		assert.equal(plan.state, "completing", "it stays where it was, regrouping");
	});
});

describe("updating an executing plan", () =>
{
	it("closes down when the army is gone", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		assert.equal(plan.update(world.gameState, emptyEvents()), 0, "nothing left to command");
	});

	it("turns an arrived cohort into an attacking one", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		for (let i = 0; i < 2; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
			}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "arrived";

		const result = plan.update(world.gameState, emptyEvents());
		assert.equal(result, 2, "the cohort size is kept");
		for (const unit of world.units)
			assert.equal(unit.getMetadata(PLAYER, "subrole"), "attacking", "ordered to attack");
	});

	it("sends an idle unit against the enemy in reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20],
			classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true, isIdle: () => true }, { "plan": 1 }));
		const enemy = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [15, 15], classes: ["Unit", "Melee"]
		}));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const me = world.ents.get(1010)!;
		const strikes: unknown[][] = [];
		override(me, { "attack": (targetId: unknown, capture: unknown) =>
			strikes.push([targetId, capture]) });

		const result = plan.update(world.gameState, emptyEvents());
		assert.equal(result, 1, "the unit is kept");
		assert.equal(enemy.id(), 3000, "the enemy was registered");
		assert.equal(strikes.length, 1, "one strike order");
		assert.deepEqual(strikes[0], [3000, false], "the idle unit struck the enemy");
		assert.equal(world.ents.get(1010)?.getMetadata(PLAYER, "lastAttackPlanUpdateTime"),
			world.ai.elapsedTime, "recorded at this turn");
		resetRecorder();
	});

	it("sends a distant unit closer with an attack move", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [80, 60], classes: ["Unit", "Melee", "Infantry"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true, isIdle: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const me = world.ents.get(1010)!;
		const marches: unknown[][] = [];
		override(me, { "attackMove": (x: unknown, z: unknown, classes: Record<string, unknown>) =>
			marches.push([x, z, classes]) });

		const result = plan.update(world.gameState, emptyEvents());
		assert.equal(result, 1, "the unit is kept");
		assert.equal(marches.length, 1, "one attack move");
		assert.deepEqual(marches[0]?.slice(0, 2), [30, 40], "toward the target");
		assert.deepEqual((marches[0]?.[2] as Record<string, unknown>).avoid,
			["Palisade", "Wall", "Fortress", "Ship"], "walls and ships avoided");
	});

	it("retaliates against the fortress that besieged a farm-watcher", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const fortress = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [25, 25],
			classes: ["Structure", "Fortress", "ConquestCritical"]
		}));
		world.addEntity(makeEntity({
			id: 3001, owner: ENEMY, position: [28, 28], classes: ["Structure", "Field"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Ranged"]
		}, {
			attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 60 }),
			canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3001, "targetPos": [28, 28] }]
		}, { "plan": 1, "lastAttackPlanUpdateTime": 80 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const me = world.ents.get(1010)!;
		const strikes: unknown[][] = [];
		override(me, { "attack": (targetId: unknown, capture: unknown) =>
			strikes.push([targetId, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		const result = plan.update(world.gameState, events);
		assert.equal(result, 1, "the unit is kept");
		assert.equal(strikes.length, 1, "one strike against the blocker");
		assert.deepEqual(strikes[0], [fortress.id(), false], "the fortress itself");
		assert.equal(world.ents.get(1010)?.getMetadata(PLAYER, "lastAttackPlanUpdateTime"), 100, "remarked");
	});

	it("cuts down a hunter that stays nearby and menacing", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const hunter = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [25, 25], classes: ["Unit", "Melee"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"],
			canAttackTarget: () => true
		}, { "plan": 1, "lastAttackPlanUpdateTime": 80 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const me = world.ents.get(1010)!;
		const strikes: unknown[][] = [];
		override(me, { "attack": (targetId: unknown, capture: unknown) =>
			strikes.push([targetId, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		const result = plan.update(world.gameState, events);
		assert.equal(result, 1, "the unit is kept");
		// the helper pass and the retaliation both land on the hunter
		assert.equal(strikes.length, 2, "two strikes");
		assert.deepEqual(strikes, [[hunter.id(), false], [hunter.id(), false]], "the hunter was cut down");
		assert.equal(world.ents.get(1010)?.getMetadata(PLAYER, "lastAttackPlanUpdateTime"), 100, "remarked");
	});
});

describe("walks and transports during execution", () =>
{
	it("strikes back from the shore while shipping is in progress", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1, "transport": 7 }));
		const shooter = world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [13, 14], classes: ["Unit", "Melee"]
		}, { isIdle: () => true, canAttackTarget: () => true }, { "plan": 1 }));
		const hunter = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [15, 15], classes: ["Unit", "Melee"]
		}));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "transporting";
		const strikes: unknown[][] = [];
		override(shooter, { "attack": (targetId: unknown, capture: unknown) => strikes.push([targetId, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1011), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		assert.equal(plan.state, "transporting", "still shipping");
		assert.deepEqual(strikes, [[hunter.id(), false]], "the shore unit struck back");
		assert.deepEqual(plan.lastPosition, [12, 13], "the position was remembered");
	});

	it("declares itself at the destination once all transports land", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		for (let i = 0; i < 2; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11 + i, 12], classes: ["Unit", "Melee"]
			}, {}, { "plan": 1, "transport": 7 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "transporting";
		assert.equal(plan.update(world.gameState, emptyEvents()), 2, "still not landed");

		// the transports are cleared once the ships land
		for (const unit of world.units)
			unit.setMetadata(PLAYER, "transport", undefined);

		const result = plan.update(world.gameState, emptyEvents());
		assert.equal(result, 2, "the cohort is kept");
		for (const unit of world.units)
			assert.equal(unit.getMetadata(PLAYER, "subrole"), "attacking", "ordered to attack");
	});

	it("advances to the next waypoint when one is reached", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.targetPos = worldPos(30, 120); // far enough to keep marching
		plan.lastPosition = worldPos(50, 50);
		plan.path = [worldPos(11, 12), worldPos(20, 20), worldPos(30, 118)];

		const result = plan.update(world.gameState, emptyEvents());
		assert.equal(result, 1, "the unit is kept");
		const walks = sent("walk-to-range");
		assert.equal(walks.length, 1, "one march order");
		assert.equal(walks[0]?.["x"], 20, "toward the next waypoint");
		assert.equal(walks[0]?.["z"], 20, "east of nothing");
		assert.deepEqual(plan.path[0], [20, 20], "the reached waypoint was dropped");
		resetRecorder();
	});

	it("destroys a siege machine too stuck to move", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Siege"]
		}, { destroy: () => destroyed.push(1011) }, { "plan": 1 }));
		const destroyed: number[] = [];
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(11, 12);
		plan.position5TurnsAgo = worldPos(11, 12);
		plan.path = [worldPos(12, 12)];
		world.ai.playedTurn = 5;

		const result = plan.update(world.gameState, emptyEvents());
		// the plan considers itself arrived and switches to attacking
		assert.equal(result, 2, "the cohort is kept");
		assert.deepEqual(destroyed, [1011], "the siege machine was scrapped");
		for (const unit of world.units)
			assert.equal(unit.getMetadata(PLAYER, "subrole"), "attacking", "ordered to attack");
		const walks = sent("walk");
		assert.equal(walks.length, 2, "one march command per survivor");
		resetRecorder();
	});

	// only the port passes: the original filters walls with byClass(...),
	// which never matches an array and so never finds one
	it("moves in with the wall-breaking crew", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [13, 13], classes: ["Structure", "Palisade"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { canAttackClass: (cls: string) => cls === "Palisade" }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(11, 12);
		plan.targetPos = worldPos(30, 120);
		plan.path = [worldPos(11, 12), worldPos(20, 20)];

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the unit is kept");
		for (const unit of world.units)
			assert.equal(unit.getMetadata(PLAYER, "subrole"), "attacking", "the crew moves in");
	});

	// only the port passes: like above, only the port finds the walls it
	// cannot break (filters.byClass vs byClasses)
	it("gives up in front of walls it cannot break", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [13, 13], classes: ["Structure", "Palisade"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { canAttackClass: () => false }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(11, 12);
		plan.targetPos = worldPos(30, 120);
		plan.path = [worldPos(11, 12), worldPos(20, 20)];

		assert.equal(plan.update(world.gameState, emptyEvents()), 0, "the plan dissolved");
		assert.equal(plan.state, "walking", "still walking... nowhere");
	});

	it("reaches the destination when the units come under repeated fire", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const hunter = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [15, 15], classes: ["Unit", "Melee"]
		}));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.targetPos = worldPos(30, 120);
		plan.lastPosition = worldPos(50, 50);
		const events = emptyEvents();
		for (let i = 0; i < 4; ++i)
			events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		const result = plan.update(world.gameState, events);
		assert.equal(result, 1, "the unit is kept");
		assert.ok(hunter, "the hunter was there");
		for (const unit of world.units)
			if (unit.owner() === PLAYER)
				assert.equal(unit.getMetadata(PLAYER, "subrole"), "attacking", "the plan is at the destination");
	});
});

describe("chasing a target during execution", () =>
{
	it("follows a unit target that moves", () =>
	{
		const world = makeWorld();
		const prey = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [25, 25], classes: ["Unit", "Melee"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target: prey } });
		plan.position = worldPos(11, 12);
		const moving = world.ents.get(3000)!;
		moving.position = (() => [42, 42]) as never;

		assert.equal(plan.UpdateTarget(world.gameState), true, "the target is kept");
		assert.deepEqual(plan.targetPos, [42, 42], "the chase followed");
	});

	it("picks the next centre when its target died", () =>
	{
		const world = makeWorld();
		const deadTarget = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const next = makeTarget(world, {}, 2006);
		const plan = makePlan(world, { name: 1, init: true, data: { target: deadTarget } });
		plan.position = worldPos(11, 12);
		world.removeEntity(deadTarget.id());

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.UpdateTarget(world.gameState), true, "a new target was picked");
		});
		assert.equal(plan.target, next, "the next centre");
		assert.deepEqual(plan.targetPos, [30, 40], "at its place");
	});

	it("concedes when nothing remains on the map", () =>
	{
		const world = makeWorld();
		const deadTarget = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target: deadTarget } });
		plan.position = worldPos(11, 12);
		world.removeEntity(deadTarget.id());

		assert.equal(plan.UpdateTarget(world.gameState), false, "nothing left to chase");
	});

	it("siege units go for the gates first", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			isIdle: () => true,
			attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 60 }),
			canAttackTarget: () => true,
			canAttackClass: (cls: string) => cls === "Wall"
		}, { "plan": 1 }));
		const gate = world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [22, 22], classes: ["Structure", "Gate"]
		}, { costSum: () => 300 }));
		world.addEntity(makeEntity({
			id: 2011, owner: ENEMY, position: [24, 24],
			classes: ["Structure", "Fortress", "ConquestCritical"]
		}));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (targetId: unknown, capture: unknown) =>
			strikes.push([targetId, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the unit is kept");
		assert.deepEqual(strikes, [[gate.id(), false]], "the gate was the first target");
	});

	it("switches targets when the old one is renamed", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const renamed = makeTarget(world, {}, 2501);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(2005), "newentity": entityId(2501) });
		plan.checkEvents(world.gameState, events);
		assert.equal(plan.target, renamed, "the renamed centre is tracked");
		assert.deepEqual(plan.targetPos, [30, 40], "at its place");
	});

	it("drops the target of an unstarted raid when it is renamed", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		makeTarget(world, {}, 2501);
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });

		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(2005), "newentity": entityId(2501) });
		plan.checkEvents(world.gameState, events);
		assert.equal(plan.target, undefined, "an unstarted raid loses its predefined target");
	});

	it("forgets a captured target", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		(world.gameState.playerData).isAlly[PLAYER] = true;

		const events = emptyEvents();
		events.OwnershipChanged.push({ "entity": entityId(2005), "from": ENEMY, "to": PLAYER });
		plan.checkEvents(world.gameState, events);
		assert.equal(plan.target, undefined, "an allied capture ends the chase");
	});

	it("switches to the next enemy when its prey resigns", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		world.ai.HQ.attackManager.getEnemyPlayer = (gameState: CommonGameState, thisPlan: unknown) => playerId(3);

		const events = emptyEvents();
		events.PlayerDefeated.push({ "playerId": ENEMY });
		plan.checkEvents(world.gameState, events);
		assert.equal(plan.targetPlayer, 3, "the next enemy on the list");
		assert.equal(plan.target, undefined, "until a new one is picked");
	});

	it("sees when an opponent settles on the plan's island", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, type: "Raid", init: true });
		plan.overseas = seaRegion(4);

		const islander = world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [30, 40], classes: ["Structure", "CivCentre"]
		}));
		const events = emptyEvents();
		events.Create.push({ "entity": entityId(2010) });
		plan.checkEvents(world.gameState, events);
		assert.equal(plan.overseas, 0, "no shipping needed any more");
		assert.ok(islander, "the islander was there");
	});
});

describe("wrapping up a plan", () =>
{
	// the army is at sea, so it has no position (getCentrePosition finds no
	// unit with one), when the attack manager aborts it because its target
	// player was defeated: the troops are still released and the queues go
	it("releases an army aboard ships, with no place to withdraw to", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "transporting";
		plan.position = undefined;
		const sailor = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, classes: ["Unit", "Melee", "CitizenSoldier"]
		}, {}, { "plan": 1, "role": "attack", "transport": 3 }));
		plan.unitCollection.updateEnt(sailor);
		const marches: unknown[] = [];
		override(sailor, { "moveToRange": (x: unknown) => marches.push(x) });

		plan.Abort(world.gameState);
		assert.deepEqual(marches, [], "no withdrawal march from the ship");
		assert.equal(sailor.getMetadata(PLAYER, "plan"), -1, "the sailor left the plan");
		assert.equal(sailor.getMetadata(PLAYER, "role"), "worker", "and went back to work");
		assert.equal(world.ai.queues["plan_1"], undefined, "the queues went away");
	});

	it("withdraws the troops to the nearest anchor", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "walking";
		plan.position = worldPos(18, 18);
		plan.rallyPoint = worldPos(5, 5);
		const soldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [17, 17], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, {}, { "plan": 1, "role": "attack" }));
		const hero = world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [19, 19], classes: ["Unit", "Hero"]
		}, {}, { "plan": 1, "role": "attack" }));
		plan.unitCollection.updateEnt(soldier);
		plan.unitCollection.updateEnt(hero);

		const marches: number[] = [];
		override(soldier, { "moveToRange": (x: number) => marches.push(x) });
		override(hero, { "moveToRange": (x: number) => marches.push(x) });
		plan.Abort(world.gameState);
		assert.deepEqual(marches, [10, 10], "both troops marched back to our anchor");
		assert.deepEqual(soldier.getMetadata(PLAYER, "role"), "worker", "civilians gathered home");
		assert.equal(hero.getMetadata(PLAYER, "role"), undefined, "others dropped the role");
		assert.deepEqual(soldier.getMetadata(PLAYER, "plan"), -1, "and left the plan");
		resetRecorder();
	});

	it("a mercenary leaving the attack goes back to no role, not to work it cannot do", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		const mercenary = world.addEntity(makeEntity({
			id: 1012, owner: PLAYER, position: [17, 17], classes: ["Unit", "Ranged", "CitizenSoldier", "Worker", "Mercenary"]
		}, {}, { "plan": 1, "role": "attack", "subrole": "attacking" }));
		plan.unitCollection.updateEnt(mercenary);

		plan.Abort(world.gameState);

		assert.equal(mercenary.getMetadata(PLAYER, "role"), undefined);
		assert.equal(mercenary.getMetadata(PLAYER, "plan"), -1, "and left the plan");
		resetRecorder();
	});

	it("withdraws to the ground around the anchor, not into its footprint", () =>
	{
		// a civic centre's footprint (30 by 30 for the athenians) reaches 21.2 from
		// its centre: a march to within 15 of the centre ends inside the building,
		// which no unit can reach, so the army would walk on for good
		const world = makeWorld();
		override(world.bases[0].anchor!, { "obstructionRadius": () => ({ "min": 15, "max": 21.2 }) });
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "walking";
		plan.position = worldPos(18, 18);
		plan.rallyPoint = worldPos(60, 60);
		const soldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [17, 17], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, {}, { "plan": 1, "role": "attack" }));
		plan.unitCollection.updateEnt(soldier);
		const marches: number[][] = [];
		override(soldier, { "moveToRange": (x: number, z: number, min: number, max: number) => marches.push([x, z, min, max]) });

		plan.Abort(world.gameState);

		assert.equal(marches.length, 1);
		const [x, z, min, max] = marches[0];
		assert.deepEqual([x, z], [10, 10], "to the nearest anchor");
		assert.ok(min <= 21.2 && max > 21.2 + 5, `the ring [${min}, ${max}] reaches out past the footprint`);
		resetRecorder();
	});

	it("withdraws to within 15 of an open rally point", () =>
	{
		const world = makeWorld();
		world.bases.length = 0;
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "walking";
		plan.position = worldPos(18, 18);
		plan.rallyPoint = worldPos(60, 60);
		const soldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [17, 17], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, {}, { "plan": 1, "role": "attack" }));
		plan.unitCollection.updateEnt(soldier);
		const marches: number[][] = [];
		override(soldier, { "moveToRange": (x: number, z: number, min: number, max: number) => marches.push([x, z, min, max]) });

		plan.Abort(world.gameState);

		assert.deepEqual(marches, [[60, 60, 0, 15]]);
		resetRecorder();
	});

	it("clears the plans of a never-started attack", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		const soldier = world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [17, 17], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1, "role": "attack" }));

		plan.unitCollection.updateEnt(soldier);
		plan.Abort(world.gameState);
		assert.equal(commands.length, 0, "no march for a plan that never left");
		assert.deepEqual(soldier.getMetadata(PLAYER, "plan"), -1, "the troops are free");
		assert.equal(world.ai.queues["plan_1"], undefined, "the queues went away");
	});

	it("reads the access of the nearest unit, not the centre", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [40, 45], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		world.accessAt.set("40,45", 3);
		plan.position = worldPos(40, 45);

		assert.equal(plan.getAttackAccess(world.gameState), 3, "the island the troops stand on");
	});

	it("reads no access for an army with no unit ashore", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, classes: ["Unit", "Melee"]
		}, {}, { "plan": 1, "transport": 3 }));
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = undefined;

		assert.equal(plan.getAttackAccess(world.gameState), 0, "no unit ashore, no land");
	});

	it("reports the marching numbers for debugging", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.Config.debug = 4;
		resetRecorder();
		plan.debugAttack();
		assert.ok(logs.some((entry) => entry.includes("---------- attack 1")), "the plan was named");
		assert.ok(logs.some((entry) => entry.includes("num=0")), "its numbers were shown");
	});

	it("serializes and restores its whole state", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.path = [worldPos(10, 10), worldPos(30, 40)];
		plan.position = worldPos(11, 12);
		plan.overseas = 0;

		const data = plan.Serialize();
		assert.equal(data.properties.name, 1, "the plan name");
		assert.equal(data.properties.state, "walking", "the plan state");
		assert.equal(data.properties.target, 2005, "the target id");
		assert.deepEqual(data.properties.path, plan.path, "the path");

		const revived = makePlan(world, { name: 42, type: "HugeAttack" });
		revived.Deserialize(world.gameState, data);
		assert.equal(revived.name, 1, "the name was restored");
		assert.equal(revived.target, target, "the live target came back");
		assert.deepEqual(revived.targetPos, [30, 40], "at its place");
		assert.deepEqual(revived.failed, undefined, "a fresh failure record");
		assert.equal(revived.type, "Attack", "the plan type came back too");
	});

	// only the port passes: the original restores any saved string as the
	// state; a started plan in a state update() does not know then does
	// nothing more
	it("prepares again when its save names no state it knows", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		const data = plan.Serialize();
		data.properties.state = "charging";

		const revived = makePlan(world, { name: 2 });
		logs.length = 0;
		revived.Deserialize(world.gameState, data);
		assert.equal(revived.state, "unexecuted");
		assert.ok(logs.some((entry) => entry.includes("unknown state \"charging\"")), "the save was refused aloud");
	});
});

describe("rare target finders", () =>
{
	it("hunts the one enemy the unique target names", () =>
	{
		const world = makeWorld();
		const tower = makeTarget(world);
		const plan = makePlan(world, { name: 1, data: { target: tower, uniqueTargetId: entityId(2000) } });

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			const found = plan.getNearestTarget(world.gameState, worldPos(20, 20));
			assert.equal(found, tower, "the named target came back");
		});
	});

	it("finds nothing when the unique target is already gone", () =>
	{
		const world = makeWorld();
		const tower = makeTarget(world);
		const plan = makePlan(world, { name: 1, data: { target: tower, uniqueTargetId: entityId(2000) } });
		world.removeEntity(2000);

		assert.equal(plan.getNearestTarget(world.gameState, worldPos(20, 20)), undefined,
			"the vanished target was not revived");
	});

	it("bails out in mid-attack when the unique target vanished", () =>
	{
		const world = makeWorld({ debug: 2 });
		const tower = makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true, data: { target: tower, uniqueTargetId: entityId(2000) } });
		world.removeEntity(2000);
		plan.position = worldPos(11, 12);
		resetRecorder();

		assert.equal(plan.UpdateTarget(world.gameState), false, "there is nowhere else to go");
		assert.ok(logs.some((entry) => /Seems like our target for plan 1/.test(entry)),
			"the switching warning was logged");
	});

	it("falls down the conquest ladder to the town buildings", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [30, 40], classes: ["Structure", "Town"]
		}));
		const plan = makePlan(world, { name: 1 });

		const targets = plan.defaultTargetFinder(world.gameState, ENEMY);
		assert.deepEqual([...targets.values()].map((ent) => ent.id()), [2001],
			"the town building was the last resort");
	});

	it("falls down the conquest ladder to villages", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [30, 40], classes: ["Structure", "Village"]
		}));
		const plan = makePlan(world, { name: 1 });

		const targets = plan.defaultTargetFinder(world.gameState, ENEMY);
		assert.deepEqual([...targets.values()].map((ent) => ent.id()), [2001],
			"the village building was the last resort");
	});

	it("falls down the conquest ladder to plain conquest-critical units", () =>
	{
		const world = makeWorld();
		const hero = world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [30, 40], classes: ["Unit", "Hero", "ConquestCritical"]
		}));
		const plan = makePlan(world, { name: 1 });

		const targets = plan.defaultTargetFinder(world.gameState, ENEMY);
		assert.deepEqual([...targets.values()].map((ent) => ent.id()), [hero.id()],
			"the hero was the last resort");
	});

	it("searches every player's buildings when a rush has no chosen enemy", () =>
	{
		const world = makeWorld();
		// our own centre is nearer, but it is no enemy building
		const house = world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [30, 40], classes: ["Structure", "Village", "House"]
		}));
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });

		const targets = plan.rushTargetFinder(world.gameState);
		assert.deepEqual([...targets.values()].map((ent) => ent.id()), [house.id()],
			"the lone enemy house was found without a player filter");
	});
});

describe("difficulties, dumps and init corners", () =>
{
	it("carries on when an island structure's sea is unknown and no target was chosen", () =>
	{
		const world = makeWorld({ navalMap: true });
		world.removeEntity(1000);   // the loop of all structures breaks on the anchor otherwise
		world.addEntity(makeEntity({
			id: 1002, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee", "CitizenSoldier"]
		}));
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [50, 50], classes: ["Structure", "Tower"]
		}));
		world.accessAt.set("50,50", 3);   // the structure's island

		const plan = makePlan(world, { name: 1, type: "Attack" });

		assert.equal(plan.failed, undefined, "without a target there is no complaint");
		assert.equal(plan.overseas, 0, "and no crossing was planned");
		assert.deepEqual(world.minimalShipCalls, [], "no ships were asked for");
	});

	it("softens the queue priority at easy difficulty", () =>
	{
		const world = makeWorld({ difficulty: EASY });
		makePlan(world, { name: 2, deserialized: false });

		assert.equal(world.ai.queueManager.getPriority("plan_2"), 56, "the main queue is softened to 56");
		assert.equal(world.ai.queueManager.getPriority("plan_2_champ"), 57, "the champion queue trails one point");
		assert.equal(world.ai.queueManager.getPriority("plan_2_siege"), 56, "the siege queue keeps up");
	});

	it("keeps a deserialized plan's easy scaling exact and stable", () =>
	{
		const world = makeWorld({ difficulty: EASY });
		const plan = makePlan(world, { name: 2 });

		// a deserialized plan has no variation roll, but easy attacks still
		// shrink stably by the 0.6 factor: 16*0.6 rounds up to 10, 6*0.6 stays 4
		assert.equal(plan.unitStat.RangedInfantry.targetSize, 10, "the ranged infantry shrank predictably");
		assert.equal(plan.unitStat.FastMoving.targetSize, 4, "the fast movers shrank too");
		assert.equal(plan.unitStat.RangedInfantry.minSize, 6, "the min size only follows its target");
	});

	it("spells out the attack situation when aborting for lack of men", () =>
	{
		const world = makeWorld({ population: 396, populationMax: 400, debug: 2 });
		world.ai.HQ.attackManager.upcomingAttacks.Raid = [1, 2] as unknown as AttackPlan[];
		world.ai.HQ.attackManager.startedAttacks.Attack = [1] as unknown as AttackPlan[];
		resetRecorder();
		const plan = makePlan(world, { name: 1, init: true });

		assert.equal(plan.updatePreparation(world.gameState), 0, "the plan aborts");
		assert.ok(logs.some((entry) => /attacks upcoming: raid 2 rush 0/.test(entry)), "upcoming was logged");
		assert.ok(logs.some((entry) => /attacks started: .*attack 1/.test(entry)), "started was logged");
	});

	it("dumps the build order every fifty turns and keeps tied categories", () =>
	{
		const world = makeWorld({ debug: 2 });
		world.ai.playedTurn = 50;
		registerSpearman(world);
		world.knobs.bestTrainable = "units/athen_spearman";
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });
		resetRecorder();
		// two identical categories compare as a tie in the sort
		plan.buildOrders = [
			[0, ["Infantry"], plan.unitCollection, plan.unitStat.Infantry, "Infantry"],
			[6, ["Infantry"], plan.unitCollection, plan.unitStat.Infantry, "Infantry"]
		];

		plan.trainMoreUnits(world.gameState);

		assert.ok(logs.some((entry) => /======== build order for plan 1/.test(entry)), "the dump was logged");
		assert.ok(logs.some((entry) => /Infantry done 0/.test(entry)), "the tied category was dumped");
		assert.equal(plan.buildOrders.length, 2, "both orders survived");
		assert.equal(plan.queue.length(), 1, "the first was trained");
	});

	it("hands a completing islander to the fleet", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world);
		target.foundationProgress = () => 60;
		const marches: unknown[][] = [];
		for (let i = 0; i < 3; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12],
				classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		world.accessAt.set("40,45", 3);
		const islander = world.addEntity(makeEntity({
			id: 1013, owner: PLAYER, position: [40, 45],
			classes: ["Unit", "FastMoving", "CitizenSoldier"]
		}, { moveToRange: recordMarches(marches) }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.updatePreparation(world.gameState), 1, "the raid starts completing");
		});
		assert.equal(plan.state, "completing", "the raid is completing");
		assert.deepEqual(world.transportCalls, [[islander, 3, 2, plan.rallyPoint]],
			"the islander was handed to the navy");
		assert.equal(marches.length, 3, "the three mainlanders marched");
	});
});

describe("attacking miscellany", () =>
{
	it("waits out a turn when the troops lost their bearings", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, classes: ["Unit", "Melee", "CitizenSoldier"]
		}, undefined, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });

		assert.ok(plan.unitCollection.hasEntities(), "the unitless plan did gather its unit");
		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the census was returned untouched");
	});

	it("quits before it starts when no enemy remains", () =>
	{
		const world = makeWorld();   // getEnemyPlayer answers undefined
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, undefined, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "";

		assert.equal(plan.update(world.gameState, emptyEvents()), false, "the update bailed out");
	});

	it("re-points a rushing cohort at the nearer isolated house", () =>
	{
		const world = makeWorld();
		const centre = makeTarget(world);
		const house = world.addEntity(makeEntity({
			id: 2001, owner: ENEMY, position: [25, 25], classes: ["Structure", "Village", "House"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, undefined, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, type: "Rush", init: true, data: { target: centre } });
		plan.state = "arrived";

		withPath([{ "x": 25, "y": 25 }], () =>
		{
			assert.equal(plan.update(world.gameState, emptyEvents()), plan.unitCollection.length,
				"the census was returned");
		});
		assert.equal(plan.target, house, "the house nearer to the fighters was chosen");
		assert.deepEqual(plan.targetPos, [25, 25], "at the house");
	});

	it("picks up a fresh enemy after its target player went missing", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = worldPos(11, 12);

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.UpdateTarget(world.gameState), true, "the fresh enemy was groomed");
		});
		assert.equal(plan.targetPlayer, ENEMY, "the plan joined the only enemy");
		assert.equal(plan.target, target, "the enemy centre was the target");
	});

	it("takes one last look for another enemy after helping fails", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY, debug: 2 });
		world.removeEntity(1000);   // nothing structurally left to attack
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = worldPos(11, 12);
		resetRecorder();

		assert.equal(plan.UpdateTarget(world.gameState), false, "nothing was found");
		assert.equal(plan.targetPlayer, ENEMY, "the plan joined the only enemy");
		assert.ok(logs.some((entry) => /No new target found. Remaining units /.test(entry)),
			"the giving-up warning was logged");
	});

	it("announces the arrival of the attack", () =>
	{
		const world = makeWorld({ debug: 2 });
		const target = makeTarget(world);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, undefined, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.targetPos = worldPos(30, 40);
		resetRecorder();

		assert.ok(plan.update(world.gameState, emptyEvents()), "the plan marched on");
		assert.ok(logs.some((entry) => /has arrived to destination/.test(entry)), "the arrival was announced");
		assert.equal(plan.state, "", "the plan is now attacking");
	});

	it("arrives once the path empties at the last waypoint", () =>
	{
		const world = makeWorld({ debug: 2 });
		const target = makeTarget(world, { position: () => [100, 100] });
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee", "CitizenSoldier"]
		}, undefined, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.targetPos = worldPos(100, 100);
		plan.path = [worldPos(30, 40)];
		resetRecorder();

		assert.ok(plan.update(world.gameState, emptyEvents()), "the plan marched on");
		assert.ok(logs.some((entry) => /has arrived to destination/.test(entry)), "the arrival was announced");
	});

	it("answers a flat access when nobody marches", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = worldPos(11, 12);

		assert.equal(plan.getAttackAccess(world.gameState), 0, "an empty army marches on flat ground");
	});
});

describe("the retaliating crowd", () =>
{
	it("sends the non-siege support to rescue an attacked siege engine", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, { attackTypes: () => ["Melee"] }, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const rescues: unknown[][] = [];
		override(world.ents.get(1011)!, { "attack": (aim: unknown, capture: unknown) =>
			rescues.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		assert.deepEqual(rescues, [[3000, false]], "the melee helper attacked the foe");
	});

	it("retaliates in kind when an enemy engine comes for our melee", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const ally = world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Siege", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const volleys: unknown[][] = [];
		override(world.ents.get(1011)!, { "attack": (aim: unknown, capture: unknown) =>
			volleys.push([aim, capture, "ally"]) });
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			volleys.push([aim, capture, "victim"]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		assert.ok(volleys.length >= 2, "both the helper and the victim swung back");
		assert.ok(volleys.every((strike) => strike[0] === 3000), "every blow was at the engine");
		assert.ok(ally, "the ally was registered");
	});

	it("does not let our melee chase a ranged sniper while blocked", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		plan.isBlocked = true;
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Ranged"]
		}, { attackTypes: () => ["Ranged"] }));
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 1, "the cohort is kept");
		assert.deepEqual(strikes, [], "the sniper was ignored by a blocked cohort");
	});

	it("sends melee brothers when an engine besieges one of ours", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Siege"]
		}, { attackTypes: () => ["Melee"] }));
		const helps: unknown[][] = [];
		override(world.ents.get(1011)!, { "attack": (aim: unknown, capture: unknown) =>
			helps.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		assert.deepEqual(helps, [[3000, false]], "the melee helper came to the rescue");
	});

	it("leaves a helper who is already busy with the very attacker", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [100, 100], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, "victim"]) });
		override(world.ents.get(1011)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, "helper"]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		assert.deepEqual(strikes, [], "nobody was redirected, they fight the same foe");
	});

	it("leaves a helper who is busy with another unit", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3001 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [100, 100], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 3001, owner: ENEMY, position: [40, 40], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, "victim"]) });
		override(world.ents.get(1011)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, "helper"]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 2, "the cohort is kept");
		// the busy helper held back; the victim swung twice: once as the
		// nearest melee helper, once in its own retaliation
		assert.deepEqual(strikes, [[3000, "victim"], [3000, "victim"]],
			"only the victim retaliated");
	});

	it("lets the victim keep the attacker it had already chosen", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [70, 80] }, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [100, 100], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 1, "the cohort is kept");
		assert.deepEqual(strikes, [], "the victim fights the attacker already");
	});

	it("swings the siege engine back at an encroaching engine", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege", "Melee"]
		}, { attackTypes: () => ["Melee"], canAttackTarget: () => true }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 30], classes: ["Unit", "Siege", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const swings: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			swings.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 1, "the engine is kept");
		assert.deepEqual(swings, [[3000, false]], "the engine answered in kind");
	});

	it("lets the victim keep its non-structure target", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [70, 80] }, 2005);
		world.addEntity(makeEntity({
			id: 2006, owner: ENEMY, position: [40, 42], classes: ["Unit", "Melee"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 2006 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [100, 100], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000), "attackerOwner": ENEMY });

		assert.equal(plan.update(world.gameState, events), 1, "the cohort is kept");
		assert.deepEqual(strikes, [], "the victim chased its unit prey on");
	});
});

describe("directing the swarm", () =>
{
	it("counts the hunters on every prey and re-targets the shared one", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const prey = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [30, 50], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		for (let i = 0; i < 4; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
			}, {
				isIdle: () => true,
				attackTypes: () => ["Melee"], canAttackTarget: () => true,
				unitAIOrderData: () => [{ "target": 3000 }]
			}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const strikes: unknown[][] = [];
		for (let i = 0; i < 4; ++i)
			override((world.ents.get(1010 + i) as CommonEntity), { "attack": (aim: unknown, capture: unknown) =>
				strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 4, "the crowd is kept");
		assert.deepEqual(strikes,
			[[3000, false], [3000, false], [3000, false], [3000, false]],
			"every hunter was sent back to its prey");
		assert.ok(prey, "the prey was registered");
	});

	it("sweeps onward when a prey is already swarmed", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [85, 57], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		for (let i = 0; i < 4; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [80, 60], classes: ["Unit", "Melee"]
			}, {
				attackTypes: () => ["Melee"], canAttackTarget: () => true,
				unitAIOrderData: () => [{ "target": 3000 }]
			}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 4, "the crowd is kept");
		assert.deepEqual(sweeps[0][0], 30, "the sweep aimed at the goal");
		assert.deepEqual(sweeps[0][1], 40, "the sweep aimed at the goal");
		assert.equal(sweeps.length, 1, "only the first hunter was probed");
		assert.equal(sweeps[0][2] && (sweeps[0][2] as { vetoEntities: Record<number, boolean> }).vetoEntities[3000], true,
			"the swarmed prey was on the veto list");
	});

	it("counts the champions, heroes and engines in the tally separately", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		for (const [id, extraClasses] of [[3000, []], [3001, ["Champion"]], [3002, ["Siege"]]] as const)
			world.addEntity(makeEntity({
				id: id, owner: ENEMY, position: [200, 200],
				classes: ["Unit", "Melee", ...extraClasses]
			}, { attackTypes: () => ["Melee"] }));
		const preys = [3000, 3001, 3002];
		preys.forEach((prey, i) =>
		{
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [80, 60], classes: ["Unit", "Melee"]
			}, {
				attackTypes: () => ["Melee"], canAttackTarget: () => true,
				unitAIOrderData: () => [{ "target": prey }]
			}, { "plan": 1 }));
		});
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });
		const strikes: unknown[][] = [];
		for (let i = 0; i < 3; ++i)
			override((world.ents.get(1010 + i) as CommonEntity), { "attack": (aim: unknown, capture: unknown) =>
				strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 3, "the skirmishers are kept");
		assert.deepEqual(strikes, [], "the far preys drew nobody");
	});

	it("sends the siege engine at the most dangerous structure in reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			isIdle: () => true,
			attackTypes: () => ["Melee"], attackRange: () => ({ "max": 60 }),
			canAttackTarget: () => true, canAttackClass: () => false
		}, { "plan": 1 }));
		const tower = world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [22, 22], classes: ["Structure", "Tower"]
		}, { costSum: () => 400, hasDefensiveFire: () => true }));
		const fortress = world.addEntity(makeEntity({
			id: 2011, owner: ENEMY, position: [25, 25],
			classes: ["Structure", "Fortress", "ConquestCritical"]
		}, { costSum: () => 600 }));
		const barracks = world.addEntity(makeEntity({
			id: 2012, owner: ENEMY, position: [28, 24], classes: ["Structure", "Barracks"]
		}, { costSum: () => 500 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the engine is kept");
		assert.deepEqual(strikes, [[tower.id(), false]], "the shooting tower came first");
		assert.ok(fortress && barracks, "the other structures were there");
	});

	it("marches a melee siege engine onward when nothing stands in reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			isIdle: () => true, attackTypes: () => ["Melee"], canAttackTarget: () => true
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the engine is kept");
		assert.deepEqual(sweeps, [[110, 110, {
			"attack": ["Structure"], "avoid": ["Ship"], "vetoEntities": {}
		}]], "the engine marched with structure-only classes");
	});

	it("marches a ranged siege engine with the plain siege classes", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege", "Ranged"]
		}, {
			isIdle: () => true, attackTypes: () => ["Ranged"],
			attackRange: () => ({ "max": 60 }), canAttackTarget: () => true
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the engine is kept");
		assert.deepEqual(sweeps, [[110, 110, {
			"attack": ["Structure"], "avoid": [], "vetoEntities": {}
		}]], "the ranged engine marched without a ship avoid");
	});

	it("widens the siege prey list when the target can shoot back", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {
			position: () => [110, 110], hasDefensiveFire: () => true
		}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			isIdle: () => true, attackTypes: () => ["Melee"], canAttackTarget: () => true
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the engine is kept");
		assert.deepEqual((sweeps[0][2] as { attack: string[] }).attack, ["Structure"], "structures only");
		assert.deepEqual((sweeps[0][2] as { avoid: string[] }).avoid,
			["House", "Storehouse", "Farmstead", "Field", "Forge", "Ship"],
			"the easy buildings were delayed");
	});

	it("reconsiders a siege engine whose order hangs on a living unit", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [25, 25], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Siege"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIOrderData: () => [{ "target": 9999 }]   // long dead
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		for (const id of [1010, 1011])
			override(world.ents.get(id)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
				sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 2, "the engines are kept");
		assert.equal(sweeps.length, 2, "both engines rethought their orders");
		assert.deepEqual((sweeps[0][2] as { avoid: string[] }).avoid, ["Ship"], "ships were avoided");
	});

	it("strikes the main target directly when blocked and in reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [25, 25], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			isIdle: () => true, attackTypes: () => ["Melee"],
			attackRange: () => ({ "max": 5 }), canAttackTarget: () => true
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		plan.isBlocked = true;
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the fighter is kept");
		assert.deepEqual(strikes, [[2005, false]], "the main target took the direct blow");
	});

	it("reverts to a nose-length range without attack types", () =>
	{
		// Fixture note: this situation cannot arise in a real game. Every plan
		// member is a citizen soldier or fast-moving unit and carries attack types
		// (and "Support" is a class, not an attack type — the only real ones are
		// Melee, Ranged and Capture). This covers the defensive `range = 10`
		// fallback, which is dead code in practice in both port and original.
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [21, 20], classes: ["Unit", "Support"]
		}, { attackTypes: () => ["Support"] }));
		world.addEntity(makeEntity({
			id: 3001, owner: ENEMY, position: [22, 21], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			isIdle: () => true, attackTypes: () => undefined,
			canAttackTarget: () => true, counters: () => false
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		plan.isBlocked = true;
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the fighter is kept");
		// both foes are within ten metres, but the paired one comes out first
		assert.deepEqual(strikes, [[3000, false]], "the closest support foe was struck");
	});

	it("attacks everything along the way when the hunter is approaching", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		// a ramming ship the hunter was once ordered at; it has since sailed beyond reach
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [200, 200], classes: ["Unit", "Ship"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [80, 60], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIState: () => "INDIVIDUAL.COMBAT.APPROACHING",
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the hunter is kept");
		assert.deepEqual((sweeps[0][2] as { avoid: string[] }).avoid, ["Ship"],
			"the approaching hunter was told to strike everything but ships");
	});

	it("marches a ranged hunter with no avoid list at all", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		// a battery ship the hunter was once ordered at; it has since sailed beyond reach
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [200, 200], classes: ["Unit", "Ship"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [80, 60], classes: ["Unit", "Ranged"]
		}, {
			attackTypes: () => ["Ranged"], attackRange: () => ({ "max": 60 }),
			canAttackTarget: () => true,
			unitAIState: () => "INDIVIDUAL.COMBAT.APPROACHING",
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the hunter is kept");
		// the port sends an empty avoid list, the original none: UnitAI reads
		// both alike (it checks `targetClasses.avoid &&` before matching)
		const avoid = (sweeps[0][2] as { avoid?: string[] }).avoid;
		assert.ok(avoid === undefined || avoid.length === 0, "the ranged hunter needed no avoid list");
	});

	it("lets a fleeing farmer slip past its hunter", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [85, 65], classes: ["Unit", "Civilian"]
		}, {
			attackTypes: () => ["Melee"], unitAIState: () => "INDIVIDUAL.FLEEING"
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [80, 60], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIState: () => "INDIVIDUAL.COMBAT.APPROACHING",
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the hunter is kept");
		assert.deepEqual(strikes, [], "the fleeing farmer slipped past");
		assert.deepEqual((sweeps[0][2] as { avoid: string[] }).avoid, ["Ship"],
			"the hunter swept the goal instead");
	});

	it("sends the stranded fighter to help its nearest fighting brother", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const foe = world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [100, 100], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"]
		}, {
			isIdle: () => true, attackTypes: () => ["Melee"],
			canAttackTarget: (aimed: CommonEntity) => aimed.hasClass("Unit"),
			unitAIState: () => "INDIVIDUAL.INVOLVED.IDLE"
		}, { "plan": 1 }));
		world.addEntity(makeEntity({
			id: 1011, owner: PLAYER, position: [22, 22], classes: ["Unit", "Melee"]
		}, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING",
			unitAIOrderData: () => [{ "target": 3000 }]
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const strikes: unknown[][] = [];
		override(world.ents.get(1010)!, { "attack": (aim: unknown, capture: unknown) =>
			strikes.push([aim, capture]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 2, "the cohort is kept");
		assert.deepEqual(strikes, [[3000, false]], "the stranded one joined the brother's fight");
		assert.ok(foe, "the foe was registered");
	});

	it("joins the started fight of a brother plan", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const cc = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, {}, { "plan": 1 }));
		// a decaying house, like a Carthaginian apartment: a real raid prey the
		// finder must overlook, so the plan has to adopt the brother's target
		const good = world.addEntity(makeEntity({
			id: 2601, owner: ENEMY, position: [30, 40], classes: ["Structure", "Village", "House"]
		}, { decaying: () => true }));
		const gaiaHut = world.addEntity(makeEntity({
			id: 2610, owner: 0, position: [31, 41], classes: ["Structure", "House"]
		}));
		const far = world.addEntity(makeEntity({
			id: 2620, owner: ENEMY, position: [55, 66], classes: ["Structure", "House"]
		}));
		world.accessAt.set("55,66", 3);
		const passedAway = makeTarget(world, {}, 2630);
		const plan = makePlan(world, { name: 1, init: true, data: { target: cc } });
		world.removeEntity(2005);   // the plan's own target is gone
		world.removeEntity(2630);   // a brother's prey recently died
		world.ai.HQ.attackManager.startedAttacks.Raid = [
			fake<AttackPlan>({ "name": 1 }),                   // our own plan, skip
			fake<AttackPlan>({ "name": 2, "target": gaiaHut, "targetPlayer": ENEMY }),  // gaia prey
			fake<AttackPlan>({ "name": 3, "target": far, "targetPlayer": ENEMY }),     // other land
			fake<AttackPlan>({ "name": 4, "target": good, "targetPlayer": PLAYER }),   // not an enemy
			fake<AttackPlan>({ "name": 5, "target": passedAway, "targetPlayer": ENEMY }),
			fake<AttackPlan>({ "name": 9, "target": good, "targetPlayer": ENEMY })     // the join
		];
		plan.position = worldPos(11, 12);

		withPath([{ "x": 30, "y": 40 }], () =>
		{
			assert.equal(plan.UpdateTarget(world.gameState), true, "the plan joined the brother");
		});
		assert.equal(plan.target, good, "the brother's prey was adopted");
		assert.equal(plan.targetPlayer, ENEMY, "the brother's enemy was adopted");
		assert.deepEqual(plan.targetPos, [30, 40], "at the brother's prey");
		assert.ok(passedAway, "the dead ref existed");
	});

	it("reveals the orders of a siege engine aimed at one living prey", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		world.addEntity(makeEntity({
			id: 3000, owner: ENEMY, position: [200, 200], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"] }));
		for (let i = 0; i < 4; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
			}, {
				attackTypes: () => ["Melee"], canAttackTarget: () => true,
				unitAIOrderData: () => [{ "target": 3000 }]
			}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		for (let i = 0; i < 4; ++i)
			override((world.ents.get(1010 + i) as CommonEntity), { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
				sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 4, "the engines are kept");
		assert.equal(sweeps.length, 4, "each engine rethought its single order");
		assert.deepEqual((sweeps[0][2] as { avoid: string[] }).avoid, ["Ship"], "ships were avoided");
	});

	it("follows the enemy keeper of a garrisoned hunter", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const holder = makeTarget(world, {
			isGarrisonHolder: () => true, garrisoned: () => [2602]
		}, 2501);
		world.addEntity(makeEntity({
			id: 2602, owner: ENEMY, classes: ["Unit", "Hero"]
		}));
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = worldPos(11, 12);
		plan.target = world.ents.get(2602);
		plan.targetPlayer = ENEMY;

		assert.equal(plan.UpdateTarget(world.gameState), true, "the keeper took over");
		assert.equal(plan.target, holder, "the keeper was adopted as the target");
		assert.deepEqual(plan.targetPos, [30, 40], "at the keeper");
	});

	it("drops the prey whose keeper is our own", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY, debug: 2 });
		const anchor = world.ents.get(1000) as unknown as Record<string, () => unknown>;
		anchor.isGarrisonHolder = () => true;
		anchor.garrisoned = () => [2602];
		world.addEntity(makeEntity({
			id: 2602, owner: ENEMY, classes: ["Unit", "Hero"]
		}));
		const plan = makePlan(world, { name: 1, init: true });
		plan.position = worldPos(11, 12);
		plan.target = world.ents.get(2602)!;
		plan.targetPlayer = ENEMY;
		resetRecorder();

		assert.equal(plan.UpdateTarget(world.gameState), false, "nothing remained to attack");
		assert.equal(plan.target, undefined, "the prey was dropped");
		assert.ok(logs.some((entry) => /No new target found. Remaining units/.test(entry)),
			"the surrender was logged");
	});
});

describe("when walls and orders scatter the plan", () =>
{
	it("claims the breach when the wall-breaking crew announces it", () =>
	{
		// only the port passes: like its kin below, only the port finds the
		// walls it can break (filters.byClass vs byClasses)
		const world = makeWorld({ debug: 2 });
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [13, 13], classes: ["Structure", "Palisade"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { canAttackClass: (cls: string) => cls === "Palisade" }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(11, 12);
		plan.targetPos = worldPos(30, 120);
		plan.path = [worldPos(11, 12), worldPos(20, 20)];
		resetRecorder();

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the crew moves in");
		assert.ok(logs.some((entry) => /has met walls and is not happy/.test(entry)),
			"the breach was announced");
	});

	it("announces defeat in front of walls it cannot break", () =>
	{
		// only the port passes: only the port finds the walls it cannot break
		const world = makeWorld({ debug: 2 });
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({
			id: 2010, owner: ENEMY, position: [13, 13], classes: ["Structure", "Palisade"]
		}));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"]
		}, { canAttackClass: () => false }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(11, 12);
		plan.targetPos = worldPos(30, 120);
		plan.path = [worldPos(11, 12), worldPos(20, 20)];
		resetRecorder();

		assert.equal(plan.update(world.gameState, emptyEvents()), 0, "the plan gave up");
		assert.ok(logs.some((entry) => /has met walls and gives up/.test(entry)),
			"the defeat was announced");
	});

	it("gives a siege engine marching at a unit the unit classes too", () =>
	{
		const world = makeWorld();
		const prey = world.addEntity(makeEntity({
			id: 2005, owner: ENEMY, position: [110, 110], classes: ["Unit", "Melee"]
		}, { attackTypes: () => ["Melee"], unitAIState: () => "INDIVIDUAL.IDLE" }));
		world.addEntity(makeEntity({
			id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Siege"]
		}, {
			isIdle: () => true, attackTypes: () => ["Melee"], canAttackTarget: () => true
		}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target: prey } });
		plan.state = "";
		const sweeps: unknown[][] = [];
		override(world.ents.get(1010)!, { "attackMove": (x: unknown, y: unknown, classes: unknown) =>
			sweeps.push([x, y, classes]) });

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the engine is kept");
		assert.deepEqual((sweeps[0][2] as { attack: string[] }).attack, ["Unit", "Structure"],
			"the engine marched ready for units and structures");
	});
});

/** an entity collection over the given entities, as the game state hands them out */
function mapCollection(world: World, ents: CommonEntity[]): CommonEntityCollection
{
	return new EntityCollection(world.gameState.sharedScript, mapOf(ents));
}

describe("second pass: preparing and choosing", () =>
{
	it("a plan that cannot build units may start with what it has; a paused plan never must", () =>
	{
		const world = makeWorld({ canBuildUnits: false });
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.canStart(), true);
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"] }, {}, { "plan": 1 }));
		plan.setPaused(true);
		assert.equal(plan.mustStart(), false);
	});

	it("a forge, which trains nothing, and a workshop whose ram is not yet available give no siege", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({ id: 900, owner: PLAYER, position: [14, 14], classes: ["Structure", "Forge"] },
			{ trainingQueue: () => [], trainableEntities: () => undefined }));
		world.addEntity(makeEntity({ id: 901, owner: PLAYER, position: [16, 14], classes: ["Structure", "Arsenal"] },
			{ trainingQueue: () => [], trainableEntities: () => ["units/siege_ram"] }));
		world.templates["units/siege_ram"] = makeTemplate("units/siege_ram", { classes: ["Siege", "Melee"], available: false });
		const plan = makePlan(world, { name: 1, init: true });
		assert.equal(plan.addSiegeUnits(world.gameState), false);
		assert.equal(plan.siegeState, 1);
	});

	it("with a small population cap, a full town starts a smaller crowd", () =>
	{
		for (const [populationMax, starts] of [[150, true], [400, false]] as const)
		{
			const world = makeWorld({ population: populationMax - 2, populationMax });
			const target = makeTarget(world);
			// thirteen horsemen: no category is at its minimum size
			for (let i = 0; i < 13; ++i)
				world.addEntity(makeEntity({
					id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"]
				}, { moveToRange: () => undefined }, { "plan": 1 }));
			const plan = makePlan(world, { name: 1, init: true, data: { target } });
			withPath([{ "x": 30, "y": 40 }], () => { plan.updatePreparation(world.gameState); });
			// a cap of 150 lowers the crowd needed from 16 to 12
			assert.equal(plan.state === "completing", starts, `cap ${populationMax}`);
		}
	});

	it("a unit carrying resources drops them before walking to the rally point", () =>
	{
		const world = makeWorld({ population: 396, populationMax: 400 });
		const target = makeTarget(world);
		const store = world.addEntity(makeEntity({ id: 950, owner: PLAYER, position: [14, 12], classes: ["Structure", "Storehouse"] },
			{}, { "access": 2 }));
		world.gameState.getOwnDropsites = () => mapCollection(world, [store]);
		const marches: unknown[][] = [];
		const returned: unknown[] = [];
		for (let i = 0; i < 20; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"]
			}, {
				moveToRange: recordMarches(marches),
				resourceCarrying: () => i === 0 ? [{ "type": "wood", "amount": 10 }] : [],
				returnResources: (dropsite: CommonEntity) => returned.push(dropsite.id())
			}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });

		withPath([{ "x": 30, "y": 40 }], () => { plan.updatePreparation(world.gameState); });

		assert.deepEqual(returned, [950]);
		// its walk to the rally point is queued after the drop
		assert.equal(marches.filter((m) => m[4] === true).length, 1);
	});

	it("in a game for easy difficulty or below, no worker is taken for the attack", () =>
	{
		const world = makeWorld({ defensive: 0, difficulty: EASY });
		const plan = makePlan(world, { name: 1, init: true });
		for (let i = 0; i < 20; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "role": "worker", "subrole": "idle", "base": 1 }));
		assert.equal(plan.assignUnits(world.gameState), false);
	});

	it("beyond the defenders, only idle citizen soldiers go: not women, not busy gatherers", () =>
	{
		const world = makeWorld({ defensive: 0, enemyPlayer: ENEMY });
		const plan = makePlan(world, { name: 1, init: true });
		world.addEntity(makeEntity({ id: 2000, owner: ENEMY, position: [40, 40], classes: ["Unit", "Melee"] }));
		for (let i = 0; i < 10; ++i)
			world.addEntity(makeEntity({
				id: 1010 + i, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry", "CitizenSoldier"]
			}, { attackTypes: () => undefined }, { "role": "worker", "subrole": "idle", "base": 1 }));
		world.addEntity(makeEntity({ id: 1030, owner: PLAYER, position: [11, 12], classes: ["Unit", "Support", "Female"] },
			{ attackTypes: () => undefined }, { "role": "worker", "subrole": "idle", "base": 1 }));
		world.addEntity(makeEntity({ id: 1031, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry", "CitizenSoldier"] },
			{ attackTypes: () => undefined }, { "role": "worker", "subrole": "gatherer", "base": 1 }));
		world.addEntity(makeEntity({ id: 1032, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry", "CitizenSoldier"] },
			{ attackTypes: () => undefined }, { "role": "worker", "subrole": "idle", "base": 1 }));

		plan.assignUnits(world.gameState);

		// ten stay home (6 + 4 per enemy); of the rest only the idle soldier goes
		assert.deepEqual([...plan.unitCollection.values()].map((e) => e.id()), [1032]);
	});

	// only the port passes: the original's class list is an any-of, so any
	// citizen soldier (not only a fast one) is handed over to the raid
	it("a unit boarding a ship, a foot soldier and a fast champion stay; the next fast citizen soldier goes to the raid", () =>
	{
		const world = makeWorld();
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"] },
			{}, { "plan": 1, "transport": 3 }));
		world.addEntity(makeEntity({ id: 1011, owner: PLAYER, position: [11, 12], classes: ["Unit", "Infantry", "CitizenSoldier"] },
			{}, { "plan": 1 }));
		world.addEntity(makeEntity({ id: 1012, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "Champion"] },
			{}, { "plan": 1 }));
		world.addEntity(makeEntity({ id: 1013, owner: PLAYER, position: [11, 12], classes: ["Unit", "FastMoving", "CitizenSoldier"] },
			{}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		const raid = makePlan(world, { name: 42, type: "Raid", init: true });
		world.ai.HQ.attackManager.getAttackInPreparation = (type: string) => type === "Raid" ? raid : undefined;
		plan.reassignFastUnit(world.gameState);
		assert.deepEqual(world.units.filter((u) => u.id() >= 1010).map((u) => u.getMetadata(PLAYER, "plan")), [1, 1, 1, 42]);
	});

	it("with no enemy player left, or its single target gone, no target is chosen", () =>
	{
		const noEnemy = makeWorld({ enemyPlayer: undefined });
		makeTarget(noEnemy);
		assert.equal(makePlan(noEnemy, { name: 1, init: true }).chooseTarget(noEnemy.gameState), false);

		const world = makeWorld({ enemyPlayer: ENEMY });
		makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true, data: { uniqueTargetId: entityId(2999) } });
		plan.targetPlayer = ENEMY;
		assert.equal(plan.chooseTarget(world.gameState), false);
	});

	it("an overseas target is reached from the nearest base on another land, weighed by that land's size", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY, sea: 4 });
		world.accessAt.set("200,200", 3);
		world.ai.accessibility.regionSize[5] = 100;
		const target = world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [200, 200], classes: ["Structure", "CivCentre"] }));
		// a base still being laid out (no anchor), a near and a far base on land 5
		world.bases.push({ "ID": 2, anchor: undefined, accessIndex: 5 });
		for (const [id, pos] of [[1301, [150, 160]], [1302, [60, 60]]] as const)
		{
			world.accessAt.set(`${pos[0]},${pos[1]}`, 5);
			world.bases.push({ "ID": id, anchor: world.addEntity(makeEntity({ id, owner: PLAYER, position: [...pos],
				classes: ["Structure", "CivCentre"] })), accessIndex: 5 });
		}
		const plan = makePlan(world, { name: 1, init: true });
		plan.overseas = 0;

		assert.equal(plan.chooseTarget(world.gameState), true);
		assert.equal(plan.target, target);
		assert.deepEqual(plan.rallyPoint, [150, 160]);
		assert.equal(plan.overseas, 4);
	});

	it("a target on another of our lands is reached from our nearest centre there", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		world.accessAt.set("200,200", 3);
		world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [200, 200], classes: ["Structure", "CivCentre"] }));
		for (const [id, pos] of [[1301, [150, 160]], [1302, [60, 60]]] as const)
		{
			world.accessAt.set(`${pos[0]},${pos[1]}`, 3);
			world.bases.push({ "ID": id, anchor: world.addEntity(makeEntity({ id, owner: PLAYER, position: [...pos],
				classes: ["Structure", "CivCentre"] })), accessIndex: 3 });
		}
		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 200, "y": 200 }], () => assert.equal(plan.chooseTarget(world.gameState), true));
		assert.deepEqual(plan.rallyPoint, [150, 160]);
		assert.equal(plan.overseas, 0);
	});

	it("on a naval map, a plan given its target weighs only that target's land for a crossing", () =>
	{
		const world = makeWorld({ navalMap: true, sea: 4 });
		world.ai.HQ.navalMap = true;
		// another enemy building on our own land, which an untargeted plan would settle for
		world.addEntity(makeEntity({ id: 2010, owner: ENEMY, position: [40, 40], classes: ["Structure", "House"] }));
		world.accessAt.set("200,200", 3);
		const target = world.addEntity(makeEntity({ id: 2100, owner: ENEMY, position: [200, 200], classes: ["Structure", "CivCentre"] }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		assert.equal(plan.overseas, 4);
	});

	it("a plan rallied for a crossing drops the crossing when its new target stands on its own land", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		makeTarget(world);
		const plan = makePlan(world, { name: 1, init: true });
		plan.overseas = seaRegion(4);
		withPath([{ "x": 30, "y": 40 }], () => assert.equal(plan.chooseTarget(world.gameState), true));
		assert.equal(plan.overseas, 0);
	});

	it("an attack facing only guarded buildings takes on the town itself, but only with siege engines", () =>
	{
		for (const withSiege of [false, true])
		{
			const world = makeWorld({ enemyPlayer: ENEMY });
			makeTarget(world);
			world.addEntity(makeEntity({ id: 2010, owner: ENEMY, position: [35, 40], classes: ["Structure", "Tower"] },
				{ hasDefensiveFire: () => true }));
			if (withSiege)
				world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Siege"] }, {}, { "plan": 1 }));
			const plan = makePlan(world, { name: 1, init: true });
			plan.targetPlayer = ENEMY;
			let target: CommonEntity | undefined;
			withPath([{ "x": 30, "y": 40 }], () => { target = plan.getNearestTarget(world.gameState, worldPos(10, 10)); });
			assert.equal(target?.id(), withSiege ? 2000 : undefined, `siege ${withSiege}`);
		}
	});

	it("a rush passes over gaia ruins and farther buildings, and turns to any enemy when its own is all guarded", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		world.removeEntity(1000);
		// the chosen enemy's only building stands under its tower
		world.addEntity(makeEntity({ id: 2001, owner: ENEMY, position: [100, 100], classes: ["Structure", "House"] }));
		world.addEntity(makeEntity({ id: 2002, owner: ENEMY, position: [105, 100], classes: ["Structure", "Tower"] },
			{ hasDefensiveFire: () => true }));
		world.addEntity(makeEntity({ id: 2003, owner: GAIA, position: [12, 12], classes: ["Structure", "Ruins"] }));
		world.addEntity(makeEntity({ id: 3001, owner: 3, position: [40, 40], classes: ["Structure", "House"] }));
		world.addEntity(makeEntity({ id: 3002, owner: 3, position: [200, 200], classes: ["Structure", "House"] }));
		const plan = makePlan(world, { name: 1, type: "Rush", init: true });
		const targets = plan.rushTargetFinder(world.gameState, ENEMY);
		assert.deepEqual([...targets.values()].map((e) => e.id()), [3001]);
	});
});

describe("second pass: obstructions, starting and shipping", () =>
{
	function obstacle(world: World, id: number, at: [number, number], queries: Record<string, unknown>, angle: number, classes = ["Structure", "Wall"]): CommonEntity
	{
		return world.addEntity(makeEntity({ id, owner: ENEMY, position: at, classes },
			{ get: (path: string) => queries[path], angle: () => angle }));
	}
	const wallQueries = { "Obstruction": 1, "Obstruction/Static": 1, "Obstruction/Static/@width": "4", "Obstruction/Static/@depth": "4" };

	it("a path that ends at the target is not blocked by a wall elsewhere, nor by a structure without obstruction", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		obstacle(world, 2101, [12, 30], wallQueries, Math.PI / 2);
		world.addEntity(makeEntity({ id: 2102, owner: ENEMY, position: [20, 30], classes: ["Structure", "Decoration"] },
			{ get: () => undefined }));
		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 29, "y": 38 }, { "x": 10, "y": 10 }], () =>
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), target));
		assert.equal(plan.isBlocked, false);
	});

	// only the port passes: the original reads a rotation of exactly 0 as
	// "no angle", so a wall or gate set square to the map never blocks
	it("a wall or a gate standing square to the map (rotation 0) blocks too", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const wall = obstacle(world, 2101, [12, 30], wallQueries, 0);
		const plan = makePlan(world, { name: 1, init: true });
		withPath([{ "x": 12, "y": 30 }, { "x": 10, "y": 10 }], () =>
			assert.equal(plan.checkTargetObstruction(world.gameState, target, worldPos(10, 10)), wall));
		assert.equal(plan.isBlocked, true);

		const gated = makeWorld();
		const gateTarget = makeTarget(gated, {}, 2005);
		const gate = obstacle(gated, 2102, [21, 25], {
			"Obstruction": 1, "Obstruction/Obstructions": 1,
			"Obstruction/Obstructions/Door/@width": "4", "Obstruction/Obstructions/Door/@depth": "2",
			"Obstruction/Obstructions/Left/@width": "2", "Obstruction/Obstructions/Left/@depth": "4",
			"Obstruction/Obstructions/Right/@width": "2", "Obstruction/Obstructions/Right/@depth": "4"
		}, 0, ["Structure", "Gate"]);
		const gatePlan = makePlan(gated, { name: 1, init: true });
		withPath([{ "x": 21, "y": 25 }, { "x": 30, "y": 40 }], () =>
			assert.equal(gatePlan.checkTargetObstruction(gated.gameState, gateTarget, worldPos(10, 10)), gate));
		assert.equal(gatePlan.isBlocked, true);
	});

	it("when the first waypoint already lies outside our land, the rally point is that waypoint", () =>
	{
		const world = makeWorld({ territory: new Map([["24,26", ENEMY], ["30,40", ENEMY]]) });
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		world.territory.set("10,10", 0);
		withPath([{ "x": 24, "y": 26 }], () => assert.equal(plan.getPathToTarget(world.gameState), true));
		assert.deepEqual(plan.rallyPoint, [10, 10]);
	});

	it("a crossing planned for a target that fell is dropped at start for a target on our own land, and the army walks", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const town = makeTarget(world);
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"] }, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "completing";	// as updatePreparation leaves a plan it starts
		// it was readied against an island: no path was laid, the crossing booked
		plan.overseas = seaRegion(4);
		plan.target = undefined;

		withPath([{ "x": 30, "y": 40 }], () => assert.equal(plan.StartAttack(world.gameState), true));

		assert.equal(plan.target, town);
		assert.equal(plan.overseas, 0);
		assert.equal(plan.state, "walking");
	});

	it("while shipping, blows on others' units, from dead attackers, or at units still aboard bring no answer", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"] },
			{ isIdle: () => true, canAttackTarget: () => true, attack: () => assert.fail("still aboard") }, { "plan": 1, "transport": 7 }));
		world.addEntity(makeEntity({ id: 1011, owner: PLAYER, position: [13, 14], classes: ["Unit", "Melee"] },
			{ isIdle: () => true, canAttackTarget: () => true, attack: () => assert.fail("no one to answer") }, { "plan": 1 }));
		world.addEntity(makeEntity({ id: 1012, owner: PLAYER, position: [13, 15], classes: ["Unit", "Melee"] },
			{ isIdle: () => false, canAttackTarget: () => true, attack: () => assert.fail("busy elsewhere") }, { "plan": 1 }));
		world.addEntity(makeEntity({ id: 1500, owner: PLAYER, position: [13, 14], classes: ["Unit", "Melee"] }));
		world.addEntity(makeEntity({ id: 3000, owner: ENEMY, position: [15, 15], classes: ["Unit", "Melee"] }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "transporting";
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1500), "attacker": entityId(3000) }, { "target": entityId(1011), "attacker": entityId(3999) });
		// the hit the shore party answers: the only one not aboard is busy
		world.ents.get(1011)!.isIdle = () => false;
		events.Attacked.push({ "target": entityId(1012), "attacker": entityId(3000) });

		assert.equal(plan.update(world.gameState, events), 3);
	});
});

describe("second pass: the army at work", () =>
{
	/** a soldier of the plan, recording its strikes and marches */
	function fighter(world: World, id: number, position: [number, number] | undefined, classes: string[], methods: Methods = {},
		metadata: Record<string, unknown> = {}): { ent: CommonEntity; strikes: unknown[][]; marches: unknown[][] }
	{
		const strikes: unknown[][] = [];
		const marches: unknown[][] = [];
		const ent = world.addEntity(makeEntity({ id, owner: PLAYER, position, classes: ["Unit", ...classes] }, {
			attackTypes: () => ["Melee"], canAttackTarget: () => true,
			attack: (aim: unknown, capture: unknown) => strikes.push([aim, capture]),
			attackMove: (x: unknown, z: unknown, targetClasses: unknown) => marches.push([x, z, targetClasses]),
			...methods
		}, { "plan": 1, ...metadata }));
		return { ent, strikes, marches };
	}
	function foe(world: World, id: number, position: [number, number], classes: string[], methods: Methods = {}): CommonEntity
	{
		return world.addEntity(makeEntity({ id, owner: ENEMY, position, classes }, { attackTypes: () => ["Melee"], ...methods }));
	}
	/** an attacking plan (state past walking) against the given target */
	function attacking(world: World, target: CommonEntity): AttackPlan
	{
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "";
		return plan;
	}

	it("a unit sitting in one of our buildings has left the attack; the others fight on", () =>
	{
		// units can end up inside our own buildings with their plan still on
		// them (trained at a building whose rally point garrisons, then kept
		// there by the garrison manager as "protection"); the plan must not
		// wait for them, or it never ends and holds up the next attack
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const fort = world.addEntity(makeEntity({ id: 1600, owner: PLAYER, position: [40, 40], classes: ["Structure", "Fortress"] },
			{ "isGarrisonHolder": () => true }));
		const inside = fighter(world, 1010, undefined, ["Infantry", "Ranged"], { "garrisonHolderID": () => fort.id() });
		const outside = fighter(world, 1011, [20, 20], ["Infantry", "Melee"]);
		const plan = attacking(world, target);
		plan.unitCollection.updateEnt(inside.ent);
		plan.unitCollection.updateEnt(outside.ent);

		const remaining = plan.update(world.gameState, emptyEvents());

		assert.equal(inside.ent.getMetadata(PLAYER, "plan"), -1, "free for the next attack once it comes out");
		assert.equal(plan.unitCollection.hasEntId(inside.ent.id()), false);
		assert.equal(remaining, 1, "the plan goes on with the one in the field");
	});

	it("an attack whose units all sit in our buildings is over", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const tower = world.addEntity(makeEntity({ id: 1601, owner: PLAYER, position: [40, 40], classes: ["Structure", "Tower"] },
			{ "isGarrisonHolder": () => true }));
		const a = fighter(world, 1010, undefined, ["Infantry", "Ranged"], { "garrisonHolderID": () => tower.id() });
		const b = fighter(world, 1011, undefined, ["Infantry", "Ranged"], { "garrisonHolderID": () => tower.id() });
		const plan = attacking(world, target);
		plan.unitCollection.updateEnt(a.ent);
		plan.unitCollection.updateEnt(b.ent);

		assert.ok(!plan.update(world.gameState, emptyEvents()), "nothing left to attack with: the manager ends it");
	});

	it("an army aboard ships is still the attack's", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const ship = world.addEntity(makeEntity({ id: 1602, owner: PLAYER, position: [40, 40], classes: ["Unit", "Ship"] },
			{ "isGarrisonHolder": () => true }));
		const sailor = fighter(world, 1010, undefined, ["Infantry", "Melee"], { "garrisonHolderID": () => ship.id() },
			{ "transport": 7 });
		const plan = attacking(world, target);
		plan.unitCollection.updateEnt(sailor.ent);

		assert.equal(plan.update(world.gameState, emptyEvents()), 1, "the plan waits for the landing");
		assert.equal(sailor.ent.getMetadata(PLAYER, "plan"), 1);
	});

	it("an attacked siege engine is rescued by swordsmen, not by war elephants nor by archers who cannot reach the foe", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		fighter(world, 1010, [20, 20], ["Siege"]);
		const elephant = fighter(world, 1011, [21, 20], ["Elephant", "Melee"]);
		const archer = fighter(world, 1012, [22, 20], ["Infantry", "Ranged"], { canAttackTarget: () => false });
		const swordsman = fighter(world, 1013, [23, 20], ["Infantry", "Melee"]);
		foe(world, 3000, [30, 30], ["Unit", "Melee"]);
		const plan = attacking(world, target);
		const events = emptyEvents();
		events.Attacked.push({ "target": entityId(1010), "attacker": entityId(3000) });

		plan.update(world.gameState, events);

		assert.deepEqual(swordsman.strikes[0], [3000, false]);
		assert.ok(!elephant.strikes.some(([aim]) => aim === 3000));
		assert.ok(!archer.strikes.some(([aim]) => aim === 3000));
	});

	it("a ship of the plan does not count in the tally of hunters on a prey", () =>
	{
		const sweeps = (withFourthHunter: boolean) =>
		{
			const world = makeWorld();
			const target = makeTarget(world, {}, 2005);
			foe(world, 3000, [85, 57], ["Unit", "Melee"]);
			const first = fighter(world, 1010, [80, 60], ["Melee"], { unitAIOrderData: () => [{ "target": 3000 }] });
			for (const id of [1011, 1012])
				fighter(world, id, [80, 60], ["Melee"], { unitAIOrderData: () => [{ "target": 3000 }] });
			fighter(world, 1013, [80, 60], withFourthHunter ? ["Melee"] : ["Ship", "Warship"],
				{ unitAIOrderData: () => [{ "target": 3000 }] });
			attacking(world, target).update(world.gameState, emptyEvents());
			return first.marches.length;
		};
		// four hunters swarm the prey: the first is sent on; three and a ship do not
		assert.equal(sweeps(true), 1);
		assert.equal(sweeps(false), 0);
	});

	it("against a fortress the army steps around walls only; against a wall, around fortresses only", () =>
	{
		for (const [targetClass, avoid] of [["Fortress", ["Palisade", "Wall", "Ship"]], ["Wall", ["Fortress", "Ship"]]] as const)
		{
			const world = makeWorld();
			const target = world.addEntity(makeEntity({ id: 2005, owner: ENEMY, position: [30, 40], classes: ["Structure", targetClass] }));
			const unit = fighter(world, 1010, [80, 60], ["Infantry", "Melee"], { isIdle: () => true });
			attacking(world, target).update(world.gameState, emptyEvents());
			assert.deepEqual((unit.marches[0][2] as { avoid: string[] }).avoid, avoid, targetClass);
		}
	});

	it("a soldier killed since the last turn is skipped in the round of orders", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const unit = fighter(world, 1010, [80, 60], ["Infantry", "Melee"], { isIdle: () => true });
		const plan = attacking(world, target);
		plan.unitCollUpdateArray = [entityId(1099), entityId(1010)];
		plan.update(world.gameState, emptyEvents());
		assert.equal(unit.marches.length, 1);
	});

	it("a siege engine hammering a swarmed soldier turns to the structures in reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		foe(world, 3000, [25, 25], ["Unit", "Melee"]);
		const engine = fighter(world, 1010, [20, 20], ["Siege"], { unitAIOrderData: () => [{ "target": 3000 }], canAttackClass: () => false });
		for (const id of [1011, 1012, 1013])
			fighter(world, id, [20, 21], ["Melee"], { unitAIOrderData: () => [{ "target": 3000 }] });
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(engine.strikes, [[2005, false]]);
	});

	it("a hunter chasing a ship is not re-ordered again within ten seconds", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		foe(world, 3000, [200, 200], ["Unit", "Ship"]);
		const hunter = fighter(world, 1010, [80, 60], ["Melee"], {
			unitAIState: () => "INDIVIDUAL.COMBAT.APPROACHING", unitAIOrderData: () => [{ "target": 3000 }]
		}, { "lastAttackPlanUpdateTime": world.ai.elapsedTime - 2 });
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(hunter.marches, []);
	});

	it("a blocked archer strikes what lies within its bow's reach", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		foe(world, 3000, [60, 20], ["Unit", "Melee"]);
		const archer = fighter(world, 1010, [20, 20], ["Infantry", "Ranged"], {
			isIdle: () => true, attackTypes: () => ["Ranged"], attackRange: () => ({ "max": 45, "min": 0 })
		});
		const plan = attacking(world, target);
		plan.isBlocked = true;
		plan.update(world.gameState, emptyEvents());
		assert.deepEqual(archer.strikes, [[3000, false]]);
	});

	it("a horseman looks thirty units farther for prey than a swordsman", () =>
	{
		for (const [classes, strikes] of [[["Cavalry", "FastMoving", "Melee"], 1], [["Infantry", "Melee"], 0]] as const)
		{
			const world = makeWorld();
			const target = makeTarget(world, { position: () => [200, 200] }, 2005);
			foe(world, 3000, [95, 20], ["Unit", "Melee"]);
			const unit = fighter(world, 1010, [20, 20], [...classes], { isIdle: () => true });
			attacking(world, target).update(world.gameState, emptyEvents());
			assert.equal(unit.strikes.length, strikes, classes.join("+"));
		}
	});

	it("a siege engine passes over structures out of reach, foundations just laid and buildings across the water", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [110, 110] }, 2005);
		world.addEntity(makeEntity({ id: 2010, owner: ENEMY, position: [200, 20], classes: ["Structure", "House"] }));
		world.addEntity(makeEntity({ id: 2011, owner: ENEMY, position: [25, 20], classes: ["Structure", "House"] },
			{ foundationProgress: () => 0 }));
		world.accessAt.set("20,30", 3);
		world.addEntity(makeEntity({ id: 2012, owner: ENEMY, position: [20, 30], classes: ["Structure", "House"] }, {}, { "access": 3 }));
		const engine = fighter(world, 1010, [20, 20], ["Siege"], { isIdle: () => true, canAttackClass: () => false });
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(engine.strikes, []);
		assert.equal(engine.marches.length, 1);
	});

	it("a spearman goes for the horseman it counters before a nearer swordsman", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, { position: () => [200, 200] }, 2005);
		foe(world, 3000, [30, 20], ["Unit", "Infantry", "Melee"]);
		const horse = foe(world, 3001, [50, 20], ["Unit", "Cavalry", "Melee"]);
		const spearman = fighter(world, 1010, [20, 20], ["Infantry", "Melee", "Spearman"], {
			isIdle: () => true, counters: (enemy: CommonEntity) => enemy.hasClass("Cavalry")
		});
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(spearman.strikes, [[horse.id(), false]]);
	});

	it("a soldier by the target with no foe about breaks the gate first when it can break walls", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const gate = world.addEntity(makeEntity({ id: 2010, owner: ENEMY, position: [35, 40], classes: ["Structure", "Gate"] },
			{ costSum: () => 100 }));
		// a building far off, and one across the water
		world.addEntity(makeEntity({ id: 2011, owner: ENEMY, position: [200, 200], classes: ["Structure", "House"] }));
		world.accessAt.set("40,45", 3);
		world.addEntity(makeEntity({ id: 2012, owner: ENEMY, position: [40, 45], classes: ["Structure", "House"] }, {}, { "access": 3 }));
		const unit = fighter(world, 1010, [32, 38], ["Infantry", "Melee"], { isIdle: () => true, canAttackClass: (c: string) => c === "Wall" });
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(unit.strikes, [[gate.id(), false]]);
	});

	it("a stranded fighter helps the nearest brother still fighting a living foe", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		foe(world, 3000, [100, 100], ["Unit", "Melee"]);
		foe(world, 3001, [100, 110], ["Unit", "Melee"]);
		const lonely = fighter(world, 1010, [20, 20], ["Melee"], {
			isIdle: () => true, canAttackTarget: (aimed: CommonEntity) => aimed.hasClass("Unit"), unitAIState: () => "INDIVIDUAL.IDLE"
		});
		// brothers: aboard a ship, gathering, fighting a foe now dead, the nearest fighter, a farther one
		fighter(world, 1011, undefined, ["Melee"],
			{ unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING", unitAIOrderData: () => [{ "target": 3001 }] });
		fighter(world, 1012, [21, 20], ["Melee"], { unitAIState: () => "INDIVIDUAL.GATHER.GATHERING", unitAIOrderData: () => [{ "target": 3001 }] });
		fighter(world, 1013, [21, 21], ["Melee"], { unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING", unitAIOrderData: () => [{ "target": 3999 }] });
		fighter(world, 1014, [22, 22], ["Melee"], { unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING", unitAIOrderData: () => [{ "target": 3000 }] });
		fighter(world, 1015, [60, 60], ["Melee"], { unitAIState: () => "INDIVIDUAL.COMBAT.ATTACKING", unitAIOrderData: () => [{ "target": 3001 }] });
		attacking(world, target).update(world.gameState, emptyEvents());
		assert.deepEqual(lonely.strikes, [[3000, false]]);
	});

	it("when the target's owner resigns during the fight, the target is dropped", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		fighter(world, 1010, [80, 60], ["Melee"]);
		const plan = attacking(world, target);
		target.owner = () => GAIA;
		plan.update(world.gameState, emptyEvents());
		assert.equal(plan.target, undefined);
	});

	it("only the farthest stuck siege engine is scrapped", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const destroyed: number[] = [];
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [11, 12], classes: ["Unit", "Melee"] }, {}, { "plan": 1 }));
		for (const [id, pos] of [[1011, [14, 12]], [1012, [11, 12]]] as const)
			world.addEntity(makeEntity({ id, owner: PLAYER, position: [...pos], classes: ["Unit", "Siege"] },
				{ destroy: () => destroyed.push(id) }, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.state = "walking";
		plan.lastPosition = worldPos(12, 12);
		plan.position5TurnsAgo = worldPos(12, 12);
		plan.path = [worldPos(12, 12)];
		world.ai.playedTurn = 5;
		plan.update(world.gameState, emptyEvents());
		assert.deepEqual(destroyed, [1011]);
		resetRecorder();
	});
});

describe("second pass: targets, withdrawal and events", () =>
{
	it("when we make peace with the target's owner, the plan turns to the next enemy and drops the old target", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [20, 20], classes: ["Unit", "Melee"] }, {}, { "plan": 1 }));
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.position = worldPos(20, 20);
		world.gameState.playerData.isEnemy[ENEMY] = false;
		world.ai.HQ.attackManager.getEnemyPlayer = () => playerId(3);
		plan.UpdateTarget(world.gameState);
		assert.equal(plan.targetPlayer, 3);
		assert.notEqual(plan.target, target);
	});

	it("the target of a resigned player is dropped when the target is updated", () =>
	{
		const world = makeWorld({ enemyPlayer: ENEMY });
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, init: true, data: { target } });
		plan.position = worldPos(20, 20);
		target.owner = () => GAIA;
		plan.UpdateTarget(world.gameState);
		assert.notEqual(plan.target, target);
	});

	it("withdrawing troops go to the nearest centre on their own land, passing over centres being built and across the water", () =>
	{
		const world = makeWorld();
		const plan = makePlan(world, { name: 1, init: true });
		plan.state = "walking";
		plan.position = worldPos(100, 100);
		plan.rallyPoint = worldPos(5, 5);
		world.bases.push({ "ID": 2, anchor: undefined, accessIndex: 2 });
		world.accessAt.set("110,100", 3);
		for (const [id, pos] of [[1301, [110, 100]], [1303, [90, 95]], [1302, [60, 60]]] as const)
			world.bases.push({ "ID": id, anchor: world.addEntity(makeEntity({ id, owner: PLAYER, position: [...pos],
				classes: ["Structure", "CivCentre"] }, {}, { "access": id === 1301 ? 3 : 2 })), accessIndex: id === 1301 ? 3 : 2 });
		const soldier = world.addEntity(makeEntity({ id: 1010, owner: PLAYER, position: [100, 100], classes: ["Unit", "Melee", "CitizenSoldier"] },
			{}, { "plan": 1, "role": "attack" }));
		plan.unitCollection.updateEnt(soldier);
		const marches: unknown[][] = [];
		override(soldier, { "moveToRange": (x: unknown, z: unknown) => marches.push([x, z]) });

		plan.Abort(world.gameState);

		assert.deepEqual(marches, [[90, 95]]);
		resetRecorder();
	});

	it("events about other entities and other players leave the plan as it is; enemy units or ours landing do not end a crossing", () =>
	{
		const world = makeWorld();
		const target = makeTarget(world, {}, 2005);
		const plan = makePlan(world, { name: 1, type: "Raid", init: true, data: { target } });
		plan.overseas = seaRegion(4);
		world.addEntity(makeEntity({ id: 2020, owner: ENEMY, position: [30, 41], classes: ["Unit", "Melee"] }));
		world.addEntity(makeEntity({ id: 1500, owner: PLAYER, position: [30, 42], classes: ["Structure", "House"] }));
		// an enemy outpost on a third land, where we have a centre still being built, and one on a land with no base
		world.bases.push({ "ID": 2, anchor: undefined, accessIndex: 5 });
		world.accessAt.set("150,150", 5);
		world.addEntity(makeEntity({ id: 2021, owner: ENEMY, position: [150, 150], classes: ["Structure", "Outpost"] }, {}, { "access": 5 }));
		world.accessAt.set("250,250", 6);
		world.addEntity(makeEntity({ id: 2022, owner: ENEMY, position: [250, 250], classes: ["Structure", "Outpost"] }, {}, { "access": 6 }));
		const events = emptyEvents();
		events.EntityRenamed.push({ "entity": entityId(2999), "newentity": entityId(3000) });
		events.PlayerDefeated.push({ "playerId": playerId(3) });
		for (const id of [2020, 1500, 2021, 2022])
			events.Create.push({ "entity": entityId(id) });

		plan.checkEvents(world.gameState, events);

		assert.equal(plan.target, target);
		assert.equal(plan.targetPlayer, ENEMY);
		assert.equal(plan.overseas, 4);
	});
});
