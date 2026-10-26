/**
 * TradeManager: trade routes between markets (ours and our allies'), the
 * traders that walk or sail them, the trading goods, bartering at the market,
 * and the search for a market worth building. The suites seat a real office
 * on the plain (tests/harness/hqWorld.ts) and its real trade manager; gains
 * are the game's own TradeGain (globalscripts/Trade.js).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resetRecorder, sent } from "./harness/engine.ts";
import { eventsWith, fake, makeTemplate, type Methods, restoreEngine, stubGlobal } from "./harness/fakes.ts";
import {
	doorCalls, doorManagers, ENEMY, type HqWorld, type HqWorldOptions, makeHqEntity, makeHqWorld,
	PLAYER, seatHQ
} from "./harness/hqWorld.ts";
import { collectionOf } from "./harness/world.ts";

import { entityId, landRegion, playerId, seaRegion } from "../adapter/brands.ts";
import type { Headquarters } from "../decision/headquarters.ts";
import { type SerializedTradeManager, TradeManager, type TradeRoute } from "../decision/tradeManager.ts";

const PlayerID = PLAYER;

afterEach(() => restoreEngine());

/** every door but the trade office, which is under test */
const tradeDoors = doorManagers.filter((name) => name !== "tradeManager");

/** the gain of a route between two positions, as checkRoutes reckons it */
const gainOf = (a: [number, number], b: [number, number], multiplier: number): number =>
	Math.round(multiplier * TradeGain((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, 320));

/** an office on the plain with its real trade manager and both trader cards */
function seat(options: Partial<HqWorldOptions> = {}, cards: { land?: boolean; sea?: boolean } = { "land": true, "sea": true })
{
	const world = makeHqWorld(options);
	const hq = seatHQ(world, { "stubs": tradeDoors });
	hq.updateTerritories(world.gameState);
	stubGlobal("pickRandom", (list: unknown[]) => list?.[0]);
	for (const [kind, name, classes] of [["land", "support_trader", ["Unit", "Support", "Trader"]],
		["sea", "ship_merchant", ["Unit", "Ship", "Trader"]]] as const)
		if (cards[kind])
		{
			// the gains table reads the {civ} card; training applies the civ
			world.templates["units/{civ}/" + name] = makeTemplate("units/{civ}/" + name, { "classes": [...classes] });
			world.templates["units/athen/" + name] = makeTemplate("units/athen/" + name, { "classes": [...classes], "cost": { "food": 100 } });
		}
	const manager = new TradeManager(hq.Config);
	hq.tradeManager = manager;
	manager.init(world.gameState);
	resetRecorder();
	return { world, hq, manager, "queues": world.ai.queues };
}

/** a market (or, with `dock`, a dock that trades) at the given spot */
function market(world: HqWorld, id: number, position: [number, number], options: {
	owner?: number; base?: number; dock?: number; foundation?: boolean } = {})
{
	const classes = ["Structure", "Trade", options.dock ? "Dock" : "Market", ...(options.dock ? ["Naval"] : [])];
	return world.addEntity(makeHqEntity({ id, "owner": options.owner ?? PLAYER, position, classes,
		"templateName": "structures/athen/" + (options.dock ? "dock" : "market") }, {
		"foundationProgress": () => options.foundation ? 0.3 : undefined
	}, { "base": options.base ?? 2, ...(options.dock ? { "sea": options.dock } : {}) }));
}

/** a trader of ours, recording its route orders */
function trader(world: HqWorld, id: number, position: [number, number] | undefined, options: {
	ship?: boolean; idle?: boolean; metadata?: Record<string, unknown>; methods?: Methods } = {})
{
	const orders: unknown[][] = [];
	const ent = world.addEntity(makeHqEntity({ id, "owner": PLAYER, position,
		"classes": options.ship ? ["Unit", "Ship", "Trader"] : ["Unit", "Support", "Trader"] }, {
		"position": () => position,
		"isIdle": () => options.idle ?? true,
		"unitAIState": () => "INDIVIDUAL.IDLE",
		"tradeRoute": (first: CommonEntity, second: CommonEntity) => orders.push(["trade", first.id(), second.id()]),
		"moveToRange": (x: number, z: number, min: number, max: number) => orders.push(["range", x, z, min, max]),
		"stopMoving": () => orders.push(["stop"]),
		...options.methods
	}, { "role": "trader", ...options.metadata }));
	return { ent, orders };
}

/** the transport ships the fleet keeps on one sea, as navalManager.seaTransportShips holds them */
function fleetOn(world: HqWorld, sea: number, ships: CommonEntity[]): Array<CommonEntityCollection | undefined>
{
	const seas: Array<CommonEntityCollection | undefined> = [];
	seas[sea] = collectionOf(world, ships);
	return seas;
}

describe("the trade office opening: init and traders", () =>
{
	it("counts our traders, wants a smaller gain on a naval map, and takes on new traders", () =>
	{
		const land = seat();
		assert.equal(land.manager.minimalGain, 5);
		assert.equal(land.manager.traders.length, 0);
		const t = trader(land.world, 300, [40, 40], { "metadata": { "role": undefined } });
		land.manager.assignTrader(t.ent);
		assert.equal(land.manager.traders.length, 1);
		assert.equal(t.ent.getMetadata(PlayerID, "role"), "trader");

		const world = makeHqWorld();
		const hq = seatHQ(world, { "stubs": tradeDoors, "navalMap": true });
		const naval = new TradeManager(hq.Config);
		naval.init(world.gameState);
		assert.equal(naval.minimalGain, 3);
	});
});

describe("the best trade route: checkRoutes", () =>
{
	it("two of our markets far apart make a land route, worth the distance between them", () =>
	{
		const { world, manager } = seat();
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);

		assert.equal(manager.checkRoutes(world.gameState), true);

		assert.deepEqual(manager.tradeRoute, { "source": 400, "target": 401, "gain": gainOf([40, 40], [280, 40], 0.7),
			"land": 2, "sea": undefined });
		assert.deepEqual(manager.potentialTradeRoute, manager.tradeRoute);
		assert.equal(manager.hasTradeRoute(), true);
	});

	it("no route with a single market, with no tradable resource, or with markets too close", () =>
	{
		const one = seat();
		market(one.world, 400, [40, 40]);
		assert.equal(one.manager.checkRoutes(one.world.gameState), false);
		assert.equal(one.manager.tradeRoute, undefined);

		const close = seat();
		market(close.world, 400, [40, 40]);
		market(close.world, 401, [42, 40]);
		assert.equal(close.manager.checkRoutes(close.world.gameState), false, "a gain under the minimum");

		const none = seat();
		market(none.world, 400, [40, 40]);
		market(none.world, 401, [280, 40]);
		stubGlobal("Resources", Object.assign(Object.create(Resources), { "GetTradableCodes": () => [] }));
		assert.equal(none.manager.checkRoutes(none.world.gameState), false);
		assert.equal(none.manager.potentialTradeRoute, undefined);
	});

	it("with an ally's markets, routes run between ours and theirs, and the ally is told once", () =>
	{
		const { world, manager } = seat();
		const pd = world.gameState.playerData;
		pd.isAlly[3] = pd.isMutualAlly[3] = true;
		pd.isEnemy[3] = false;
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);	// ours, farther: not used while an ally trades with us
		market(world, 402, [140, 40], { "owner": 3 });

		manager.checkRoutes(world.gameState);
		manager.checkRoutes(world.gameState);

		assert.equal(manager.tradeRoute?.target, 402);
		assert.equal(manager.tradeRoute?.source, 401, "the longer of our two routes to the ally");
		assert.deepEqual(manager.warnedAllies, { 3: true });
		assert.equal(sent("aichat").length, 1);
	});

	it("a route crossing enemy ground is not taken", () =>
	{
		const { world, manager } = seat();
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);
		world.map.setTerritoryOwner(20, 5, ENEMY);
		assert.equal(manager.checkRoutes(world.gameState), false);
	});

	it("a market still being built makes only a potential route", () =>
	{
		const { world, manager } = seat();
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40], { "foundation": true });

		assert.equal(manager.checkRoutes(world.gameState), false);
		assert.equal(manager.potentialTradeRoute?.target, 401);
	});

	it("two docks on one sea make a sea route; with no merchant ship card it is no route", () =>
	{
		const { world, manager } = seat({ "regionTypes": { 2: "land", 5: "water" } });
		world.accessAt.set("40,300", 3);
		world.accessAt.set("280,300", 4);	// two different lands, one sea
		market(world, 400, [40, 300], { "dock": 5 });
		market(world, 401, [280, 300], { "dock": 5 });

		assert.equal(manager.checkRoutes(world.gameState), true);
		assert.equal(manager.tradeRoute?.sea, 5);
		assert.equal(manager.tradeRoute?.gain, gainOf([40, 300], [280, 300], 0.35));
		assert.deepEqual(manager.checkRoutes(world.gameState, seaRegion(5)), manager.tradeRoute, "the best route on that sea");

		const noShips = seat({ "regionTypes": { 2: "land", 5: "water" } }, { "land": true });
		noShips.world.accessAt.set("40,300", 3);
		noShips.world.accessAt.set("280,300", 4);
		market(noShips.world, 400, [40, 300], { "dock": 5 });
		market(noShips.world, 401, [280, 300], { "dock": 5 });
		assert.equal(noShips.manager.checkRoutes(noShips.world.gameState), false);
	});

	it("for a trader's land, the best route there, else the best land route anywhere", () =>
	{
		const { world, manager } = seat({ "regionTypes": { 2: "land", 3: "land" } });
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);

		assert.equal((manager.checkRoutes(world.gameState, landRegion(2)) as TradeRoute).land, 2);
		assert.equal((manager.checkRoutes(world.gameState, landRegion(3)) as TradeRoute).land, 2, "land 3 has no route of its own");
		assert.equal(manager.checkRoutes(world.gameState, seaRegion(5)), false, "a sea with no route");
	});

	it("among several markets the farthest pair wins, whatever order they were built in; markets on two lands make no pair", () =>
	{
		const { world, manager } = seat({ "regionTypes": { 2: "land", 3: "land" } });
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);
		market(world, 402, [160, 40]);
		// a market on another land, across the water
		world.accessAt.set("40,200", 3);
		market(world, 403, [40, 200]);

		manager.checkRoutes(world.gameState);
		assert.deepEqual([manager.tradeRoute?.source, manager.tradeRoute?.target], [400, 401]);
		const land2 = manager.checkRoutes(world.gameState, landRegion(2)) as TradeRoute;
		assert.deepEqual([land2.source, land2.target], [400, 401]);
		// land 3 has a single market: the best land route anywhere
		const land3 = manager.checkRoutes(world.gameState, landRegion(3)) as TradeRoute;
		assert.deepEqual([land3.source, land3.target], [400, 401]);
	});
});

describe("traders trained: trainMoreTraders", () =>
{
	/** a land route between our markets 400 and 401 */
	function landRoute(options: Partial<HqWorldOptions> = {})
	{
		const s = seat(options);
		market(s.world, 400, [40, 40], { "base": 2 });
		market(s.world, 401, [280, 40], { "base": 2 });
		s.manager.checkRoutes(s.world.gameState);
		return s;
	}

	it("a land route short of traders gets a trader for the source market's town", () =>
	{
		const { world, manager, queues } = landRoute();
		manager.trainMoreTraders(world.gameState, queues);
		assert.deepEqual(queues.trader.plans.map((p) => [p.type, p.metadata]),
			[["units/athen/support_trader", { "role": "trader", "base": 2 }]]);
	});

	it("enough traders, counting those in training, train no more; nor does a busy queue or no route", () =>
	{
		const { world, manager, queues } = landRoute();
		manager.targetNumTraders = 4;
		for (let i = 0; i < 3; ++i)
			manager.assignTrader(trader(world, 300 + i, [40, 40]).ent);
		world.addEntity(makeHqEntity({ "id": 450, "owner": PLAYER, "position": [40, 40], "classes": ["Structure", "Market"] }, {
			"trainingQueue": () => [{ "count": 1, "metadata": { "role": "trader" } }, { "count": 2, "metadata": { "role": "worker" } }]
		}));
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(queues.trader.plans.length, 0, "3 + 1 in training");

		const none = seat();
		none.manager.trainMoreTraders(none.world.gameState, none.queues);
		assert.equal(none.queues.trader.plans.length, 0);
	});

	it("a sea route takes over a merchant ship serving as transport, or trains a new one", () =>
	{
		const { world, hq, manager, queues } = seat();
		manager.tradeRoute = { "source": entityId(400), "target": entityId(401), "gain": 100, "sea": seaRegion(5) };
		const free = world.addEntity(makeHqEntity({ "id": 310, "owner": PLAYER, "position": [200, 200], "classes": ["Unit", "Ship", "Trader"] }));
		const carrying = world.addEntity(makeHqEntity({ "id": 311, "owner": PLAYER, "position": [200, 220], "classes": ["Unit", "Ship", "Trader"] },
			{}, { "transporter": 4 }));
		hq.navalManager.seaTransportShips = fleetOn(world, 5, [free]);
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(free.getMetadata(PlayerID, "role"), "trader");

		hq.navalManager.seaTransportShips = fleetOn(world, 5, [carrying]);
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(carrying.getMetadata(PlayerID, "role"), "switchToTrader", "after its passage");
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(queues.trader.plans.length, 0, "one already switching");

		hq.navalManager.seaTransportShips = fleetOn(world, 5, []);	// no merchant ship among them
		manager.trainMoreTraders(world.gameState, queues);
		assert.deepEqual(queues.trader.plans.map((p) => [p.type, p.metadata]),
			[["units/athen/ship_merchant", { "role": "trader", "sea": 5 }]]);
	});

	it("a sea route with enough merchant ships, counting those being built, trains no more", () =>
	{
		const { world, manager, queues } = seat();
		manager.tradeRoute = { "source": entityId(400), "target": entityId(401), "gain": 100, "sea": seaRegion(5) };
		manager.targetNumTraders = 4;
		for (let i = 0; i < 2; ++i)
			manager.assignTrader(trader(world, 320 + i, [200, 200], { "ship": true }).ent);
		world.addEntity(makeHqEntity({ "id": 451, "owner": PLAYER, "position": [40, 40], "classes": ["Structure", "Dock"] }, {
			"trainingQueue": () => [{ "count": 2, "metadata": { "role": "trader", "sea": 5 } }]
		}));
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(queues.trader.plans.length, 0);
	});

	it("a warship in the transport fleet is passed over; the merchant ship beside it is taken", () =>
	{
		const { world, hq, manager, queues } = seat();
		manager.tradeRoute = { "source": entityId(400), "target": entityId(401), "gain": 100, "sea": seaRegion(5) };
		const warship = world.addEntity(makeHqEntity({ "id": 312, "owner": PLAYER, "position": [200, 200], "classes": ["Unit", "Ship", "Warship"] }));
		const merchant = world.addEntity(makeHqEntity({ "id": 313, "owner": PLAYER, "position": [200, 210], "classes": ["Unit", "Ship", "Trader"] }));
		hq.navalManager.seaTransportShips = fleetOn(world, 5, [warship, merchant]);
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(warship.getMetadata(PlayerID, "role"), undefined);
		assert.equal(merchant.getMetadata(PlayerID, "role"), "trader");
		assert.equal(queues.trader.plans.length, 0);
	});

	it("a civ without the trader card trains none", () =>
	{
		const { world, manager, queues } = seat({}, { "sea": true });
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);
		manager.tradeRoute = { "source": entityId(400), "target": entityId(401), "gain": 100, "land": landRegion(2) };
		manager.trainMoreTraders(world.gameState, queues);
		assert.equal(queues.trader.plans.length, 0);
	});
});

describe("a trader sent on its way: updateTrader", () =>
{
	function routed()
	{
		const s = seat();
		market(s.world, 400, [40, 40]);
		market(s.world, 401, [280, 40]);
		s.manager.checkRoutes(s.world.gameState);
		return s;
	}

	it("an idle trader trades from the nearer market to the farther one", () =>
	{
		const { world, manager } = routed();
		const near401 = trader(world, 300, [260, 40]);
		const near400 = trader(world, 301, [60, 40]);

		manager.updateTrader(world.gameState, near401.ent);
		manager.updateTrader(world.gameState, near400.ent);

		assert.deepEqual(near401.orders, [["trade", 400, 401]]);
		assert.deepEqual(near400.orders, [["trade", 401, 400]]);
		assert.deepEqual(near401.ent.getMetadata(PlayerID, "route"), manager.tradeRoute, "the route is noted");
	});

	it("a trader on another land asks for a passage to the nearer market", () =>
	{
		const { world, hq, manager } = routed();
		world.accessAt.set("260,200", 3);
		world.ai.accessibility.regionType[3] = "land";
		const far = trader(world, 300, [260, 200]);

		manager.updateTrader(world.gameState, far.ent);

		const call = doorCalls(hq.navalManager).find(([m]) => m === "requireTransport");
		assert.deepEqual(call?.[1].slice(2), [3, 2, [280, 40]]);
	});

	it("a trader on another land nearer the first market asks for a passage to that one", () =>
	{
		const { world, hq, manager } = routed();
		world.accessAt.set("60,200", 3);
		world.ai.accessibility.regionType[3] = "land";
		const far = trader(world, 300, [60, 200]);

		manager.updateTrader(world.gameState, far.ent);

		const call = doorCalls(hq.navalManager).find(([m]) => m === "requireTransport");
		assert.deepEqual(call?.[1].slice(2), [3, 2, [40, 40]]);
	});

	it("a busy trader, one waiting for a boat, or one with no route for its land is left be", () =>
	{
		const { world, manager } = routed();
		const busy = trader(world, 300, [60, 40], { "idle": false });
		const boarding = trader(world, 301, [60, 40], { "metadata": { "transport": 1 } });
		manager.updateTrader(world.gameState, busy.ent);
		manager.updateTrader(world.gameState, boarding.ent);
		assert.deepEqual([busy.orders, boarding.orders], [[], []]);

		const none = seat();
		const lost = trader(none.world, 300, [60, 40]);
		none.manager.updateTrader(none.world.gameState, lost.ent);
		assert.deepEqual(lost.orders, []);
	});

	// port regression, fixed: the port dropped the "not" of the original's
	// check, so a merchant ship looked for treasure only while already
	// collecting one
	it("every fifth turn, a merchant ship not already collecting treasure looks for one", () =>
	{
		const { world, hq, manager } = routed();
		const collected: number[] = [];
		const ship = trader(world, 310, [200, 200], { "ship": true, "methods": {
			"isTreasureCollector": () => true, "collectTreasure": (t: CommonEntity) => collected.push(t.id())
		} });
		world.addEntity(makeHqEntity({ "id": 900, "owner": 0, "position": [210, 200], "classes": ["Treasure"] },
			{ "isTreasure": () => true }, { "sea": 2 }));
		hq.treasures = world.gameState.getEntities().filter((e: CommonEntity) => e.isTreasure());
		ship.ent.setMetadata(PlayerID, "sea", 2);
		world.ai.playedTurn = 5;

		manager.updateTrader(world.gameState, ship.ent);

		assert.deepEqual(collected, [900]);
		assert.deepEqual(ship.orders, [], "it goes for the treasure first");
	});
});

describe("what traders carry and what the market barters", () =>
{
	it("trading goods favour the scarce resources and the most needed, and more traders are wanted", () =>
	{
		const { world, hq, manager } = seat();
		hq.getTotalResourceLevel = () => ({ "food": 5000, "wood": 100, "stone": 300, "metal": 2000 });
		hq.GetWantedGatherRates = () => ({ "food": 10, "wood": 30, "stone": 0, "metal": 0 });
		hq.pickMostNeededResources = () => [{ "type": "wood", "wanted": 30, "current": 0 }, { "type": "food", "wanted": 10, "current": 0 }];
		const base = hq.Config.Economy.targetNumTraders;

		manager.setTradingGoods(world.gameState);

		// wood scarce and wanted 20, stone low 10, metal plenty 0: 70 left, 49 to wood and 21 to food
		assert.deepEqual(sent("set-trading-goods"), [{ "type": "set-trading-goods",
			"tradingGoods": { "food": 21, "wood": 69, "stone": 10, "metal": 0 } }]);
		assert.equal(manager.targetNumTraders, Math.round(hq.Config.popScaling * (base + 4 + 2)));
	});

	it("when only one resource is wanted, it takes all that is left", () =>
	{
		const { world, hq, manager } = seat();
		hq.getTotalResourceLevel = () => ({ "food": 5000, "wood": 5000, "stone": 5000, "metal": 5000 });
		hq.GetWantedGatherRates = () => ({ "food": 0, "wood": 0, "stone": 0, "metal": 0 });
		hq.pickMostNeededResources = () => [{ "type": "metal", "wanted": 10, "current": 0 }, { "type": "food", "wanted": 0, "current": 0 }];
		manager.setTradingGoods(world.gameState);
		assert.deepEqual(sent("set-trading-goods")[0].tradingGoods, { "food": 0, "wood": 0, "stone": 0, "metal": 100 });
	});

	it("a resource of which we hold 500 to 1000 is carried a little, and wants one more trader", () =>
	{
		const { world, hq, manager } = seat();
		hq.getTotalResourceLevel = () => ({ "food": 5000, "wood": 700, "stone": 5000, "metal": 5000 });
		hq.GetWantedGatherRates = () => ({ "food": 0, "wood": 0, "stone": 0, "metal": 0 });
		hq.pickMostNeededResources = () => [{ "type": "metal", "wanted": 10, "current": 0 }, { "type": "food", "wanted": 0, "current": 0 }];
		const base = hq.Config.Economy.targetNumTraders;
		manager.setTradingGoods(world.gameState);
		assert.deepEqual(sent("set-trading-goods")[0].tradingGoods, { "food": 0, "wood": 10, "stone": 0, "metal": 90 });
		assert.equal(manager.targetNumTraders, Math.round(hq.Config.popScaling * (base + 1)));
	});

	/** a market that barters, and what the town has, needs and gathers */
	function barter(available: Record<string, number>, needs: Record<string, number>, prices = { "buy": {}, "sell": {} })
	{
		const s = seat();
		const done: unknown[] = [];
		s.world.addEntity(makeHqEntity({ "id": 460, "owner": PLAYER, "position": [40, 40], "classes": ["Structure", "Market", "Barter"] },
			{ "barter": (buy: string, sell: string, amount: number) => done.push([buy, sell, amount]) }));
		const qm = s.world.ai.queueManager as unknown as Record<string, unknown>;
		qm.getAvailableResources = () => ({ "food": 0, "wood": 0, "stone": 0, "metal": 0, ...available });
		qm.currentNeeds = () => ({ "food": 0, "wood": 0, "stone": 0, "metal": 0, ...needs });
		s.hq.GetCurrentGatherRates = () => ({ "food": 1, "wood": 1, "stone": 1, "metal": 1 });
		const all = { "food": 100, "wood": 100, "stone": 100, "metal": 100 };
		(s.world.gameState as unknown as Record<string, unknown>).getBarterPrices = () =>
			({ "buy": { ...all, ...prices.buy }, "sell": { ...all, ...prices.sell } });
		return { ...s, done };
	}

	it("a resource needed faster than it is gathered is bought with the one we have most to spare", () =>
	{
		const { world, manager, done } = barter({ "wood": 6000 }, { "stone": 300 });
		assert.equal(manager.performBarter(world.gameState), true);
		assert.deepEqual(done, [["stone", "wood", 500]], "wood: 6000 spare, a rate of 100 over its minimum of 30");
	});

	it("a poor rate, or nothing to spare, buys nothing", () =>
	{
		const poor = barter({ "wood": 600 }, { "stone": 300 }, { "buy": { "stone": 200 }, "sell": {} });
		assert.equal(poor.manager.performBarter(poor.world.gameState), false, "a rate of 50 under the minimum of 70");

		const needy = barter({ "wood": 6000 }, { "stone": 300, "wood": 10 });
		assert.equal(needy.manager.performBarter(needy.world.gameState), false, "wood is needed too");
	});

	it("with food to spare and nothing urgent, food buys the scarcest other resource", () =>
	{
		const { world, manager, done } = barter({ "food": 6000, "wood": 4000, "stone": 100, "metal": 3000 }, {});
		assert.equal(manager.performBarter(world.gameState), true);
		assert.deepEqual(done, [["stone", "food", 500]]);
	});

	it("food is sold cheaper the more of it there is", () =>
	{
		const { world, manager, done } = barter({ "food": 20000 }, { "metal": 300 }, { "buy": { "metal": 1500 }, "sell": {} });
		assert.equal(manager.performBarter(world.gameState), true, "a rate of 7 is enough with 20000 food");
		assert.deepEqual(done, [["metal", "food", 500]]);
	});

	it("with a huge food pile, food is sold at any rate; with a modest one, above a rate of 10", () =>
	{
		const huge = barter({ "food": 50000 }, { "metal": 300 }, { "buy": { "metal": 5000 }, "sell": {} });
		assert.equal(huge.manager.performBarter(huge.world.gameState), true, "a rate of 2 with 50000 food");
		assert.deepEqual(huge.done, [["metal", "food", 500]]);

		const modest = barter({ "food": 2000 }, { "metal": 300 }, { "buy": { "metal": 800 }, "sell": {} });
		assert.equal(modest.manager.performBarter(modest.world.gameState), true, "a rate of 13 with 2000 food");
		assert.deepEqual(modest.done, [["metal", "food", 100]]);
	});

	it("a modest wood pile sells above a rate of 50, and 20 more to buy food", () =>
	{
		const stone = barter({ "wood": 2000 }, { "stone": 300 }, { "buy": { "stone": 180 }, "sell": {} });
		assert.equal(stone.manager.performBarter(stone.world.gameState), true, "a rate of 56 over 50");

		const food = barter({ "wood": 2000 }, { "food": 300 }, { "buy": { "food": 130 }, "sell": {} });
		assert.equal(food.manager.performBarter(food.world.gameState), true, "a rate of 77 over 70");
		assert.deepEqual(food.done, [["food", "wood", 100]]);
		const dear = barter({ "wood": 2000 }, { "food": 300 }, { "buy": { "food": 150 }, "sell": {} });
		assert.equal(dear.manager.performBarter(dear.world.gameState), false, "a rate of 67 under 70");
	});

	it("food to spare, but every price too poor: nothing is bought", () =>
	{
		const { world, manager, done } = barter({ "food": 3000, "wood": 6000, "stone": 6000, "metal": 6000 }, {},
			{ "buy": { "wood": 200, "stone": 200, "metal": 200 }, "sell": {} });
		assert.equal(manager.performBarter(world.gameState), false);
		assert.deepEqual(done, []);
	});

	it("no market that barters, or little food, barters nothing", () =>
	{
		const s = seat();
		assert.equal(s.manager.performBarter(s.world.gameState), false);

		const little = barter({ "food": 500 }, {});
		assert.equal(little.manager.performBarter(little.world.gameState), false);
	});
});

describe("markets built, lost, renamed: checkEvents and checkTrader", () =>
{
	function routed()
	{
		const s = seat();
		market(s.world, 400, [40, 40]);
		market(s.world, 401, [280, 40]);
		s.manager.checkRoutes(s.world.gameState);
		return s;
	}

	it("a market renamed keeps its traders' routes", () =>
	{
		const { world, manager } = routed();
		market(world, 410, [40, 40]);
		const a = trader(world, 300, [60, 40], { "metadata": { "route": { "source": 400, "target": 401 } } });
		const b = trader(world, 301, [60, 40], { "metadata": { "route": { "source": 401, "target": 400 } } });
		const c = trader(world, 302, [60, 40]);
		const d = trader(world, 303, [60, 40], { "metadata": { "route": { "source": 401, "target": 402 } } });
		for (const t of [a, b, c, d])
			manager.assignTrader(t.ent);

		assert.equal(manager.checkEvents(world.gameState, eventsWith({ "EntityRenamed": [{ "entity": entityId(400), "newentity": entityId(410) }] })), false);

		assert.deepEqual(a.ent.getMetadata(PlayerID, "route"), { "source": 410, "target": 401 });
		assert.deepEqual(b.ent.getMetadata(PlayerID, "route"), { "source": 401, "target": 410 });
	});

	it("a route's market destroyed, a market built or captured, or a change of diplomacy: look for a better route", () =>
	{
		const cases: Array<Partial<EngineAIEvents>> = [
			{ "Destroy": [{ "entity": entityId(401) }] },
			{ "Create": [{ "entity": entityId(420) }] },
			{ "OwnershipChanged": [{ "entity": entityId(420), "from": ENEMY, "to": PLAYER }] },
			{ "DiplomacyChanged": [{ "player": ENEMY, "otherPlayer": PLAYER }] }
		];
		for (const evts of cases)
		{
			const { world, hq, manager } = routed();
			market(world, 420, [160, 200]);
			manager.routeProspection = false;
			hq.buildManager.setUnbuildable(world.gameState, "structures/athen/market", 1000);
			assert.equal(manager.checkEvents(world.gameState, eventsWith(evts)), true, Object.keys(evts)[0]);
			assert.equal(manager.routeProspection, true);
			assert.equal(hq.buildManager.isUnbuildable(world.gameState, "structures/athen/market"), false);
		}
	});

	it("a house upgraded is no market: the routes are left as they are", () =>
	{
		const { world, manager } = routed();
		world.addEntity(makeHqEntity({ "id": 470, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "House"] }));
		const a = trader(world, 300, [60, 40], { "metadata": { "route": { "source": 400, "target": 401 } } });
		manager.assignTrader(a.ent);
		assert.equal(manager.checkEvents(world.gameState, eventsWith({ "EntityRenamed": [{ "entity": entityId(469), "newentity": entityId(470) }] })), false);
		assert.deepEqual(a.ent.getMetadata(PlayerID, "route"), { "source": 400, "target": 401 });
	});

	it("events about others' buildings change nothing", () =>
	{
		const { world, manager } = routed();
		market(world, 420, [160, 200], { "owner": ENEMY });
		market(world, 421, [160, 220], { "foundation": true });
		assert.equal(manager.checkEvents(world.gameState, eventsWith({ "Create": [{ "entity": entityId(420) }, { "entity": entityId(421) }, { "entity": entityId(999) }],
			"OwnershipChanged": [{ "entity": entityId(420), "from": ENEMY, "to": playerId(0) }, { "entity": entityId(999), "from": PLAYER, "to": ENEMY }],
			"Destroy": [{ "entity": entityId(999) }] })), false);
	});

	it("a trader whose route still stands keeps it; one whose route is gone heads home or stops", () =>
	{
		const { world, manager } = routed();
		const keeps = trader(world, 300, [60, 40], { "metadata": { "route": { "source": 401, "target": 400 } } });
		manager.checkTrader(world.gameState, keeps.ent);
		assert.deepEqual(keeps.orders, []);

		const aboard = trader(world, 301, undefined, { "metadata": { "route": { "source": 401, "target": 400 } } });
		manager.checkTrader(world.gameState, aboard.ent);
		assert.equal(aboard.ent.getMetadata(PlayerID, "route"), undefined, "garrisoned: decided when it comes out");

		world.removeEntity(401);
		const lost = trader(world, 302, [200, 40], { "metadata": { "route": { "source": 401, "target": 400 } } });
		manager.checkTrader(world.gameState, lost.ent);
		assert.deepEqual(lost.orders, [["range", 10, 10, 0, 15]], "to the nearest town");

		const ship = trader(world, 303, [200, 200], { "ship": true, "metadata": { "route": { "source": 401, "target": 400 }, "sea": 5 } });
		manager.checkTrader(world.gameState, ship.ent);
		assert.deepEqual(ship.orders, [["stop"]]);

		trader(world, 304, [60, 40]);
		manager.checkTrader(world.gameState, world.ents.get(304)!);	// no route: nothing to check
	});
});

describe("a new market: prospectForNewMarket and isNewMarketWorth", () =>
{
	/** a town that can build markets, with one already standing */
	function prospecting(options: { route?: boolean; position?: ReturnType<Headquarters["findMarketLocation"]> } = {})
	{
		const s = seat();
		s.world.templates["structures/athen/market"] = makeTemplate("structures/athen/market",
			{ "classes": ["Structure", "Trade", "Market"], "cost": { "wood": 300 } });
		s.hq.canBuild = () => true;
		market(s.world, 400, [40, 40]);
		if (options.route)
		{
			market(s.world, 401, [280, 40]);
			s.manager.checkRoutes(s.world.gameState);
		}
		s.hq.findMarketLocation = () => options.position ?? [200, 200, 2, 50000];
		s.manager.routeProspection = true;
		return s;
	}

	it("a first route's market is queued in a hurry", () =>
	{
		const { world, hq, manager, queues } = prospecting();
		manager.prospectForNewMarket(world.gameState, queues);
		assert.deepEqual(queues.economicBuilding.plans.map((p) => p.type), ["structures/athen/market"]);
		assert.equal(world.ai.queueManager.priorities.economicBuilding,
			2 * hq.Config.priorities.economicBuilding);
		assert.equal(manager.routeProspection, false);
	});

	it("a market adding too little to the present route is not queued", () =>
	{
		const { world, manager, queues } = prospecting({ "route": true, "position": [200, 200, 2, 10] });
		manager.prospectForNewMarket(world.gameState, queues);
		assert.equal(queues.economicBuilding.plans.length, 0);
	});

	it("no spot found: the market is put aside if we have one, else the search stops", () =>
	{
		const { world, hq, manager, queues } = prospecting({ "position": false });
		manager.prospectForNewMarket(world.gameState, queues);
		assert.equal(hq.buildManager.isUnbuildable(world.gameState, "structures/athen/market"), true);

		const noMarket = seat();
		noMarket.hq.canBuild = () => true;
		noMarket.world.templates["structures/athen/market"] = makeTemplate("structures/athen/market", { "classes": ["Structure", "Market"] });
		market(noMarket.world, 400, [40, 40], { "dock": 5 });	// a trading dock, no market
		noMarket.hq.findMarketLocation = () => [200, 200, 2, 0];
		noMarket.manager.routeProspection = true;
		noMarket.manager.prospectForNewMarket(noMarket.world.gameState, noMarket.queues);
		assert.equal(noMarket.manager.routeProspection, false);
	});

	it("no market queued while one is queued, when markets cannot be built, or with no trading building at all", () =>
	{
		const queued = prospecting();
		queued.queues.economicBuilding.hasQueuedUnitsWithClass = () => true;
		queued.manager.prospectForNewMarket(queued.world.gameState, queued.queues);
		assert.equal(queued.manager.routeProspection, true);

		const cannot = prospecting();
		cannot.hq.canBuild = () => false;
		cannot.manager.prospectForNewMarket(cannot.world.gameState, cannot.queues);
		assert.equal(cannot.manager.routeProspection, true);

		const empty = seat();
		empty.hq.canBuild = () => true;
		empty.manager.routeProspection = true;
		empty.manager.prospectForNewMarket(empty.world.gameState, empty.queues);
		assert.equal(empty.manager.routeProspection, true);
	});

	it("a new market is worth it when it doubles the route, or adds twenty", () =>
	{
		const { manager } = seat();
		assert.equal(manager.isNewMarketWorth(4), false, "under the minimal gain");
		manager.potentialTradeRoute = { "source": entityId(1), "target": entityId(2), "gain": 100 };
		assert.equal(manager.isNewMarketWorth(119), false);
		assert.equal(manager.isNewMarketWorth(120), true);
		manager.potentialTradeRoute = { "source": entityId(1), "target": entityId(2), "gain": 10 };
		assert.equal(manager.isNewMarketWorth(20), true);
		stubGlobal("Resources", Object.assign(Object.create(Resources), { "GetTradableCodes": () => [] }));
		assert.equal(manager.isNewMarketWorth(1000), false);
	});
});

describe("the trade office through its turn: update", () =>
{
	it("barters, re-checks routes after market events, sends traders, trains, researches, sets goods, and prospects", () =>
	{
		const { world, hq, manager, queues } = seat();
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);
		const t1 = trader(world, 300, [60, 40]);
		manager.assignTrader(t1.ent);
		manager.assignTrader(trader(world, 301, [60, 40], { "idle": false }).ent);
		hq.canBarter = true;
		hq.getTotalResourceLevel = () => ({ "food": 5000, "wood": 5000, "stone": 5000, "metal": 5000 });
		hq.GetWantedGatherRates = () => ({ "food": 0, "wood": 0, "stone": 0, "metal": 0 });
		hq.pickMostNeededResources = () => [{ "type": "metal", "wanted": 10, "current": 0 }];
		hq.findMarketLocation = () => false;
		hq.canBuild = () => false;
		manager.targetNumTraders = 6;
		world.ai.playedTurn = 60;

		manager.update(world.gameState, eventsWith({ "DiplomacyChanged": [{ "player": ENEMY, "otherPlayer": PLAYER }] }), queues);

		assert.deepEqual(t1.orders, [["trade", 401, 400]]);
		assert.equal(queues.trader.plans.length, 1, "trained on the fifth turn");
		assert.ok(doorCalls(hq.researchManager).some(([m]) => m === "researchTradeBonus"), "researched on the twentieth");
		assert.equal(sent("set-trading-goods").length, 1, "goods set on the sixtieth");
	});

	it("at the easiest difficulty, it only barters", () =>
	{
		const { world, hq, manager, queues } = seat();
		hq.Config.difficulty = 0;
		market(world, 400, [40, 40]);
		market(world, 401, [280, 40]);
		manager.update(world.gameState, eventsWith({ "DiplomacyChanged": [{ "player": ENEMY, "otherPlayer": PLAYER }] }), queues);
		assert.equal(manager.routeProspection, false);
		assert.equal(manager.tradeRoute, undefined);
	});
});

describe("the trade office saved and loaded", () =>
{
	it("a save from an older version keeps the defaults", () =>
	{
		const { world, manager } = seat();
		const defaults = manager.Serialize();
		manager.Deserialize(world.gameState, fake<SerializedTradeManager>({ "tradeRoute": undefined, "potentialTradeRoute": undefined }));
		assert.deepEqual(manager.Serialize(), defaults);
	});
});
