/**
 * QueueManager: how Petra funds the queues it owns.
 *
 * The manager divides the resources the world provides between per-queue
 * accounts, guided by queue priorities, and starts a queue's next plan when its
 * account can pay for it. A plan and its cost are faked the way queue.test.ts
 * fakes them — the manager only ever asks a plan for its `getCost()`, whether
 * it is `canStart`-able, and whether it says it is `go` — while the queues
 * themselves and the `ResourcesManager` accounts are the real ones the plans
 * flow through. The manager owns the 18 queues the configuration sets up, as
 * in a game, and a test's plans sit in the queues it names; the others stay
 * empty, which takes them out of the funding.
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
import { QueueManager, configuredQueues, isQueueName } from "../execution/queueManager.ts";

function food(amount: number): ResourcesManager
{
	return new ResourcesManager({ food: amount }, 0);
}

function costOf(amount: number): () => ResourcesManager
{
	// A fresh object each call: maxAccountWanted multiplies what it is given.
	return () => food(amount);
}

type ConfigOverrides = Omit<Partial<Config>, "priorities"> & {
	priorities?: Partial<Record<PetraRuntime.ConfiguredQueueName, number>>;
};

/** Petra's tuning, with the queue rates these tests reckon with and the priorities a test sets laid over the real ones. */
function makeConfig(overrides: ConfigOverrides = {}): Config
{
	const config = new Config();
	return Object.assign(config, {
		queues: {
			firstTurn: { "food": 10, "default": 0 },
			short: { "default": 100 },
			medium: { "default": 0 },
			long: { "default": 0 }
		},
		...overrides,
		priorities: { ...config.priorities, ...overrides.priorities }
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

/** A manager over the configured queues (and the attack queues named), the named ones pre-loaded with their plans. */
function makeManager(config: Config, plans: { [K in PetraRuntime.QueueName]?: PetraRuntime.ConcretePlan[] } = {}): QueueManager
{
	const queues = configuredQueues();
	for (const name in plans)
	{
		if (!isQueueName(config, name))
			continue;
		const queue = queues[name] ?? new Queue();
		queues[name] = queue;
		for (const plan of plans[name] ?? [])
			queue.addPlan(plan);
	}
	return new QueueManager(config, queues);
}

/** The manager's order of the named queues, the others left out. */
function orderOf(manager: QueueManager, names: string[]): string[]
{
	return manager.queueArrays.map((entry) => entry[0]).filter((name) => names.includes(name));
}

describe("QueueManager", () =>
{
	it("copies its priorities from the config", () =>
	{
		const config = makeConfig({ priorities: { villager: 300, militaryBuilding: 600 } });
		const manager = makeManager(config);

		assert.deepEqual(manager.priorities, config.priorities);
		assert.equal(manager.priorities.militaryBuilding, 600);

		// The priorities are the manager's working copy, not the config's: a
		// changePriority must not rewrite the config it was given.
		manager.priorities.villager = 999;
		assert.equal(config.priorities.villager, 300, "the config keeps its own numbers");
	});

	it("opens a zero account for every queue it is handed", () =>
	{
		const manager = makeManager(makeConfig());

		assert.deepEqual(Object.keys(manager.accounts), Object.keys(configuredQueues()));
		for (const name in manager.accounts)
			assert.equal(manager.accounts[name].Serialize().amounts.food, 0, name);
	});

	it("orders its queues by priority, highest first", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { house: 1, villager: 300, trader: 10 } }));

		assert.deepEqual(orderOf(manager, ["house", "villager", "trader"]), ["villager", "trader", "house"]);
	});

	it("orders equally prioritised queues by name", () =>
	{
		// the field is set up before the dock (Config.priorities' order)
		const manager = makeManager(makeConfig({ priorities: { field: 100, dock: 100 } }));

		assert.deepEqual(orderOf(manager, ["field", "dock"]), ["dock", "field"]);
	});

	it("breaks priority ties whichever way the record lists them", () =>
	{
		// Set up house, corral, wonder: sorting meets the tied names in both
		// orders, so both arms of the name tie-break run.
		const manager = makeManager(makeConfig({ priorities: { house: 100, corral: 100, wonder: 100 } }));

		assert.deepEqual(orderOf(manager, ["house", "corral", "wonder"]), ["corral", "house", "wonder"]);
	});

	it("sees the world's resources that no account holds", () =>
	{
		const gameState = worldWithResources({ food: 100 });
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 30;

		assert.equal(manager.getAvailableResources(gameState).Serialize().amounts.food, 70);
		assert.equal(manager.getTotalAccountedResources().Serialize().amounts.food, 30,
			"the total accounted is the sum of the accounts");
	});

	it("needs what its queues' first plans cost, minus what the world holds", () =>
	{
		const gameState = worldWithResources({ food: 20 });
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100) })],
			citizenSoldier: [makePlan({ type: "no", getCost: costOf(999), isGo: () => false })]
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
			villager: [makePlan({ getCost: costOf(100) }), makePlan({ type: "second", getCost: costOf(50) })]
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
		const manager = makeManager(makeConfig({ priorities: { citizenSoldier: 300, trader: 100 } }), {
			citizenSoldier: [makePlan({ getCost: costOf(300) })],
			trader: [makePlan({ type: "other", getCost: costOf(300) })]
		});

		manager.distributeResources(gameState);

		assert.equal(account(manager, "citizenSoldier").food, 300,
			"the highest priority queue is funded for its whole item");
		assert.equal(account(manager, "trader").food, 100,
			"the low priority queue gets whatever is left");
	});

	it("relegates a queue that can already pay its first item", () =>
	{
		// Both queues want 200 food total. The houses have already banked
		// their first item's cost, so their share is halved although the
		// fields have twice the priority.
		const gameState = worldWithResources({ food: 200 });
		const manager = makeManager(makeConfig({ priorities: { house: 100, field: 200 } }), {
			house: [
				makePlan({ getCost: costOf(100) }),
				makePlan({ type: "second", getCost: costOf(100) })
			],
			field: [makePlan({ type: "other", getCost: costOf(200) })]
		});
		account(manager, "house").food = 100;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "field").food, 80);
		assert.equal(account(manager, "house").food, 120,
			"a queue whose first item is already paid shares at only half priority");
	});

	it("takes no share for a paused queue", () =>
	{
		const gameState = worldWithResources({ food: 200 });
		const manager = makeManager(makeConfig({ priorities: { villager: 100, emergency: 900 } }), {
			villager: [makePlan({ getCost: costOf(300) })],
			emergency: [makePlan({ type: "other", getCost: costOf(300) })]
		});
		manager.queues.emergency.paused = true;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "villager").food, 200);
		assert.equal(account(manager, "emergency").food, 0, "a paused queue takes no resources");
	});

	it("releases the resources of an overfunded account", () =>
	{
		// The queue's cap is the first item plus 60% of the next: 100 + 60 = 160.
		const gameState = worldWithResources({ food: 500 });
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100) }), makePlan({ type: "second", getCost: costOf(100) })]
		});
		account(manager, "villager").food = 300;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "villager").food, 160,
			"the account keeps first item and 60% of the next, the rest is released");
	});

	it("compacts accounts so a higher priority queue can afford its item", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		// the soldiers are short, the traders can give; the healers' queue is
		// paused with a plan, the wonder's empty: compaction passes both by
		const manager = makeManager(makeConfig({ priorities: { citizenSoldier: 300, trader: 100, healer: 10, wonder: 10 } }), {
			citizenSoldier: [makePlan({ getCost: costOf(100) })],
			trader: [makePlan({ type: "other", getCost: costOf(100) })],
			healer: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		manager.queues.healer.paused = true;
		account(manager, "trader").food = 120;
		account(manager, "healer").food = 30;
		account(manager, "wonder").food = 10;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "citizenSoldier").food, 100,
			"the hungry queue takes what it needs to afford its item");
		assert.equal(account(manager, "trader").food, 20);
		assert.equal(manager.queues.trader.switched, 1, "the donor queue is marked as switched");
		assert.equal(manager.queues.citizenSoldier.switched, 0);
		assert.equal(account(manager, "healer").food, 30,
			"a paused queue neither gives nor takes during compaction");
		assert.equal(account(manager, "wonder").food, 10,
			"an empty queue keeps its account during compaction");
	});

	it("does not compact accounts from a higher priority queue", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({ priorities: { citizenSoldier: 300, trader: 100 } }), {
			citizenSoldier: [makePlan({ getCost: costOf(100) })],
			trader: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "citizenSoldier").food = 60;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "trader").food, 0,
			"a lower priority queue cannot collect from the rich one");
		assert.equal(account(manager, "citizenSoldier").food, 60);
	});

	it("leaves a source alone when it cannot complete the item anyway", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({ priorities: { citizenSoldier: 300, trader: 100 } }), {
			citizenSoldier: [makePlan({ getCost: costOf(200) })],
			trader: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "trader").food = 60;

		manager.switchResource(gameState, "food");

		assert.equal(account(manager, "trader").food, 60,
			"a source that could not finish the item keeps its account");
		assert.equal(manager.queues.trader.switched, 0);
	});

	it("starts the next item when the account can afford it", () =>
	{
		const gameState = worldWithResources();
		gameState.ai.elapsedTime = seconds(20);
		let started = 0;
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});
		account(manager, "villager").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 1);
		assert.equal(manager.queues.villager.length(), 0, "the started plan leaves the queue");
		assert.equal(account(manager, "villager").food, 0, "the account pays for what started");
		assert.equal(manager.finishingTime, 20, "the finishing time marks when it started");
	});

	it("leaves an item it cannot afford", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});
		account(manager, "villager").food = 50;

		manager.startNextItems(gameState);

		assert.equal(started, 0);
		assert.equal(manager.queues.villager.length(), 1, "the plan stays queued");
		assert.equal(account(manager, "villager").food, 50, "the account keeps what it has");
	});

	it("leaves an item that cannot start", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100), canStart: () => false, start: () => { ++started; } })]
		});
		account(manager, "villager").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 0, "a plan that cannot start is not started");
		assert.equal(manager.queues.villager.length(), 1);
	});

	it("resets the account of a queue that finished", () =>
	{
		const gameState = worldWithResources();
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 50;
		manager.queues.villager.switched = 2;

		manager.startNextItems(gameState);

		assert.equal(account(manager, "villager").food, 0, "an empty queue keeps no account");
		assert.equal(manager.queues.villager.switched, 0, "and loses its switch debt");
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
			field: [makePlan({ getCost: costOf(100), start: () => { ++fields; } })]
		});
		account(manager, "house").food = 100;
		account(manager, "field").food = 100;

		manager.startNextItems(gameState);

		assert.equal(fields, 1, "the funded field starts this turn");
		assert.equal(houses, 1, "one house a turn, as for any queue");
		assert.deepEqual(orderOf(manager, ["house", "field", "economicBuilding"]), ["field", "economicBuilding", "house"],
			"the next turn sees the new order");
	});

	it("leaves a paused queue's plans and account alone", () =>
	{
		const gameState = worldWithResources();
		let started = 0;
		const manager = makeManager(makeConfig(), {
			villager: [makePlan({ getCost: costOf(100), start: () => { ++started; } })]
		});
		manager.queues.villager.paused = true;
		account(manager, "villager").food = 100;

		manager.startNextItems(gameState);

		assert.equal(started, 0, "a paused queue starts nothing");
		assert.equal(account(manager, "villager").food, 100, "a paused queue keeps its account");
	});

	it("says whether a queue can afford a cost", () =>
	{
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 30;

		assert.equal(manager.canAfford("villager", food(20)), true);
		assert.equal(manager.canAfford("villager", food(40)), false);
		assert.equal(manager.canAfford("plan_99", food(1)), false,
			"an account-less queue (an attack plan's never added) cannot afford anything");
	});

	it("stops a queue from using its account when asked", () =>
	{
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 30;
		account(manager, "citizenSoldier").food = 30;

		manager.pauseQueue("villager", true);

		assert.equal(manager.queues.villager.paused, true);
		assert.equal(account(manager, "villager").food, 0, "a scrapped account is emptied");
		assert.equal(account(manager, "citizenSoldier").food, 30, "another queue's account is not touched");

		manager.unpauseQueue("villager");
		assert.equal(manager.queues.villager.paused, false);

		// Without scrapping, the account survives the pause.
		manager.pauseQueue("villager", false);
		assert.equal(account(manager, "villager").food, 0, "it was already scrapped");
		account(manager, "villager").food = 10;
		manager.pauseQueue("villager", false);
		assert.equal(account(manager, "villager").food, 10, "the account survives a non-scrapping pause");

		// A queue that does not exist (an attack plan's never added) can neither be paused nor resumed.
		manager.pauseQueue("plan_99", true);
		manager.unpauseQueue("plan_99");
		assert.equal(manager.queues.plan_99, undefined);
	});

	it("pauses every queue but one, then lets every queue but one run", () =>
	{
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 10;
		account(manager, "citizenSoldier").food = 20;
		account(manager, "trader").food = 30;

		manager.pauseAll(true, "citizenSoldier");

		assert.equal(manager.queues.villager.paused, true);
		assert.equal(manager.queues.trader.paused, true);
		assert.equal(manager.queues.citizenSoldier.paused, false, "the excepted queue keeps running");
		assert.equal(account(manager, "villager").food, 0, "scrapped accounts are emptied");
		assert.equal(account(manager, "trader").food, 0);
		assert.equal(account(manager, "citizenSoldier").food, 20, "the excepted queue keeps its account");

		manager.unpauseAll("villager");

		assert.equal(manager.queues.trader.paused, false);
		assert.equal(manager.queues.citizenSoldier.paused, false);
		assert.equal(manager.queues.villager.paused, true, "the excepted queue stays paused");
	});

	it("adds a queue with its priority and account", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { villager: 100 } }));

		// an attack plan's queue, as the plan adds it when it starts preparing
		manager.addQueue("plan_3", 70);

		assert.notEqual(manager.queues.plan_3, undefined, "the queue exists");
		assert.equal(manager.getPriority("plan_3"), 70);
		assert.equal(manager.accounts.plan_3.Serialize().amounts.food, 0, "a fresh queue starts empty-handed");
		assert.deepEqual(orderOf(manager, ["villager", "plan_3"]), ["villager", "plan_3"], "the new queue is sorted into place");

		// Adding a queue that exists changes nothing.
		manager.addQueue("plan_3", 900);
		assert.equal(manager.getPriority("plan_3"), 70, "an existing queue keeps its priority");
	});

	it("removes a queue with its priority and account", () =>
	{
		const manager = makeManager(makeConfig());
		manager.addQueue("plan_1", 100);
		manager.addQueue("plan_2", 300);
		manager.addQueue("plan_3", 50);

		manager.removeQueue("plan_1");

		assert.equal(manager.queues.plan_1, undefined);
		assert.equal(manager.accounts.plan_1, undefined, "its account goes with it");
		assert.deepEqual(orderOf(manager, ["plan_1", "plan_2", "plan_3"]), ["plan_2", "plan_3"],
			"the rest re-sorts without the removed queue");

		const before = Object.keys(manager.queues).length;
		manager.removeQueue("plan_9");
		assert.equal(Object.keys(manager.queues).length, before, "removing an unknown queue is a no-op");
	});

	it("re-orders the queues when a priority changes", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { trader: 100, healer: 200 } }));
		assert.deepEqual(orderOf(manager, ["trader", "healer"]), ["healer", "trader"]);

		manager.changePriority("trader", 500);
		assert.deepEqual(orderOf(manager, ["trader", "healer"]), ["trader", "healer"]);

		// A queue that does not exist keeps its absent priority.
		manager.changePriority("plan_99", 999);
		assert.equal(manager.priorities.plan_99, undefined);
	});

	it("hands an exact amount over between two accounts", () =>
	{
		const manager = makeManager(makeConfig());
		account(manager, "villager").food = 100;

		manager.transferAccounts(food(60), "villager", "emergency");
		assert.equal(account(manager, "villager").food, 40);
		assert.equal(account(manager, "emergency").food, 60);

		// A queue that already holds more than the cost asks for nothing.
		manager.transferAccounts(food(10), "villager", "emergency");
		assert.equal(account(manager, "villager").food, 40, "no transfer when the target has enough");
	});

	it("caps a method-set account at what the world actually gives", () =>
	{
		const gameState = worldWithResources({ food: 30 });
		const manager = makeManager(makeConfig());

		manager.setAccounts(gameState, food(100), "emergency");
		assert.equal(account(manager, "emergency").food, 30, "the account only takes what the world had");

		const again = worldWithResources({ food: 90 });
		manager.setAccounts(again, food(100), "emergency");
		assert.equal(account(manager, "emergency").food, 90, "a second call tops up to the new world");

		// A cost the account already covers asks for nothing.
		const rich = worldWithResources({ food: 0 });
		manager.setAccounts(rich, food(50), "emergency");
		assert.equal(account(manager, "emergency").food, 90, "the already-covered account takes nothing");
	});

	it("empties every queue it owns", () =>
	{
		const manager = makeManager(makeConfig(), {
			villager: [makePlan()],
			citizenSoldier: [makePlan({ type: "other" })]
		});

		manager.clear();

		assert.equal(manager.queues.villager.length(), 0);
		assert.equal(manager.queues.citizenSoldier.length(), 0);
	});

	it("runs one full turn: fund, then start what the money bought", () =>
	{
		const gameState = worldWithResources({ food: 300 });
		gameState.ai.HQ = fake<Headquarters>({ hasPotentialBase: () => true });
		gameState.ai.elapsedTime = seconds(20);
		gameState.countOwnEntitiesAndQueuedWithRole = (role: string) => role === "worker" ? 100 : 0;

		let started = 0;
		const manager = makeManager(makeConfig(), {
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
		const manager = makeManager(makeConfig({ priorities: { militaryBuilding: 0 } }));

		manager.update(gameState);

		assert.equal(manager.priorities.militaryBuilding, 1, "the manager repairs the priority");
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
		const manager = makeManager(makeConfig({ debug: 2 }));

		manager.update(gameState);

		assert.ok(
			logs.slice(logged).some((message) => message.includes("---------- QUEUES")),
			"the turn at the 50-turn mark paints the overview"
		);
	});

	it("serializes its queues, accounts and priorities", () =>
	{
		const manager = makeManager(makeConfig({ priorities: { militaryBuilding: 500 } }));
		manager.queues.militaryBuilding.paused = true;
		manager.queues.militaryBuilding.switched = 2;
		account(manager, "militaryBuilding").food = 55;

		const data = manager.Serialize();

		assert.deepEqual(data.priorities, manager.priorities);
		assert.equal(data.priorities.militaryBuilding, 500);
		assert.equal(data.accounts.militaryBuilding.amounts.food, 55);
		assert.equal(data.queues.militaryBuilding.paused, true);
		assert.equal(data.queues.militaryBuilding.switched, 2);
	});

	it("restores its queues, accounts and priorities from a save", () =>
	{
		const gameState = worldWithResources();
		const manager = makeManager(makeConfig({ priorities: { villager: 100, citizenSoldier: 300 } }));
		manager.addQueue("plan_4", 200);
		account(manager, "villager").food = 55;
		manager.queues.villager.paused = true;
		manager.queues.villager.switched = 2;

		const restored = makeManager(makeConfig());
		restored.Deserialize(gameState, manager.Serialize());

		assert.deepEqual(restored.priorities, manager.priorities);
		assert.deepEqual(Object.keys(restored.queues), Object.keys(manager.queues),
			"the same queues, in the same order, an attack plan's included");
		assert.deepEqual(orderOf(restored, ["villager", "citizenSoldier", "plan_4"]), ["citizenSoldier", "plan_4", "villager"],
			"the queues come back in priority order");
		assert.equal(account(restored, "villager").food, 55);
		assert.equal(restored.queues.villager.paused, true, "the paused flag comes from the save");
		assert.equal(restored.queues.villager.switched, 2, "the switched flag comes from the save");
	});

	it("skips a saved queue it does not know, with a warning", () =>
	{
		const gameState = worldWithResources();
		const saved = makeManager(makeConfig()).Serialize();
		// a save from another version, or one a mod changed: a queue the bot has no name for
		saved.queues["military"] = new Queue().Serialize();
		saved.accounts["military"] = new ResourcesManager().Serialize();
		const logged = logs.length;

		const restored = makeManager(makeConfig());
		restored.Deserialize(gameState, saved);

		assert.deepEqual(Object.keys(restored.queues), Object.keys(configuredQueues()), "only the queues it knows");
		assert.equal(restored.accounts["military"], undefined);
		assert.ok(logs.slice(logged).some((message) => message.includes("queue unknown military")));
	});

	it("wants long-horizon rates for what it is not ready to start", () =>
	{
		const gameState = worldWithResources({ food: 200 });
		gameState.ai.playedTurn = 2;
		const manager = makeManager(makeConfig(), {
			villager: [
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
			villager: [makePlan({ getCost: costOf(500) })]
		});
		manager.queues.villager.paused = true;

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
			villager: [
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
		// the other queues are momentarily empty: they still show in the overview
		const manager = makeManager(makeConfig({ priorities: { militaryBuilding: 500 } }),
		{
			militaryBuilding: [makePlan({ number: 3 })]
		});

		const logged = logs.length;
		manager.printQueues(gameState);

		const written = logs.slice(logged);
		assert.ok(written.some((message) => message.includes("---------- QUEUES ------------ with pop 42 and workers 1")),
			"the header names the population and the free workers");
		assert.ok(written.some((message) => message.includes("militaryBuilding: ( with priority 500 and accounts")),
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
		const manager = makeManager(makeConfig(), { villager: [makePlan({ getCost: costOf(100) })] });
		account(manager, "villager").food = 150;

		manager.distributeResources(gameState);

		assert.equal(account(manager, "villager").food, 101,
			"the overdrawn account shrinks to the same fixed share of the world");
	});

	it("hands the rounding leftover to the first queue it looks at", () =>
	{
		// 3 food across two equal-priority queues floors to 1 each; the last
		// unit goes to the queue walked first: the traders' queue is set up
		// before the corral's, though "corral" sorts first by name.
		const gameState = worldWithResources({ food: 3 });
		const manager = makeManager(makeConfig({ priorities: { trader: 100, corral: 100 } }), {
			trader: [makePlan({ getCost: costOf(200) })],
			corral: [makePlan({ type: "other", getCost: costOf(200) })]
		});

		manager.distributeResources(gameState);

		assert.equal(account(manager, "trader").food, 2, "the first-declared queue takes the leftover");
		assert.equal(account(manager, "corral").food, 1);
	});

	it("names the queues and amount it switched, when the level asks for it", () =>
	{
		const gameState = worldWithResources({ food: 0 });
		const manager = makeManager(makeConfig({
			debug: 3,
			priorities: { citizenSoldier: 300, trader: 100 }
		}), {
			citizenSoldier: [makePlan({ getCost: costOf(100) })],
			trader: [makePlan({ type: "other", getCost: costOf(100) })]
		});
		account(manager, "trader").food = 120;

		const logged = logs.length;
		manager.switchResource(gameState, "food");

		assert.ok(
			logs.slice(logged).some((message) => message.includes(
				"switching queue food from trader to citizenSoldier in amount 100")),
			"the switch log names both queues and the exact amount"
		);
	});

	it("logs a priority change when the level asks for it", () =>
	{
		const manager = makeManager(makeConfig({ debug: 2, priorities: { trader: 100 } }));

		const logged = logs.length;
		manager.changePriority("trader", 500);

		assert.ok(logs.slice(logged).some((message) => message.includes(
			">>> Priority of queue trader changed from 100 to 500")));
	});

	it("logs its own serialization when asked to", () =>
	{
		const manager = makeManager(makeConfig({ debug: -100 }));

		const logged = logs.length;
		manager.Serialize();

		assert.ok(logs.slice(logged).some((message) => message.includes(
			"queueManager serialization: queue villager")));
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
			const manager = makeManager(makeConfig(), {
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
			const manager = makeManager(makeConfig(), {
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
			const manager = makeManager(makeConfig(), {
				plan_4: [makePlan({ getCost: costOf(10) })]
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.citizenSoldier.paused, false, "the army trains on");
			assert.equal(manager.queues.economicBuilding.paused, true, "buildings wait");
			assert.equal(manager.queues.healer.paused, true, "healers wait");
			assert.equal(manager.queues.minorTech.paused, true, "research waits");
			assert.equal(manager.queues.plan_4?.paused, true, "attack queues wait");
		});

		it("keeps only the squads on while short of the full workforce", () =>
		{
			// 20 workers is short of the 24 target but above two-thirds of it.
			const gameState = workerWorld(20, {});
			const manager = makeManager(makeConfig(), {
				plan_4_siege: [],
				plan_4_champ: []
			});

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.civilCentre.paused, true, "a new centre waits");
			assert.equal(manager.queues.defenseBuilding.paused, true, "defense wait");
			assert.equal(manager.queues.majorTech.paused, true, "the new phase waits");
			assert.equal(manager.queues.plan_4_siege?.paused, true, "siege plans wait");
			assert.equal(manager.queues.plan_4_champ?.paused, true, "champ plans wait");
			assert.equal(manager.queues.villager.paused, false, "villagers keep training");
			assert.equal(manager.queues.healer.paused, false, "healers are kept above this tier");
		});

		it("shrinks an attack queue to single units while workers are scarce", () =>
		{
			const gameState = workerWorld(15, {});
			const manager = makeManager(makeConfig(), {
				plan_4: [
					makePlan({ type: "first" }),
					makePlan({ type: "second" }),
					makePlan({ type: "third" })
				]
			});
			const attack = manager.queues.plan_4?.plans ?? [];
			attack.forEach((plan) => { plan.number = 5; });

			manager.checkPausedQueues(gameState);

			assert.deepEqual(attack.map((plan) => plan.number), [1, 1, 5],
				"the first two plans lose their batch, the third keeps it");
		});

		it("lets a queue run again once the workers are back", () =>
		{
			const gameState = workerWorld(100, {});
			const manager = makeManager(makeConfig(), { defenseBuilding: [] });
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
			const manager = makeManager(makeConfig(), {
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
			const manager = makeManager(makeConfig(), { field: [] });

			manager.checkPausedQueues(gameState);

			assert.equal(manager.queues.field.paused, true,
				"with no need for a farm, the queue waits like any other");
		});
	});
});
