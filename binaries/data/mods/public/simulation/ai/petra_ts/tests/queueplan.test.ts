/**
 * QueuePlan: the part every Petra plan shares.
 *
 * Every plan Petra queues - a building, a unit, a technology - begins as a
 * QueuePlan, and the classes that extend it only add their own specifics. So
 * these checks cover the machinery the whole queue rests on: the template
 * lookup that gives a plan its cost, Petra's own numbering, and the three
 * answers the queue manager asks a plan before it accounts for it.
 *
 * The base class is deliberately inert: it can never be started, and starting
 * it does nothing. A test that sees otherwise has found a plan class leaking
 * into the base one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commands, resetRecorder } from "./harness/engine.ts";
import { loadCommonModule, loadPetraModule } from "./harness/target.ts";
import { makeFakeGameState } from "./harness/world.ts";

interface ResourcesManagerLike
{
	add(other: ResourcesManagerLike): void;
	multiply(factor: number): void;
	Serialize(): { amounts: Record<string, number>; population: number };
}

type ResourcesManagerCtor = new (amounts?: Record<string, number>, population?: number) => ResourcesManagerLike;

interface QueuePlanLike
{
	/** The template id, after Petra's civ substitution. */
	type: string;
	/** Petra's own counter: each plan takes the next number. */
	ID: number;
	/** What the plan costs, read off the template. */
	cost: ResourcesManagerLike;
	/** How many of this plan are wanted. */
	number: number;
	/** Filled in by the plan classes; the base one leaves it empty. */
	category: string;
	/** The plan's own metadata, kept as handed over. */
	metadata: Record<string, unknown> | undefined;
	/** The template the plan was built from. */
	template: CommonTemplate;
	/** Is the plan stale? The queue manager drops it from the front if so. */
	isInvalid(gameState: CommonGameState): boolean;
	/** Can the queue manager begin increasing this plan's account? */
	isGo(gameState: CommonGameState): boolean;
	/** Can this plan be started straight away? */
	canStart(gameState: CommonGameState): boolean;
	/** Process the plan. */
	start(gameState: CommonGameState): void;
	/** What the plan costs, scaled by the number wanted. */
	getCost(): ResourcesManagerLike;
	/** Called once the plan has been started. */
	onStart(gameState: CommonGameState): void;
}

type QueuePlanCtor = new (gameState: CommonGameState, type: string, metadata?: Record<string, unknown>) => QueuePlanLike;

const { QueuePlan } = await loadPetraModule<{ QueuePlan: QueuePlanCtor }>("queueplan");
const { ResourcesManager } = await loadCommonModule<{ ResourcesManager: ResourcesManagerCtor }>("resources");

/** A template id every test builds a plan from, and what it costs. */
const SOLDITE = "units/athenians_soldite";
const SOLDITE_COST = { food: 150, wood: 20 };

/** A world that knows one template, and nothing else. */
function world(): CommonGameState
{
	return makeFakeGameState({
		templates: { [SOLDITE]: { cost: SOLDITE_COST } }
	}).gameState;
}

/** The resources a manager holds, leaving out the ones it does not need. */
function costOf(manager: ResourcesManagerLike): Record<string, number>
{
	return Object.fromEntries(
		Object.entries(manager.Serialize().amounts).filter(([, amount]) => amount !== 0)
	);
}

describe("QueuePlan", () =>
{
	it("costs what the template costs", () =>
	{
		// The world only knows one template, and says what it costs.
		const plan = new QueuePlan(world(), SOLDITE);
		assert.deepEqual(costOf(plan.cost), SOLDITE_COST, "the plan costs what the template costs");
		assert.equal(plan.cost.Serialize().population, 0, "the base plan adds no population cost");
	});

	it("hands a cost the queue manager can add to", () =>
	{
		const plan = new QueuePlan(world(), SOLDITE);
		// The queue manager sums plan costs by adding them into a fresh manager.
		const total = new ResourcesManager();
		total.add(plan.cost);
		assert.deepEqual(costOf(total), SOLDITE_COST, "the plan's cost adds up on its own");
	});

	it("takes its template from the game state", () =>
	{
		const gameState = world();
		const plan = new QueuePlan(gameState, SOLDITE);
		assert.deepEqual(plan.template.cost(), SOLDITE_COST, "the template comes from the world");
		assert.equal(plan.template.costSum(), 170, "and so does its cost sum");
	});

	it("refuses a template the game does not have", () =>
	{
		const gameState = world();
		// The game says the template is not there.
		gameState.getTemplate = () => null;
		// The plan names the template it could not find.
		assert.throws(() => new QueuePlan(gameState, "units/athenians_ghost"),
		/Tried to add the inexisting template units\/athenians_ghost to Petra\./,
		"the error names the template");
	});

	it("numbers plans from Petra's own counter", () =>
	{
		// One world, so the counter is shared.
		const gameState = world();
		const first = new QueuePlan(gameState, SOLDITE);
		const second = new QueuePlan(gameState, SOLDITE);
		assert.equal(second.ID, first.ID + 1, "plans take consecutive numbers");
	});

	it("keeps the metadata it is handed", () =>
	{
		const gameState = world();
		const plan = new QueuePlan(gameState, SOLDITE, { base: 2 });
		assert.deepEqual(plan.metadata, { base: 2 }, "the metadata arrives as it was given");
		const bare = new QueuePlan(gameState, SOLDITE);
		assert.equal(bare.metadata, undefined, "a plan without metadata has none");
	});

	it("starts as one unit of an unclassified plan", () =>
	{
		const plan = new QueuePlan(world(), SOLDITE);
		assert.equal(plan.number, 1, "one unit is wanted");
		assert.equal(plan.category, "", "the base plan is not a unit, a building or a technology");
	});

	it("answers the queue manager with the base defaults", () =>
	{
		const gameState = world();
		const plan = new QueuePlan(gameState, SOLDITE);
		assert.equal(plan.isInvalid(gameState), false, "the base plan never goes stale");
		assert.equal(plan.isGo(gameState), true, "the queue manager may account for it");
		assert.equal(plan.canStart(gameState), false, "the base plan cannot be started on its own");
	});

	it("does nothing when it is started", () =>
	{
		const gameState = world();
		const plan = new QueuePlan(gameState, SOLDITE);
		// Petra's own record of what the AI asked the game to do.
		resetRecorder();
		plan.start(gameState);
		plan.onStart(gameState);
		assert.equal(commands.length, 0, "the base plan asks nothing of the game");
	});

	it("scales its cost by the number of units wanted", () =>
	{
		const plan = new QueuePlan(world(), SOLDITE);
		assert.deepEqual(costOf(plan.getCost()), SOLDITE_COST, "one unit costs the template cost");
		plan.number = 3;
		assert.deepEqual(costOf(plan.getCost()), { food: 450, wood: 60 },
		"three units cost three times as much");
	});

	it("hands the queue manager a cost of its own", () =>
	{
		const plan = new QueuePlan(world(), SOLDITE);
		const cost = plan.getCost();
		// The queue manager multiplies what it is given, so a plan that handed
		// over its own cost would be counted twice.
		cost.multiply(2);
		assert.deepEqual(costOf(cost), { food: 300, wood: 40 }, "the copy was multiplied");
		assert.deepEqual(costOf(plan.cost), SOLDITE_COST, "the plan's own cost is untouched");
	});
});
