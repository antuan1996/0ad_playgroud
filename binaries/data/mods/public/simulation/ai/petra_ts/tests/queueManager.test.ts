/**
 * QueueManager: how Petra funds the queues it owns.
 *
 * The manager divides the resources the world provides between per-queue
 * accounts, guided by queue priorities, and starts a queue's next plan when its
 * account can pay for it. A plan and its cost are faked the way queue.test.ts
 * fakes them — the manager only ever asks a plan for its `getCost()`, whether
 * it is `canStart`-able, and whether it says it is `go` — while the queues
 * themselves and the `ResourcesManager` accounts are the real ones the plans
 * flow through.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeFakeGameState } from "./harness/bareState.ts";
import { logs } from "./harness/engine.ts";
import { fake, override } from "./harness/fakes.ts";

import { ResourcesManager } from "simulation/ai/common-api/resources.js";

import { seconds } from "../adapter/brands.ts";
import { Config } from "../decision/config.ts";
import type { Headquarters } from "../decision/headquarters.ts";
import { Queue } from "../execution/queue.ts";
import { QueueManager } from "../execution/queueManager.ts";

function food(amount: number): ResourcesManager
{
	return new ResourcesManager({ food: amount }, 0);
}

function costOf(amount: number): () => ResourcesManager
{
	// A fresh object each call: maxAccountWanted multiplies what it is given.
	return () => food(amount);
}

/** Petra's tuning, with the queue rates these tests reckon with. */
function makeConfig(overrides: Partial<Config> = {}): Config
{
	return Object.assign(new Config(), {
		priorities: {},
		queues: {
			firstTurn: { "food": 10, "default": 0 },
			short: { "default": 100 },
			medium: { "default": 0 },
			long: { "default": 0 }
		},
		...overrides
	});
}

/** A plan as a QueueManager sees it: its cost and readiness. */
function makePlan(overrides: Record<string, unknown> = {}): PetraRuntime.ConcretePlan
{
	return fake<PetraRuntime.ConcretePlan>({
		category: "unit",
		type: "test_unit",
		number: 1,
		isInvalid: () => false,
		isGo: () => true,
		canStart: () => true,
		getCost: () => food(0),
		start: () => undefined,
		...overrides
	});
}

/**
 * The world always answers each call with a fresh object: getAvailableResources
 * and currentNeeds mutate what getResources hands them.
 */
function worldWithResources(amounts: Record<string, number> = {}): CommonGameState
{
	const { gameState } = makeFakeGameState();
	override(gameState, { "getResources": () => new ResourcesManager({ ...amounts }) });
	return gameState;
}

/** The manager's account for a queue, as the plain numbers its methods swap. */
function account(manager: QueueManager, queue: string): Record<string, number>
{
	return manager.accounts[queue];
}

/** A manager owning the given queues, each pre-loaded with its plans. */
function makeManager(config: Config, plans: Record<string, PetraRuntime.ConcretePlan[]> = {}): QueueManager
{
	const queues: Record<string, Queue> = {};
	for (const name in plans)
	{
		queues[name] = new Queue();
		for (const plan of plans[name])
			queues[name].addPlan(plan);
	}
	return new QueueManager(config, queues);
}

describe("QueueManager", () =>
{
	it("copies its priorities from the config", () =>
	{
		const config = makeConfig({ priorities: { villager: 300, military: 600 } });
		const manager = makeManager(config);

		assert.deepEqual(manager.priorities, { villager: 300, military: 600 });

		// The priorities are the manager's working copy, not the config's: a
		// changePriority must not rewrite the config it was given.
		manager.priorities.villager = 999;
		assert.equal(config.priorities.villager, 300, "the config keeps its own numbers");
	});

	it("opens a zero account for every queue it is handed", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2 } }), { a: [], b: [] });

		assert.deepEqual(Object.keys(manager.accounts).sort(), ["a", "b"]);
		assert.equal(manager.accounts.a.Serialize().amounts.food, 0);
		assert.equal(manager.accounts.b.Serialize().amounts.food, 0);
	});

	it("orders its queues by priority, highest first", () =>
	{
		// Queue names listed in construction order say which order they arrive in.
		const manager = makeManager(makeConfig({ priorities: { c: 1, a: 300, b: 10 } }), { c: [] , a: [], b: [] });

		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["a", "b", "c"]);
	});

	it("orders equally prioritised queues by name", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { beta: 100, alpha: 100 } }), { beta: [], alpha: [] });

		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["alpha", "beta"]);
	});

	it("breaks priority ties whichever way the record lists them", () =>
	{
		// Listed [bamboo, zebra, apple], sorting compares bamboo against zebra
		// (bamboo sorts first, keeps its place) and then zebra against apple
		// (zebra sorts after, moves down) — both arms of the name tie-break run.
		const manager = makeManager(makeConfig({ priorities: { bamboo: 100, zebra: 100, apple: 100 } }),
			{ bamboo: [], zebra: [], apple: [] });

		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["apple", "bamboo", "zebra"]);
	});

	it("sees the world's resources that no account holds", () =>
	{
		const gameState = worldWithResources({ food: 100 });
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { a: [] });
		account(manager, "a").food = 30;

		assert.equal(manager.getAvailableResources(gameState).Serialize().amounts.food, 70);
		assert.equal(manager.getTotalAccountedResources().Serialize().amounts.food, 30,
			"the total accounted is the sum of the accounts");
	});

	it("needs what its queues' first plans cost, minus what the world holds", () =>
	{
		const gameState = worldWithResources({ food: 20 });
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2, c: 3 } }), {
			a: [makePlan({ getCost: costOf(100) })],
			b: [makePlan({ type: "no", getCost: costOf(999), isGo: () => false })],
			c: []
		});

		const needs = manager.currentNeeds(gameState).Serialize();
		assert.equal(needs.amounts.food, 80, "the go plan still lacks 80 food");
		assert.equal(needs.amounts.wood, 0, "a plan that is not go is not needed yet");
	});

	it("wants the first-turn rates before it has planned anything", () =>
	{
		const gameState = worldWithResources();
		gameState.ai.playedTurn = 0;
		const manager = makeManager(makeConfig());

		const rates = manager.wantedGatherRates(gameState);
		assert.equal(rates.food, 10);
		assert.equal(rates.wood, 0, "the config asks for no wood on the first turn");
	});

	it("wants rates that cover what its short and medium plans still lack", () =>
	{
		const gameState = worldWithResources({ food: 500 });
		gameState.ai.playedTurn = 2;   // any turn past the first
		const manager = makeManager(makeConfig(), {
			a: [makePlan({ getCost: costOf(100) }), makePlan({ type: "second", getCost: costOf(50) })]
		});

		const rates = manager.wantedGatherRates(gameState);
		// The 100 food for the first item comes off the world's 500, and the
		// 50 of the second follows — with world food over the lot, nothing is
		// left to gather rates for.
		assert.equal(rates.food, 0);
		// Wood's short-pane baseline stays from the config: 100 over 30s.
		assert.ok(Math.abs(rates.wood - 100 / 30) < 1e-9);
	});

	it("hands scarce resources to the queues with the highest priority", () =>
	{
		const gameState = worldWithResources({ food: 400 });
		const manager = makeManager(makeConfig({ priorities: { favourite: 300, other: 100 } }), {
			favourite: [makePlan({ getCost: costOf(300) })],
			other: [makePlan({ type: "other", getCost: costOf(300) })]
		});

		manager.distributeResources(gameState);

		assert.equal(account(manager, "favourite").food, 300,
			"the highest priority queue is funded for its whole item");
		assert.equal(account(manager, "other").food, 100,
			"the low priority queue gets whatever is left");
	});

	it("relegates a queue that can already pay its first item", () =>
	{
		// Both queues want 200 food total. `settled` has already banked its
		// first item's cost, so its share is halved despite the other having
		// twice the priority.
		const gameState = worldWithResources({ food: 200 });
		const manager = makeManager(makeConfig({ priorities: { settled: 100, hungry: 200 } }), {
			settled: [
				makePlan({ getCost: costOf(100) }),
				makePlan({ type: "second", getCost: costOf(100) })
			],
			hungry: [makePlan({ type: "other", getCost: costOf(200) })]
		});
		account(manager, "settled").food = 100;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "hungry").food, 80);
		assert.equal(account(manager, "settled").food, 120,
			"a queue whose first item is already paid shares at only half priority");
	});

	it("takes no share for a paused queue", () =>
	{
		const gameState = worldWithResources({ food: 200 });
		const queues: Record<string, Queue> = {
			active: Object.assign(new Queue(), {}),
			paused: new Queue()
		};
		queues.active.addPlan(makePlan({ getCost: costOf(300) }));
		queues.paused.addPlan(makePlan({ type: "other", getCost: costOf(300) }));
		queues.paused.paused = true;
		const manager = new QueueManager(makeConfig({ priorities: { active: 100, paused: 900 } }), queues);

		manager.distributeResources(gameState);

		assert.equal(account(manager, "active").food, 200);
		assert.equal(account(manager, "paused").food, 0, "a paused queue takes no resources");
	});

	it("releases the resources of an overfunded account", () =>
	{
		// The queue's cap is the first item plus 60% of the next: 100 + 60 = 160.
		const gameState = worldWithResources({ food: 500 });
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
			a: [makePlan({ getCost: costOf(100) }), makePlan({ type: "second", getCost: costOf(100) })]
		});
		account(manager, "a").food = 300;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "a").food, 160,
			"the account keeps first item and 60% of the next, the rest is released");
	});

	it("compacts accounts so a higher priority queue can afford its item", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const queues: Record<string, Queue> = {
			hungry: new Queue(),
			donor: new Queue(),
			// A queue the compaction never goes through: paused, or with plans.
			parked: new Queue(),
			drained: new Queue()
		};
		queues.hungry.addPlan(makePlan({ getCost: costOf(100) }));
		queues.donor.addPlan(makePlan({ type: "other", getCost: costOf(100) }));
		queues.parked.addPlan(makePlan({ type: "other", getCost: costOf(100) }));
		queues.parked.paused = true;
		const manager = new QueueManager(makeConfig({ priorities: { hungry: 300, donor: 100, parked: 10, drained: 10 } }), queues);
		account(manager, "hungry").food = 0;
		account(manager, "donor").food = 120;
		account(manager, "parked").food = 30;
		account(manager, "drained").food = 10;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "hungry").food, 100,
			"the hungry queue takes what it needs to afford its item");
		assert.equal(account(manager, "donor").food, 20);
		assert.equal(manager.queues.donor.switched, 1, "the donor queue is marked as switched");
		assert.equal(manager.queues.hungry.switched, 0);
		assert.equal(account(manager, "parked").food, 30,
			"a paused queue neither gives nor takes during compaction");
		assert.equal(account(manager, "drained").food, 10,
			"an empty queue keeps its account during compaction");
	});

	it("does not compact accounts from a higher priority queue", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({ priorities: { rich: 300, needy: 100 } }), {
			rich: [makePlan({ getCost: costOf(100) })],
			needy: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "rich").food = 60;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "needy").food, 0,
			"a lower priority queue cannot collect from the rich one");
		assert.equal(account(manager, "rich").food, 60);
	});

	it("leaves a source alone when it cannot complete the item anyway", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({ priorities: { hungry: 300, donor: 100 } }), {
			hungry: [makePlan({ getCost: costOf(200) })],
			donor: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "donor").food = 60;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "donor").food, 60,
			"a source that could not finish the item keeps its account");
		assert.equal(manager.queues.donor.switched, 0);
	});

	it("starts the next item when the account can afford it", () =>
	{
		const gameState = worldWithResources();
		gameState.ai.elapsedTime = seconds(20);
		let started = 0;
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
			a: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});
		account(manager, "a").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 1);
		assert.equal(manager.queues.a.length(), 0, "the started plan leaves the queue");
		assert.equal(account(manager, "a").food, 0, "the account pays for what started");
		assert.equal(manager.finishingTime, 20, "the finishing time marks when it started");
	});

	it("leaves an item it cannot afford", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
			a: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});
		account(manager, "a").food = 50;

		manager.startNextItems(gameState);

		assert.equal(started, 0);
		assert.equal(manager.queues.a.length(), 1, "the plan stays queued");
		assert.equal(account(manager, "a").food, 50, "the account keeps what it has");
	});

	it("leaves an item that cannot start", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
			a: [makePlan({ getCost: costOf(100), canStart: () => false, start: () => { ++started; } })]
		});
		account(manager, "a").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 0, "a plan that cannot start is not started");
		assert.equal(manager.queues.a.length(), 1);
	});

	it("resets the account of a queue that finished", () =>
	{
		const gameState = worldWithResources();
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { a: [] });
		account(manager, "a").food = 50;
		manager.queues.a.switched = 2;

		manager.startNextItems(gameState);

		assert.equal(account(manager, "a").food, 0, "an empty queue keeps no account");
		assert.equal(manager.queues.a.switched, 0, "and loses its switch debt");
	});

	// only the port passes: the original re-sorts queueArrays in place while
	// startNextItems walks it, so once the house queue drops behind the field
	// queue the loop skips the field and comes back to the houses
	it("visits every queue once in a turn when a started plan resets its queue's priority", () =>
	{
		const gameState = worldWithResources();
		let houses = 0;
		let fields = 0;
		// A house plan raised its queue for a pop-cap emergency; starting it
		// puts the queue back to its normal priority (a plan's queueToReset).
		const house = (): PetraRuntime.ConcretePlan => makePlan({
			getCost: costOf(50),
			start: () =>
			{
				++houses;
				manager.changePriority("house", 20);
			}
		});
		const manager = makeManager(makeConfig({ priorities: { house: 1000, field: 50, economicBuilding: 30 } }), {
			house: [house(), house()],
			field: [makePlan({ getCost: costOf(100), start: () => { ++fields; } })],
			economicBuilding: []
		});
		account(manager, "house").food = 100;
		account(manager, "field").food = 100;

		manager.startNextItems(gameState);

		assert.equal(fields, 1, "the funded field starts this turn");
		assert.equal(houses, 1, "one house a turn, as for any queue");
		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["field", "economicBuilding", "house"],
			"the next turn sees the new order");
	});

	it("leaves a paused queue's plans and account alone", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const queues: Record<string, Queue> = { a: new Queue() };
		queues.a.addPlan(makePlan({ getCost: costOf(100), start: () => { ++started; } }));
		queues.a.paused = true;
		const manager = new QueueManager(makeConfig({ priorities: { a: 1 } }), queues);
		account(manager, "a").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 0, "a paused queue starts nothing");
		assert.equal(account(manager, "a").food, 100, "a paused queue keeps its account");
	});

	it("says whether a queue can afford a cost", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { a: [] });
		account(manager, "a").food = 30;

		assert.equal(manager.canAfford("a", food(20)), true);
		assert.equal(manager.canAfford("a", food(40)), false);
		assert.equal(manager.canAfford("unknown", food(1)), false,
			"an account-less queue cannot afford anything");
	});

	it("stops a queue from using its account when asked", () =>
	{
		const gameState = worldWithResources();
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2 } }), { a: [], b: [] });
		account(manager, "a").food = 30;
		account(manager, "b").food = 30;

		manager.pauseQueue("a", true);

		assert.equal(manager.queues.a.paused, true);
		assert.equal(account(manager, "a").food, 0, "a scrapped account is emptied");
		assert.equal(account(manager, "b").food, 30, "another queue's account is not touched");

		manager.unpauseQueue("a");
		assert.equal(manager.queues.a.paused, false);

		// Without scrapping, the account survives the pause.
		manager.pauseQueue("a", false);
		assert.equal(account(manager, "a").food, 0, "it was already scrapped");
		account(manager, "a").food = 10;
		manager.pauseQueue("a", false);
		assert.equal(account(manager, "a").food, 10, "the account survives a non-scrapping pause");

		// A queue that does not exist can neither be paused nor resumed.
		manager.pauseQueue("ghost", true);
		manager.unpauseQueue("ghost");
		assert.equal(manager.queues.ghost, undefined);
	});

	it("pauses every queue but one, then lets every queue but one run", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2, c: 3 } }), { a: [], b: [], c: [] });
		account(manager, "a").food = 10;
		account(manager, "b").food = 20;
		account(manager, "c").food = 30;

		manager.pauseAll(true, "b");

		assert.equal(manager.queues.a.paused, true);
		assert.equal(manager.queues.c.paused, true);
		assert.equal(manager.queues.b.paused, false, "the excepted queue keeps running");
		assert.equal(account(manager, "a").food, 0, "scrapped accounts are emptied");
		assert.equal(account(manager, "c").food, 0);
		assert.equal(account(manager, "b").food, 20, "the excepted queue keeps its account");

		manager.unpauseAll("a");

		assert.equal(manager.queues.c.paused, false);
		assert.equal(manager.queues.b.paused, false);
		assert.equal(manager.queues.a.paused, true, "the excepted queue stays paused");
	});

	it("adds a queue with its priority and account", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 100 } }), { a: [] });

		manager.addQueue("emergency", 70);

		assert.notEqual(manager.queues.emergency, undefined, "the queue exists");
		assert.equal(manager.getPriority("emergency"), 70);
		assert.equal(manager.accounts.emergency.Serialize().amounts.food, 0, "a fresh queue starts empty-handed");
		const names = manager.queueArrays.map((entry) => entry[0]);
		assert.deepEqual(names, ["a", "emergency"], "the new queue is sorted into place");

		// Adding a queue that exists changes nothing.
		manager.addQueue("emergency", 900);
		assert.equal(manager.getPriority("emergency"), 70, "an existing queue keeps its priority");
	});

	it("removes a queue with its priority and account", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { old: 100, remaining: 300, newcomer: 50 } }), { old: [], remaining: [], newcomer: [] });

		manager.removeQueue("old");

		assert.equal(manager.queues.old, undefined);
		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["remaining", "newcomer"],
			"the rest re-sorts without the removed queue");

		const before = Object.keys(manager.queues).length;
		manager.removeQueue("never-had");
		assert.equal(Object.keys(manager.queues).length, before, "removing an unknown queue is a no-op");
	});

	it("re-orders the queues when a priority changes", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { low: 100, high: 200 } }), { low: [], high: [] });
		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["high", "low"]);

		manager.changePriority("low", 500);
		assert.deepEqual(manager.queueArrays.map((entry) => entry[0]), ["low", "high"]);

		// A queue that does not exist keeps its absent priority.
		manager.changePriority("ghost", 999);
		assert.equal(manager.priorities.ghost, undefined);
	});

	it("hands an exact amount over between two accounts", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2 } }), { a: [], b: [] });
		account(manager, "a").food = 100;

		manager.transferAccounts(food(60), "a", "b");
		assert.equal(account(manager, "a").food, 40);
		assert.equal(account(manager, "b").food, 60);

		// A queue that already holds more than the cost asks for nothing.
		manager.transferAccounts(food(10), "a", "b");
		assert.equal(account(manager, "a").food, 40, "no transfer when the target has enough");
	});

	it("caps a method-set account at what the world actually gives", () =>
	{
		const gameState = worldWithResources({ food: 30 });
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { a: [] });

		manager.setAccounts(gameState, food(100), "a");
		assert.equal(account(manager, "a").food, 30, "the account only takes what the world had");

		const again = worldWithResources({ food: 90 });
		manager.setAccounts(again, food(100), "a");
		assert.equal(account(manager, "a").food, 90, "a second call tops up to the new world");

		// A cost the account already covers asks for nothing.
		const rich = worldWithResources({ food: 0 });
		manager.setAccounts(rich, food(50), "a");
		assert.equal(account(manager, "a").food, 90, "the already-covered account takes nothing");
	});

	it("empties every queue it owns", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { a: 1, b: 2 } }), {
			a: [makePlan()],
			b: [makePlan({ type: "other" })]
		});

		manager.clear();

		assert.equal(manager.queues.a.length(), 0);
		assert.equal(manager.queues.b.length(), 0);
	});

	it("runs one full turn: fund, then start what the money bought", () =>
	{
		const gameState = worldWithResources({ food: 300 });
		gameState.ai.HQ = fake<Headquarters>({ hasPotentialBase: () => true });
		gameState.ai.elapsedTime = seconds(20);
		gameState.countOwnEntitiesAndQueuedWithRole = (role: string) => role === "worker" ? 100 : 0;

		let started = 0;
		const manager = makeManager(makeConfig({ priorities: { villager: 100 } }), {
			villager: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});

		manager.update(gameState);

		assert.equal(started, 1, "the plan got its resources within the turn and started");
		assert.equal(manager.queues.villager.length(), 0);
		assert.equal(account(manager, "villager").food, 0);
	});

	it("repairs a zero priority and asks for a report", () =>
	{
		const gameState = worldWithResources();
		gameState.ai.HQ = fake<Headquarters>({ hasPotentialBase: () => true });
		gameState.countOwnEntitiesAndQueuedWithRole = () => 100;
		const logged = logs.length;
		const manager = makeManager(makeConfig({ priorities: { military: 0 } }), { military: [] });

		manager.update(gameState);

		assert.equal(manager.priorities.military, 1, "the manager repairs the priority");
		assert.ok(
			logs.slice(logged).some((message) => message.includes("bad priorities")),
			"the manager asks for a report about the broken priorities"
		);
	});

	it("prints its queue overview every 50 turns at verbose log levels", () =>
	{
		const gameState = worldWithResources({ food: 300 });
		override(gameState, { "getPopulation": () => 42 });
		override(gameState, { "getOwnUnits": () => [] });
		gameState.ai.HQ = fake<Headquarters>({
			"hasPotentialBase": () => true,
			"GetWantedGatherRates": () => ({}),
			"GetCurrentGatherRates": () => ({}),
			"pickMostNeededResources": () => []
		});
		gameState.ai.elapsedTime = seconds(20);
		gameState.ai.playedTurn = 50;
		gameState.countOwnEntitiesAndQueuedWithRole = () => 100;
		const logged = logs.length;
		const manager = makeManager(makeConfig({ debug: 2, priorities: { a: 1 } }), { a: [] });

		manager.update(gameState);

		assert.ok(
			logs.slice(logged).some((message) => message.includes("---------- QUEUES")),
			"the turn at the 50-turn mark paints the overview"
		);
	});

	it("serializes its queues, accounts and priorities", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { military: 500 } }), { military: [] });
		manager.queues.military.paused = true;
		manager.queues.military.switched = 2;
		account(manager, "military").food = 55;

		const data = manager.Serialize();

		assert.deepEqual(data.priorities, { military: 500 });
		assert.equal(data.accounts.military.amounts.food, 55);
		assert.equal(data.queues.military.paused, true);
		assert.equal(data.queues.military.switched, 2);
	});

	it("restores its queues, accounts and priorities from a save", () =>
	{
		const gameState = worldWithResources();
		const manager = makeManager(makeConfig({ priorities: { a: 100, b: 300 } }), { a: [], b: [] });
		account(manager, "a").food = 55;
		manager.queues.a.paused = true;
		manager.queues.a.switched = 2;

		const restored = makeManager(makeConfig());
		restored.Deserialize(gameState, manager.Serialize());

		assert.deepEqual(restored.priorities, { a: 100, b: 300 });
		assert.deepEqual(restored.queueArrays.map((entry) => entry[0]), ["b", "a"],
			"the queues come back in priority order");
		assert.equal(account(restored, "a").food, 55);
		assert.equal(restored.queues.a.paused, true, "the paused flag comes from the save");
		assert.equal(restored.queues.a.switched, 2, "the switched flag comes from the save");
	});

	it("wants long-horizon rates for what it is not ready to start", () =>
	{
		const gameState = worldWithResources({ food: 200 });
		gameState.ai.playedTurn = 2;
		const manager = makeManager(makeConfig(), {
			a: [
				makePlan({ getCost: costOf(100) }),
				makePlan({ type: "later", getCost: costOf(120), isGo: () => false })
			]
		});

		const rates = manager.wantedGatherRates(gameState);

		// The short horizon (config baseline 100 plus the ready item's 100) is
		// met exactly by the world's 200 food. What remains for rates is the
		// held-back item's 120, amortized over the 300-second horizon the code
		// assumes for not-go plans.
		assert.ok(Math.abs(rates.food - 120 / 300) < 1e-9);
		assert.ok(Math.abs(rates.wood - 100 / 30) < 1e-9,
			"the wood baseline keeps the config's short-horizon pace");
	});

	it("ignores a paused queue when sizing the gather rates", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		gameState.ai.playedTurn = 2;
		const manager = makeManager(makeConfig(), {
			a: [makePlan({ getCost: costOf(500) })]
		});
		manager.queues.a.paused = true;

		const rates = manager.wantedGatherRates(gameState);

		// The queue holds a 500-food plan, but while it is paused the config's
		// own baselines are all that is wanted.
		assert.ok(Math.abs(rates.food - 100 / 30) < 1e-9);
	});

	it("stops counting plans after the first two when sizing the gather rates", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		gameState.ai.playedTurn = 2;
		const manager = makeManager(makeConfig(), {
			a: [
				makePlan({ type: "first", getCost: costOf(100) }),
				makePlan({ type: "second", getCost: costOf(50) }),
				makePlan({ type: "third", getCost: costOf(70) })
			]
		});

		const rates = manager.wantedGatherRates(gameState);

		// First item over the 30s horizon, second over the 60s one, and the
		// third is not looked at at all.
		assert.ok(Math.abs(rates.food - (200 / 30 + 50 / 60)) < 1e-9);
	});

	it("writes an overview of itself, its queues and its plans for the log", () =>
	{
		const gameState = worldWithResources({ food: 111 });
		override(gameState, { "getPopulation": () => 42 });
		// One unassigned worker: enough to be counted into the header.
		override(gameState, { "getOwnUnits": () =>
			[{ "getMetadata": (_player: number, key: string) => key === "role" ? "worker" : undefined }] });
		gameState.ai.HQ = fake<Headquarters>({
			"GetWantedGatherRates": () => ({ food: 1 }),
			"GetCurrentGatherRates": () => ({ food: 0.5 }),
			"pickMostNeededResources": () => ["food"]
		});
		const manager = makeManager(makeConfig({ priorities: { military: 500, reserve: 1 } }),
		{
			military: [makePlan({ number: 3 })],
			// A queue that is momentarily empty still shows in the overview.
			reserve: []
		});

		const logged = logs.length;
		manager.printQueues(gameState);

		const written = logs.slice(logged);
		assert.ok(written.some((message) => message.includes("---------- QUEUES ------------ with pop 42 and workers 1")),
			"the header names the population and the free workers");
		assert.ok(written.some((message) => message.includes("military: ( with priority 500 and accounts")),
			"the running queue and its priority");
		assert.ok(written.some((message) => message.includes("test_unit x3")), "the plan with its count");
		assert.ok(written.some((message) => message.includes("Accounts")), "the accounts section");
		assert.ok(written.some((message) => message.includes("Current Resources: ")), "what the world holds");
		assert.ok(written.some((message) => message.includes("Available Resources: ")), "what is unaccounted");
		assert.ok(written.some((message) => message.includes("Wanted Gather Rates: ")), "the wanted rates");
		assert.ok(written.some((message) => message.includes("Most needed resources: ")), "the needs ranking");
	});

	it("rescale accounts that the world has spent beneath", () =>
	{
		// Bartering can spend resources already earmarked by accounts, leaving
		// them overdrawn: each account keeps its share of what is left.
		const gameState = worldWithResources({ food: 101 });
		const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { a: [makePlan({ getCost: costOf(100) })] });
		account(manager, "a").food = 150;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "a").food, 101,
			"the overdrawn account shrinks to the same fixed share of the world");
	});

	it("hands the rounding leftover to the first queue it looks at", () =>
	{
		// 3 food across two equal-priority queues floors to 1 each; the last
		// unit goes to the queue walked first, whoever has the higher priority.
		const gameState = worldWithResources({ food: 3 });
		const manager = makeManager(makeConfig({ priorities: { zulu: 100, alpha: 100 } }), {
			zulu: [makePlan({ getCost: costOf(200) })],
			alpha: [makePlan({ type: "other", getCost: costOf(200) })]
		});

		manager.distributeResources(gameState);

		assert.equal(account(manager, "zulu").food, 2, "the first-declared queue takes the leftover");
		assert.equal(account(manager, "alpha").food, 1);
	});

	it("names the queues and amount it switched, when the level asks for it", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({
			debug: 3,
			priorities: { hungry: 300, donor: 100 }
		}), {
			hungry: [makePlan({ getCost: costOf(100) })],
			donor: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "donor").food = 120;

		const logged = logs.length;
		manager.switchResource(gameState, "food");

		assert.ok(
			logs.slice(logged).some((message) => message.includes(
				"switching queue food from donor to hungry in amount 100")),
			"the switch log names both queues and the exact amount"
		);
	});

	it("logs a priority change when the level asks for it", () =>
	{
		const manager = makeManager(makeConfig({ debug: 2, priorities: { low: 100 } }), { low: [] });

		const logged = logs.length;
		manager.changePriority("low", 500);

		assert.ok(logs.slice(logged).some((message) => message.includes(
			">>> Priority of queue low changed from 100 to 500")));
	});

	it("logs its own serialization when asked to", () =>
	{
		const manager = makeManager(makeConfig({ debug: -100, priorities: { a: 1 } }), { a: [] });

		const logged = logs.length;
		manager.Serialize();

		assert.ok(logs.slice(logged).some((message) => message.includes(
			"queueManager serialization: queue a")));
	});

	// checkPausedQueues reads the workforce against a target: with the config
	// under test the target is 24 workers, its first pause tier then kicks in
	// below 8, the second below 16, and everything runs again at 24 or more.
	describe("checkPausedQueues", () =>
	{
		/**
		 * A world with a worker count and the headquarters answers the manager
		 * asks about. `stateOptions` go to the fake game state itself, so a
		 * test can give the world structures of its own.
		 */
		function workerWorld(
			numWorkers: number,
			hq: Record<string, unknown> = {},
			stateOptions: Parameters<typeof makeFakeGameState>[0] = {}
		): CommonGameState
		{
			const { gameState } = makeFakeGameState(stateOptions);
			override(gameState, { "getResources": () => new ResourcesManager({}) });
			gameState.ai.HQ = fake<Headquarters>({ "hasPotentialBase": () => true, ...hq });
			gameState.countOwnEntitiesAndQueuedWithRole = () => numWorkers;
			return gameState;
		}

		it("pauses everything but the dock and the civil centre when baseless", () =>
		{
			const gameState = workerWorld(100, { "hasPotentialBase": () => false });
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				dock: [],
				civilCentre: [],
				economicBuilding: [makePlan({ type: "other" })]
			});
			account(manager, "economicBuilding").food = 40;

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.dock.paused, false, "the dock is kept for crossing");
			assert.equal(manager.queues.civilCentre.paused, false, "the civil centre keeps going");
			assert.equal(manager.queues.economicBuilding.paused, true);
			assert.equal(account(manager, "economicBuilding").food, 0,
				"pausing scraps the queue's account");
		});

		it("pauses the buildings and technologies while at a third of the workers", () =>
		{
			const gameState = workerWorld(5, {});
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				citizenSoldier: [],
				villager: [],
				emergency: [],
				economicBuilding: [makePlan({ type: "other" })]
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.citizenSoldier.paused, false, "the workforce trains on");
			assert.equal(manager.queues.villager.paused, false);
			assert.equal(manager.queues.emergency.paused, false);
			assert.equal(manager.queues.economicBuilding.paused, true,
				"a builder queue waits for a healthier workforce");
		});

		it("pauses buildings and technologies while below two-thirds of the workers", () =>
		{
			const gameState = workerWorld(15, {});
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				citizenSoldier: [],
				economicBuilding: [],
				healer: [],
				minorTech: [],
				plan_breakthrough: [makePlan({ getCost: costOf(10) })]
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.citizenSoldier.paused, false, "the army trains on");
			assert.equal(manager.queues.economicBuilding.paused, true, "buildings wait");
			assert.equal(manager.queues.healer.paused, true, "healers wait");
			assert.equal(manager.queues.minorTech.paused, true, "research waits");
			assert.equal(manager.queues.plan_breakthrough.paused, true, "attack queues wait");
		});

		it("keeps only the squads on while short of the full workforce", () =>
		{
			// 20 workers is short of the 24 target but above two-thirds of it.
			const gameState = workerWorld(20, {});
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				civilCentre: [],
				defenseBuilding: [],
				majorTech: [],
				plan_siege: [],
				plan_champ: [],
				villager: [],
				healer: []
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.civilCentre.paused, true, "a new centre waits");
			assert.equal(manager.queues.defenseBuilding.paused, true, "defense wait");
			assert.equal(manager.queues.majorTech.paused, true, "the new phase waits");
			assert.equal(manager.queues.plan_siege.paused, true, "siege plans wait");
			assert.equal(manager.queues.plan_champ.paused, true, "champ plans wait");
			assert.equal(manager.queues.villager.paused, false, "villagers keep training");
			assert.equal(manager.queues.healer.paused, false, "healers are kept above this tier");
		});

		it("shrinks an attack queue to single units while workers are scarce", () =>
		{
			const gameState = workerWorld(15, {});
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				plan_breakthrough: [
					makePlan({ type: "first" }),
					makePlan({ type: "second" }),
					makePlan({ type: "third" })
				]
			});
			manager.queues.plan_breakthrough.plans.forEach((plan) => { plan.number = 5; });

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.plan_breakthrough.plans[0].number, 1,
				"the leading plan loses its batch");
			assert.equal(manager.queues.plan_breakthrough.plans[1].number, 1,
				"the second plan loses its batch too");
			assert.equal(manager.queues.plan_breakthrough.plans[2].number, 5,
				"only the first two plans are shrunk");
		});

		it("lets a queue run again once the workers are back", () =>
		{
			const gameState = workerWorld(100, {});
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { defenseBuilding: [] });
			manager.queues.defenseBuilding.paused = true;

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.defenseBuilding.paused, false,
				"a fully staffed AI unpauses what it paused");
		});

		it("keeps the survival structures going when they are missing", () =>
		{
			// Almost no workers, so everything that is not workforce would
			// pause — unless the economy is missing it. No farm, no corral, no
			// dock and no fishing boat stand, and the headquarters wants each.
			const gameState = workerWorld(5, {
				"needFarm": true,
				"needCorral": true,
				"needFish": true,
				"navalManager": { "ships": { "filter": () => ({ "hasEntities": () => false }) } }
			}, { ownStructures: [] });
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), {
				field: [],
				corral: [],
				dock: [],
				ships: [],
				economicBuilding: []
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.field.paused, false, "the missing farm keeps its queue");
			assert.equal(manager.queues.corral.paused, false, "the missing corral keeps its queue");
			assert.equal(manager.queues.dock.paused, false, "the missing dock keeps its queue");
			assert.equal(manager.queues.ships.paused, false, "missing fishing boats keep ship plans");
			assert.equal(manager.queues.economicBuilding.paused, true);
		});

		it("pauses the farm when there is one to run", () =>
		{
			const gameState = workerWorld(5, { "needFarm": false });
			const manager = makeManager(makeConfig({ priorities: { a: 1 } }), { field: [] });

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.field.paused, true,
				"with no need for a farm, the queue waits like any other");
		});
	});
});
