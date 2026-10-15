/**
 * Queue: the list of plans Petra wants built, trained or researched.
 *
 * These describe what a Queue does, independent of which implementation is
 * loaded (see harness/target.ts). A plan is faked here rather than taken from
 * queueplan*.ts, because those constructors need a template and a world; the
 * queue itself only ever touches the handful of fields used below.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadCommonModule, loadPetraModule } from "./harness/target.ts";
import { makeFakeGameState } from "./harness/world.ts";

interface ResourcesManagerLike
{
	add(other: ResourcesManagerLike): void;
	multiply(factor: number): void;
	Serialize(): { amounts: Record<string, number>; population: number };
}

type ResourcesManagerCtor = new (amounts?: Record<string, number>, population?: number) => ResourcesManagerLike;

/** The part of a plan a Queue actually touches. */
interface FakePlan
{
	category: string;
	type: string;
	number: number;
	maxMerge: number;
	metadata: Record<string, unknown>;
	template?: { hasClass(name: string): boolean };
	addItem?(amount: number): void;
	isInvalid(): boolean;
	isGo(): boolean;
	getCost(): ResourcesManagerLike;
	start(): void;
	Serialize(): Record<string, unknown>;
	queueToReset?: string;
}

interface QueueLike
{
	plans: FakePlan[];
	paused: boolean;
	switched: number;
	empty(): void;
	addPlan(plan: FakePlan | null | undefined): void;
	check(gameState: CommonGameState): void;
	getNext(): FakePlan | null;
	startNext(gameState: CommonGameState): boolean;
	maxAccountWanted(gameState: CommonGameState, fraction: number): ResourcesManagerLike;
	queueCost(): ResourcesManagerLike;
	length(): number;
	hasQueuedUnits(): boolean;
	countQueuedUnits(): number;
	hasQueuedUnitsWithClass(name: string): boolean;
	countQueuedUnitsWithClass(name: string): number;
	countQueuedUnitsWithMetadata(key: string, value: unknown): number;
	Serialize(): { plans: Record<string, unknown>[]; paused: boolean; switched: number };
}

const { Queue } = await loadPetraModule<{ Queue: new () => QueueLike }>("queue");
const { ResourcesManager } = await loadCommonModule<{ ResourcesManager: ResourcesManagerCtor }>("resources");

function food(amount: number): ResourcesManagerLike
{
	return new ResourcesManager({ food: amount }, 0);
}

function costOf(amount: number): () => ResourcesManagerLike
{
	// A fresh object each call: maxAccountWanted multiplies what it is given.
	return () => food(amount);
}

function makePlan(overrides: Partial<FakePlan> = {}): FakePlan
{
	const plan = {
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
		...overrides
	} as FakePlan;

	plan.addItem ??= function addItem(this: FakePlan, amount: number) {
		this.number += amount;
	};
	return plan;
}

describe("Queue", () =>
{
	it("starts empty", () =>
	{
		const queue = new Queue();
		assert.equal(queue.length(), 0);
		assert.equal(queue.hasQueuedUnits(), false);
		assert.equal(queue.getNext(), null);
	});

	it("drops an absent plan", () =>
	{
		const queue = new Queue();
		queue.addPlan(null);
		queue.addPlan(undefined);
		assert.equal(queue.length(), 0);
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

	// The reference implementation calls addItem() on the matching plan without
	// checking it exists, so it raises a TypeError here. Enqueuing the plan
	// instead is the port's deliberate improvement, not a regression: a plan
	// that cannot merge is still a plan the queue can run.
	it("enqueues a unit plan whose match cannot take items", () =>
	{
		const queue = new Queue();
		const existing = makePlan();
		delete existing.addItem;
		queue.addPlan(existing);
		queue.addPlan(makePlan({ number: 2 }));

		assert.equal(queue.length(), 2, "the new plan should be queued rather than merged or lost");
		assert.equal(existing.number, 1);
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
		queue.addPlan(makePlan({ number: 2, template: { hasClass: name => name === "Worker" } }));
		queue.addPlan(makePlan({ type: "other", number: 5, template: { hasClass: name => name === "Soldier" } }));
		queue.addPlan(makePlan({ type: "bare", number: 1 }));

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
