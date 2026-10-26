/**
 * Queue: the list of plans Petra wants built, trained or researched.
 *
 * These describe what a Queue does, independent of which implementation is
 * loaded (see harness/target.ts). A plan is faked here rather than taken from
 * queueplan*.ts, because the queue itself only ever touches the handful of
 * fields used below. Restoring a save is the exception: that path is the queue
 * choosing its plans, so those checks use the real plan classes and templates.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeFakeGameState } from "./harness/bareState.ts";
import { logs } from "./harness/engine.ts";
import { fake } from "./harness/fakes.ts";

import { ResourcesManager } from "simulation/ai/common-api/resources.js";

import { techName, templateName } from "../adapter/brands.ts";
import { type PlanSerialize, Queue } from "../execution/queue.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { ResearchPlan } from "../execution/queueplanResearch.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";

function food(amount: number): ResourcesManager
{
	return new ResourcesManager({ food: amount }, 0);
}

function costOf(amount: number): () => ResourcesManager
{
	// A fresh object each call: maxAccountWanted multiplies what it is given.
	return () => food(amount);
}

/** The part of a plan a Queue actually touches. */
function makePlan(overrides: Record<string, unknown> = {}): PetraRuntime.ConcretePlan
{
	const plan = fake<PetraRuntime.ConcretePlan>({
		category: "unit",
		type: "test_unit",
		number: 1,
		maxMerge: 5,
		metadata: {},
		isInvalid: () => false,
		isGo: () => true,
		getCost: () => food(0),
		start: () => undefined,
		// Reads the plan itself so an overridden type or count is reflected.
		Serialize: () => ({ category: plan.category, type: plan.type, number: plan.number }),
		addItem: (amount: number) => { plan.number += amount; },
		...overrides
	});
	return plan;
}

describe("Queue", () =>
{
	it("starts empty", () =>
	{
		const queue = new Queue();
		assert.equal(queue.length(), 0);
		assert.equal(queue.hasQueuedUnits(), false);
		assert.equal(queue.getNext(), undefined);
	});

	it("clears its plans", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan());
		queue.empty();
		assert.equal(queue.length(), 0);
		assert.deepEqual(queue.plans, []);
	});

	it("merges a unit plan into a matching one that can absorb it", () =>
	{
		const queue = new Queue();
		const existing = makePlan({ number: 1, maxMerge: 5 });
		queue.addPlan(existing);
		queue.addPlan(makePlan({ number: 2 }));

		assert.equal(queue.length(), 1, "the matching plan should have absorbed the new one");
		assert.equal(existing.number, 3, "the merge should have added the requested count");
	});

	it("keeps a unit plan that would push past the merge limit", () =>
	{
		const queue = new Queue();
		const existing = makePlan({ number: 4, maxMerge: 5 });
		queue.addPlan(existing);
		queue.addPlan(makePlan({ number: 2 }));

		assert.equal(queue.length(), 2);
		assert.equal(existing.number, 4, "the existing plan must not have been touched");
	});

	// QueuePlan declares maxMerge optional and only TrainingPlan sets it, so a
	// unit plan that leaves it unset compares against NaN and never merges.
	it("keeps a unit plan whose match sets no merge limit", () =>
	{
		const queue = new Queue();
		const existing = makePlan({ number: 1, maxMerge: undefined });
		queue.addPlan(existing);
		queue.addPlan(makePlan({ number: 2 }));

		assert.equal(queue.length(), 2, "a plan without a merge limit absorbs nothing");
		assert.equal(existing.number, 1, "the existing plan must not have been touched");
	});

	it("keeps a unit plan of a different type", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ type: "first" }));
		queue.addPlan(makePlan({ type: "second" }));
		assert.equal(queue.length(), 2);
	});

	it("drops a technology that is already queued", () =>
	{
		const queue = new Queue();
		const existing = makePlan({ category: "technology", type: "phase_town", number: 1 });
		queue.addPlan(existing);
		queue.addPlan(makePlan({ category: "technology", type: "phase_town", number: 1 }));

		assert.equal(queue.length(), 1);
		assert.equal(existing.number, 1, "a queued technology must not stack");
	});

	it("keeps technologies of different types", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ category: "technology", type: "phase_town" }));
		queue.addPlan(makePlan({ category: "technology", type: "phase_city" }));
		assert.equal(queue.length(), 2);
	});

	it("reports the plan it would start next", () =>
	{
		const queue = new Queue();
		const first = makePlan({ type: "first" });
		queue.addPlan(first);
		queue.addPlan(makePlan({ type: "second" }));
		assert.equal(queue.getNext(), first);
	});

	it("starts the next plan and removes it from the queue", () =>
	{
		const { gameState } = makeFakeGameState();
		const queue = new Queue();
		let started = 0;
		queue.addPlan(makePlan({ start: () => { ++started; } }));

		assert.equal(queue.startNext(gameState), true);
		assert.equal(started, 1);
		assert.equal(queue.length(), 0);
		assert.equal(queue.startNext(gameState), false, "an empty queue cannot start anything");
	});

	it("counts queued units across plans", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ number: 3 }));
		queue.addPlan(makePlan({ type: "other", number: 4 }));

		assert.equal(queue.hasQueuedUnits(), true);
		assert.equal(queue.countQueuedUnits(), 7);
	});

	it("counts queued units by class", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ number: 2, template: { hasClass: (name: string) => name === "Worker" } }));
		queue.addPlan(makePlan({ type: "other", number: 5, template: { hasClass: (name: string) => name === "Soldier" } }));
		// a technology has no classes: it is not counted, whatever is asked
		queue.addPlan(makePlan({ category: "technology", type: "gather_wicker_baskets", number: 1, template: {} }));

		assert.equal(queue.hasQueuedUnitsWithClass("Worker"), true);
		assert.equal(queue.hasQueuedUnitsWithClass("Siege"), false);
		assert.equal(queue.countQueuedUnitsWithClass("Worker"), 2);
		assert.equal(queue.countQueuedUnitsWithClass("Soldier"), 5);
	});

	it("counts queued units by metadata", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ number: 2, metadata: { role: "worker" } }));
		queue.addPlan(makePlan({ type: "other", number: 3, metadata: { role: "soldier" } }));

		assert.equal(queue.countQueuedUnitsWithMetadata("role", "worker"), 2);
		assert.equal(queue.countQueuedUnitsWithMetadata("role", "soldier"), 3);
		assert.equal(queue.countQueuedUnitsWithMetadata("role", "healer"), 0);
	});

	it("sums the cost of every queued plan", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ getCost: costOf(100) }));
		queue.addPlan(makePlan({ type: "other", getCost: costOf(50) }));

		assert.equal(queue.queueCost().Serialize().amounts.food, 150);
	});

	it("accounts for the first plan and a fraction of the second", () =>
	{
		const { gameState } = makeFakeGameState();
		const queue = new Queue();
		queue.addPlan(makePlan({ getCost: costOf(100) }));
		queue.addPlan(makePlan({ type: "other", getCost: costOf(50) }));

		assert.equal(queue.maxAccountWanted(gameState, 0.5).Serialize().amounts.food, 125);
		assert.equal(queue.maxAccountWanted(gameState, 0).Serialize().amounts.food, 100,
			"a zero fraction means the first plan only");
	});

	it("ignores plans that are not ready when accounting", () =>
	{
		const { gameState } = makeFakeGameState();
		const queue = new Queue();
		queue.addPlan(makePlan({ getCost: costOf(100), isGo: () => false }));
		queue.addPlan(makePlan({ type: "other", getCost: costOf(50), isGo: () => false }));

		assert.equal(queue.maxAccountWanted(gameState, 1).Serialize().amounts.food, 0);
	});

	it("drops invalid plans from the front and restores their queue priority", () =>
	{
		const { gameState, priorityChanges } = makeFakeGameState({ priorities: { military: 7 } });
		const queue = new Queue();
		queue.addPlan(makePlan({ type: "stale", isInvalid: () => true, queueToReset: "military" }));
		queue.addPlan(makePlan({ type: "also-stale", isInvalid: () => true }));
		const keeper = makePlan({ type: "valid" });
		queue.addPlan(keeper);

		queue.check(gameState);

		assert.deepEqual(queue.plans, [keeper], "only the leading invalid plans are dropped");
		assert.deepEqual(priorityChanges, [["military", 7]],
			"a plan that owned a queue should hand its priority back");
	});

	it("stops checking at the first valid plan", () =>
	{
		const { gameState } = makeFakeGameState();
		const queue = new Queue();
		const keeper = makePlan({ type: "valid" });
		queue.addPlan(keeper);
		queue.addPlan(makePlan({ type: "stale", isInvalid: () => true }));

		queue.check(gameState);

		assert.equal(queue.length(), 2, "an invalid plan behind a valid one is left alone");
		assert.equal(queue.getNext(), keeper);
	});

	it("serializes its plans and its flags", () =>
	{
		const queue = new Queue();
		queue.paused = true;
		queue.switched = 3;
		queue.addPlan(makePlan({ type: "first" }));

		const data = queue.Serialize();
		assert.equal(data.paused, true);
		assert.equal(data.switched, 3);
		assert.equal(data.plans.length, 1);
		assert.equal(data.plans[0].type, "first");
	});
});

// Restoring a save is the one place the queue builds plans itself: it
// constructs a TrainingPlan/ConstructionPlan/ResearchPlan from each saved
// entry rather than reusing the entry, so these checks need the plan classes
// and templates that answer what those constructors ask (cost, pop cost,
// research time).
describe("restoring a saved queue", () =>
{
	const { gameState } = makeFakeGameState({
		templates:
		{
			"units/athenians_soldier": { cost: { food: 150, wood: 20 }, population: 4 },
			"structures/athenians_barracks": { cost: { wood: 120, stone: 100 } },
			"research/athenians_myrnidian_founding": { cost: { food: 200 }, researchTime: 60 }
		}
	});

	/** One save entry, written by the plan class that would have produced it. */
	function savedEntry(category: string, type: string): PlanSerialize
	{
		const plan = category === "unit" ? new TrainingPlan(gameState, type)
			: category === "building" ? new ConstructionPlan(gameState, type)
			: new ResearchPlan(gameState, techName(type));
		return plan.Serialize();
	}

	it("rebuilds a plan for every saved entry", () =>
	{
		const saved =
		{
			plans:
			[
				savedEntry("unit", "units/athenians_soldier"),
				savedEntry("building", "structures/athenians_barracks"),
				savedEntry("technology", "research/athenians_myrnidian_founding")
			],
			paused: true,
			switched: 4
		};

		const queue = new Queue();
		queue.Deserialize(gameState, saved);

		assert.equal(queue.length(), 3, "each entry should have rebuilt a plan");
		assert.equal(queue.countQueuedUnits(), 3, "each rebuilt plan keeps its own count");
		assert.equal(queue.paused, true, "the paused flag comes from the save");
		assert.equal(queue.switched, 4, "the switched flag comes from the save");
	});

	it("empties the queue when the save holds no plans", () =>
	{
		const queue = new Queue();
		queue.addPlan(makePlan({ type: "leftover" }));
		queue.Deserialize(gameState, { plans: [], paused: false, switched: 0 });

		assert.equal(queue.length(), 0, "restoring replaces the plans, it does not append");
	});

	it("reports a saved entry it cannot rebuild", () =>
	{
		const logged = logs.length;
		const queue = new Queue();
		queue.Deserialize(gameState,
		{
			plans:
			[
				savedEntry("unit", "units/athenians_soldier"),
				// A category the queue has no plan class for: an old save, or a
				// plan class the queue never learned about.
				fake<PlanSerialize>({ category: "garrison", type: templateName("units/athenians_soldier") })
			],
			paused: false,
			switched: 0
		});

		assert.equal(queue.length(), 1, "an entry the queue cannot build must not be queued");
		assert.equal(
			logs.slice(logged).filter((message) => message.includes("Petra deserialization error")).length,
			1,
			"the entry should have been reported to the game log"
		);
	});
});
