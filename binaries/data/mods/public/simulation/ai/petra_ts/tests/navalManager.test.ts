/**
 * NavalManager: everything with a hull — the fleet sorted by sea, the
 * fishing boats a sea can feed, the transports that carry units across, the
 * ships trained and the docks raised. The suites seat a real office and its
 * real naval manager on the naval board (see tests/harness/navalWorld.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyEvents, eventsWith, makeTemplate, override } from "./harness/fakes.ts";
import { ENEMY, PLAYER, makeHqEntity, structureTemplate } from "./harness/hqWorld.ts";
import { backToBoarding, boarding, dock, fish, init, queues, seat, setSail, shipCard } from "./harness/navalSeat.ts";
import { ISLAND, SEA, WEST, navalWorld, ship, soldier } from "./harness/navalWorld.ts";

import { landRegion, seaRegion, seconds, worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import * as baseModule from "../decision/baseManager.ts";
import { BuildManager } from "../decision/buildManager.ts";
import {
	FISH_MAX_BOATS,
	FISH_PER_BOAT,
	HUNTERS_PER_SEA,
	NavalManager,
	STUCK_SECONDS,
	getBestShip,
} from "../decision/navalManager.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";

const PlayerID = PLAYER;

describe("the fleet counted at the start: init", () =>
{
	it("a sea with plenty of fish wants fishing boats, a sea with little wants none", () =>
	{
		const rich = seat();
		fish(rich.world, 400, [200, 100], 600);
		fish(rich.world, 401, [200, 200], 600);
		init(rich);
		assert.equal(rich.naval.wantedFishShips[SEA], 1, "the configured number of fishers");

		const poor = seat();
		fish(poor.world, 400, [200, 100], 600);
		init(poor);
		assert.equal(poor.naval.wantedFishShips[SEA], 0);
	});

	// only the port passes: Petra wanted one fishing boat whatever a sea held,
	// and island towns starved with fish beside them (FINDINGS §41)
	it("on a naval map, wants fishing boats by the fish left: one per FISH_PER_BOAT, up to FISH_MAX_BOATS", () =>
	{
		const s = seat();
		for (let i = 0; i < 6; ++i)
		{
			fish(s.world, 400 + i, [200, 100 + 20 * i], 1000);
		}
		init(s);
		s.hq.navalMap = true;
		s.naval.fishByWhatIsLeft(s.world.gameState);
		assert.equal(s.naval.wantedFishShips[SEA], Math.ceil(6000 / FISH_PER_BOAT));

		for (let i = 6; i < 20; ++i)
		{
			fish(s.world, 400 + i, [200, 100 + 20 * i], 1000);
		}
		s.naval.fishByWhatIsLeft(s.world.gameState);
		assert.equal(s.naval.wantedFishShips[SEA], FISH_MAX_BOATS, "at most");

		s.naval.resetFishingBoats(s.world.gameState, SEA);
		s.naval.fishByWhatIsLeft(s.world.gameState);
		assert.equal(s.naval.wantedFishShips[SEA], 0, "a sea the workers found empty stays so");
	});

	// only the port passes: Petra never wanted a warship, and the enemy's
	// fishing boats and merchants sailed unopposed (FINDINGS §42)
	it("on a naval map, wants warships on a sea where the enemy fishes, and sends an idle one after the nearest boat out of the towers' reach", () =>
	{
		const s = seat();
		const ours = dock(s.world, 900, [150, 160]);
		ours.setMetadata(PLAYER, "sea", SEA);
		const attacks: number[] = [];
		ship(s.world, 210, [200, 100], { methods: { attack: (id: number) => attacks.push(id) } });
		const busy = ship(s.world, 211, [200, 110], { methods: { attack: () => assert.fail("a busy warship") } });
		busy.state.idle = false;
		const boat = (id: number, pos: [number, number], classes = ["Unit", "Ship", "FishingBoat"]) =>
			ship(s.world, id, pos, { owner: ENEMY, classes });
		boat(300, [200, 60]); // 40 m, under the tower below
		boat(301, [210, 160]); // 61 m, free
		boat(302, [200, 450]); // out of range
		s.world.addEntity(
			makeHqEntity({ id: 400, owner: ENEMY, position: [240, 40], classes: ["Structure", "Tower"] }, {
				hasDefensiveFire: () => true,
				attackRange: () => ({ max: 60, min: 0 }),
			}),
		);
		init(s);
		s.hq.navalMap = true;

		s.naval.huntWithFleet(s.world.gameState);

		assert.equal(s.naval.wantedWarShips[SEA], HUNTERS_PER_SEA);
		assert.deepEqual(attacks, [301], "the free boat, not the one under the tower");
	});

	it("wants no warship where the enemy neither fishes nor trades", () =>
	{
		const s = seat();
		dock(s.world, 900, [150, 160]).setMetadata(PLAYER, "sea", SEA);
		ship(s.world, 300, [210, 160], { owner: ENEMY, classes: ["Unit", "Ship", "Warship"] });
		init(s);
		s.hq.navalMap = true;
		s.naval.huntWithFleet(s.world.gameState);
		assert.equal(s.naval.wantedWarShips[SEA], 0);
	});

	it("sorts our ships by kind and by sea, leaving the merchant ships to the trade office", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 100]);
		ship(s.world, 201, [200, 200], { classes: ["Unit", "Ship", "FishingBoat"], capacity: 0 });
		ship(s.world, 202, [200, 250], { classes: ["Unit", "Ship", "Trader"], metadata: { role: "trader" } });
		init(s);

		assert.equal(s.naval.ships.length, 2);
		assert.equal(s.naval.transportShips.length, 1, "the warship carries troops, the fishing boat does not");
		assert.equal(s.naval.warShips.length, 1);
		assert.equal(s.naval.fishShips.length, 1);
		assert.equal(s.naval.fleet(SEA)?.ships.length, 2, "each ship knows its sea");
		assert.equal(s.naval.fleet(SEA)?.transports.length, 1);
		assert.equal(s.naval.fleet(SEA)?.fishers.length, 1);
		assert.equal(s.naval.fleet(WEST), undefined, "a land keeps no fleet");
	});

	it("tells each dock of ours which sea it opens on", () =>
	{
		const s = seat();
		const harbour = dock(s.world, 300, [156, 160]);
		init(s);

		assert.equal(harbour.getMetadata(PlayerID, "sea"), SEA);
	});
});

describe("how many fishing boats a sea gets", () =>
{
	it("the opening sets the number for a sea that wants fishers, not for one that wants none", () =>
	{
		const s = seat();
		fish(s.world, 400, [200, 100], 2000);
		init(s);

		s.naval.updateFishingBoats(SEA, 4);
		s.naval.updateFishingBoats(seaRegion(WEST), 4);

		assert.equal(s.naval.wantedFishShips[SEA], 4);
		assert.equal(s.naval.wantedFishShips[WEST], 0);
	});

	it("a sea fished out wants no more boats; with no sea named, none does", () =>
	{
		const s = seat();
		fish(s.world, 400, [200, 100], 2000);
		init(s);
		s.naval.updateFishingBoats(SEA, 4);

		s.naval.resetFishingBoats(s.world.gameState, SEA);
		assert.equal(s.naval.wantedFishShips[SEA], 0);

		s.naval.updateFishingBoats(SEA, 4);
		s.naval.wantedFishShips[SEA] = 3;
		s.naval.resetFishingBoats(s.world.gameState);
		assert.ok(s.naval.wantedFishShips.every((n) => n === 0));
	});
});

describe("which seas a land still needs a dock on: getUnconnectedSeas", () =>
{
	it("a land with no dock lacks every sea it touches; a dock connects its sea", () =>
	{
		const s = seat();
		init(s);
		assert.deepEqual(s.naval.getUnconnectedSeas(s.world.gameState, WEST), [SEA]);

		const harbour = dock(s.world, 300, [156, 160]);
		harbour.setMetadata(PlayerID, "access", WEST);
		harbour.setMetadata(PlayerID, "sea", SEA);
		assert.deepEqual(s.naval.getUnconnectedSeas(s.world.gameState, WEST), []);
		assert.deepEqual(s.naval.getUnconnectedSeas(s.world.gameState, ISLAND), [SEA], "the island still lacks one");
	});

	it("a shipyard does not count as a dock", () =>
	{
		const s = seat();
		init(s);
		const yard = dock(s.world, 300, [156, 160], [], { classes: ["Structure", "Shipyard"] });
		yard.setMetadata(PlayerID, "access", WEST);
		yard.setMetadata(PlayerID, "sea", SEA);

		assert.deepEqual(s.naval.getUnconnectedSeas(s.world.gameState, WEST), [SEA]);
	});
});

describe("how many transport ships a sea wants: setMinimalTransportShips and checkLevels", () =>
{
	it("a new base or attack raises the minimum, never lowers it", () =>
	{
		const s = seat();
		init(s);

		s.naval.setMinimalTransportShips(s.world.gameState, SEA, 2);
		s.naval.setMinimalTransportShips(s.world.gameState, SEA, 1);
		s.naval.setMinimalTransportShips(s.world.gameState, seaRegion(0), 5);

		assert.equal(s.naval.wantedTransportShips[SEA], 2);
		assert.equal(s.naval.wantedTransportShips[0], 0);
	});

	/** a passage of two units across the sea, waiting for a ship */
	function waiting(s: ReturnType<typeof seat>, first = 100)
	{
		for (const k of [0, 1])
		{
			s.transports.requireTransport(
				s.world.gameState,
				soldier(s.world, first + k, [140, 150 + 10 * k]).ent,
				WEST,
				ISLAND,
				worldPos(280, 160),
			);
		}
	}

	it("a passage of several units waiting with no ship wanted makes the sea want one", () =>
	{
		const s = seat();
		init(s);
		waiting(s);

		s.naval.checkLevels(s.world.gameState, queues(s.world));

		assert.equal(s.naval.wantedTransportShips[SEA], 1);
	});

	it("one unit alone, a ship already in training, or a busy ship queue raise nothing", () =>
	{
		const lone = seat();
		init(lone);
		lone.transports.requireTransport(
			lone.world.gameState,
			soldier(lone.world, 100, [140, 160]).ent,
			WEST,
			ISLAND,
			worldPos(280, 160),
		);
		lone.naval.checkLevels(lone.world.gameState, queues(lone.world));
		assert.equal(lone.naval.wantedTransportShips[SEA], 0, "one unit");

		const training = seat();
		init(training);
		waiting(training);
		training.world.gameState.countOwnQueuedEntitiesWithMetadata = () => 1;
		training.naval.checkLevels(training.world.gameState, queues(training.world));
		assert.equal(training.naval.wantedTransportShips[SEA], 0, "a ship in training");

		const busy = seat();
		init(busy);
		waiting(busy);
		queues(busy.world).ships.hasQueuedUnits = () => true;
		busy.naval.checkLevels(busy.world.gameState, queues(busy.world));
		assert.equal(busy.naval.wantedTransportShips[SEA], 0, "the ship queue is busy");
	});

	it("a sea with its wanted ships gets one more when more than two passages wait", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 100], { metadata: { transporter: 98 } });
		ship(s.world, 201, [200, 200], { metadata: { transporter: 99 } });
		init(s);
		s.naval.wantedTransportShips[SEA] = 2;
		for (const first of [100, 110, 120])
		{
			waiting(s, first);
			// each its own passage
			setSail(requireValue(s.transports.plans.at(-1)));
		}
		for (const p of s.transports.plans)
		{
			backToBoarding(p);
		}

		s.naval.checkLevels(s.world.gameState, queues(s.world));

		assert.equal(s.naval.neededTransportShips[SEA], 3);
		assert.equal(s.naval.wantedTransportShips[SEA], 3);
	});
});

describe("ships trained: maintainFleet and getBestShip", () =>
{
	/** a dock on our coast training the given ships */
	function yard(s: ReturnType<typeof seat>, trainable: string[])
	{
		dock(s.world, 300, [156, 160], trainable);
	}

	it("trains a transport for a sea short of them, and a fishing boat for a sea short of those", () =>
	{
		const s = seat();
		const bireme = shipCard(s.world, "units/athen/ship_bireme", {
			classes: ["Unit", "Ship", "Warship"],
			capacity: 20,
		});
		const boat = shipCard(s.world, "units/athen/ship_fishing", { classes: ["Unit", "Ship", "FishingBoat"] });
		yard(s, [bireme, boat]);
		fish(s.world, 400, [200, 100], 2000);
		init(s);
		s.naval.wantedTransportShips[SEA] = 1;

		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		const transport = queues(s.world).ships.plans.at(-1)!;
		assert.equal(transport.type, bireme);
		assert.deepEqual(transport.metadata, { sea: SEA });

		s.naval.wantedTransportShips[SEA] = 0;
		queues(s.world).ships.plans.length = 0;
		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		const fisher = queues(s.world).ships.plans.at(-1)!;
		assert.equal(fisher.type, boat);
		assert.deepEqual(fisher.metadata, { base: 0, role: "worker", sea: SEA });
	});

	it("trains nothing with no dock standing, while the ship queue is busy, or while a ship of that sea trains", () =>
	{
		const s = seat();
		const bireme = shipCard(s.world, "units/athen/ship_bireme", { capacity: 20 });
		dock(s.world, 300, [156, 160], [bireme], { foundation: true });
		init(s);
		s.naval.wantedTransportShips[SEA] = 1;
		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		assert.equal(queues(s.world).ships.plans.length, 0, "the dock is still a foundation");

		const t = seat();
		const card = shipCard(t.world, "units/athen/ship_bireme", { capacity: 20 });
		yard(t, [card]);
		init(t);
		t.naval.wantedTransportShips[SEA] = 1;
		t.world.gameState.countOwnQueuedEntitiesWithMetadata = () => 1;
		t.naval.maintainFleet(t.world.gameState, queues(t.world));
		assert.equal(queues(t.world).ships.plans.length, 0, "a ship already in training there");

		queues(t.world).ships.addPlan(new TrainingPlan(t.world.gameState, card, { sea: SEA }, 1, 1));
		t.world.gameState.countOwnQueuedEntitiesWithMetadata = () => 0;
		t.naval.maintainFleet(t.world.gameState, queues(t.world));
		assert.equal(queues(t.world).ships.plans.length, 1, "the queue is busy");
	});

	it("a transport is the ship that carries most: arrows and siege room count", () =>
	{
		const s = seat();
		const small = shipCard(s.world, "units/athen/ship_small", { capacity: 10 });
		const archers = shipCard(s.world, "units/athen/ship_archers", { capacity: 10, arrows: 2 });
		const raft = shipCard(s.world, "units/athen/ship_raft", { capacity: 1 });
		const siege = shipCard(s.world, "units/athen/ship_siege", {
			capacity: 10,
			garrisonable: ["Infantry", "Siege"],
		});
		yard(s, [siege, small, archers, raft]);
		init(s);

		assert.equal(getBestShip(s.world.gameState, SEA, "transport"), siege, "10 + 50 for siege beats 10 + 20");
	});

	it("a warship is the one with most arrows, a fishing boat a FishingBoat", () =>
	{
		const s = seat();
		const two = shipCard(s.world, "units/athen/ship_two", { classes: ["Unit", "Ship", "Warship"], arrows: 2 });
		const five = shipCard(s.world, "units/athen/ship_five", { classes: ["Unit", "Ship", "Warship"], arrows: 5 });
		const one = shipCard(s.world, "units/athen/ship_one", { classes: ["Unit", "Ship", "Warship"], arrows: 1 });
		const boat = shipCard(s.world, "units/athen/ship_fishing", { classes: ["Unit", "Ship", "FishingBoat"] });
		yard(s, [two, five, one, boat]);
		init(s);

		assert.equal(getBestShip(s.world.gameState, SEA, "attack"), five);
		assert.equal(getBestShip(s.world.gameState, SEA, "fishing"), boat);
	});

	it("leaves out ships the civ cannot train now, those disabled, those at their limit, and other units", () =>
	{
		const s = seat({
			worldOptions: {
				disabledTemplates: ["units/athen/ship_disabled"],
				entityLimits: { Hero: 1 },
				entityCounts: { Hero: 1 },
			},
		});
		const locked = shipCard(s.world, "units/athen/ship_locked", { capacity: 30, available: false });
		const disabled = shipCard(s.world, "units/athen/ship_disabled", { capacity: 30 });
		const hero = shipCard(s.world, "units/athen/ship_hero", { capacity: 30, category: "Hero" });
		const soldierCard = "units/athen/infantry";
		s.world.templates[soldierCard] = makeTemplate(soldierCard, { classes: ["Unit", "Infantry"] });
		const plain = shipCard(s.world, "units/athen/ship_plain", { capacity: 5 });
		yard(s, [locked, disabled, hero, soldierCard, plain]);
		init(s);

		assert.equal(getBestShip(s.world.gameState, SEA, "transport"), plain);
	});
});

describe("ships in the way: moveApart", () =>
{
	it("a transport with no route, still for STUCK_SECONDS, nudges itself, and pushes idle ships out of its way", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		delete p.routes[200]; // sent straight: no route of its plan
		// ships trained since the fleet was counted: they learned their sea then (checkEvents)
		const idle = ship(s.world, 201, [210, 165], { metadata: { sea: SEA } });
		const otherTransport = ship(s.world, 202, [205, 170], { metadata: { transporter: 99, sea: SEA } });
		const ranged: Array<[number, number[]]> = [];
		for (
			const [ent, id] of [[carrier.ent, 200], [idle.ent, 201], [otherTransport.ent, 202]] as Array<
				[CommonEntity, number]
			>
		)
		{
			override(ent, { moveToRange: (...args: number[]) => ranged.push([id, args]) });
		}

		s.naval.moveApart(s.world.gameState); // position noted
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + STUCK_SECONDS);
		otherTransport.state.pos = [204, 170]; // that one is under way
		s.naval.moveApart(s.world.gameState); // the first is still there STUCK_SECONDS later

		// the stuck ship moves a little around itself; the others make way, away from it
		const pushed = (id: number, min: number) =>
			ranged.some(([who, args]) => who === id && args[0] === 200 && args[1] === 160 && args[2] === min);
		assert.ok(
			ranged.some(([id, args]) => id === 200 && args[2] === 30 && args[3] === 35),
			"the stuck ship moves a little",
		);
		assert.ok(pushed(201, 40), "the idle ship makes way, 40 m off");
		assert.ok(pushed(202, 30), "another passage's ship under way keeps 30 m off");
	});

	// only the port passes: a nudge threw a routed transport's route away, and its
	// plan sent it again, round and round one spot (FINDINGS §45)
	it("a transport its plan sails by a route is left to its plan, however long it stands", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		assert.ok(p.routes[200], "sent by a route");
		const ranged: number[][] = [];
		override(carrier.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		s.naval.moveApart(s.world.gameState);
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3 * STUCK_SECONDS);
		s.naval.moveApart(s.world.gameState);
		assert.deepEqual(ranged, []);
	});

	it("a transport moving, or stuck for only a turn, or at its landing spot is left alone", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		const ranged: number[][] = [];
		override(carrier.ent, { moveToRange: (...args: number[]) => ranged.push(args) });

		s.naval.moveApart(s.world.gameState);
		carrier.state.pos = [195, 160];
		s.naval.moveApart(s.world.gameState); // it moved
		s.world.ai.playedTurn += 1;
		s.naval.moveApart(s.world.gameState); // stuck one turn only
		carrier.state.pos = p.shipPoints()[200];
		s.world.ai.playedTurn += 5;
		s.naval.moveApart(s.world.gameState); // boarding at the shore
		s.naval.moveApart(s.world.gameState);

		assert.deepEqual(ranged, []);
	});

	it("an idle ship moves off a dock only once it has stayed put, once, and not off another sea's dock", () =>
	{
		const s = seat();
		const parked = ship(s.world, 201, [200, 160]);
		const ranged: number[][] = [];
		override(parked.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		const near = dock(s.world, 300, [180, 160]);
		const far = dock(s.world, 301, [156, 40]);
		init(s);
		near.setMetadata(PlayerID, "sea", seaRegion(9)); // a dock on another sea
		void far;

		s.naval.moveApart(s.world.gameState); // noted
		parked.state.pos = [201, 160];
		s.naval.moveApart(s.world.gameState); // it drifted: noted again
		s.naval.moveApart(s.world.gameState); // now it stays: no dock of its sea near
		s.naval.moveApart(s.world.gameState); // already looked

		assert.deepEqual(ranged, []);
	});

	it("an idle ship parked by a dock moves off so as not to block it", () =>
	{
		const s = seat();
		const parked = ship(s.world, 201, [170, 160]);
		const ranged: number[][] = [];
		override(parked.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		dock(s.world, 300, [156, 160]);
		init(s);

		s.naval.moveApart(s.world.gameState); // position noted
		s.naval.moveApart(s.world.gameState); // it did not move

		assert.deepEqual(ranged, [[156, 160, 70, 75]]);
	});

	it("a merchant ship stuck on its way to market nudges itself and pushes other merchants out of its way", () =>
	{
		const s = seat();
		// merchant ships learn their sea when trained (checkEvents, TrainingFinished)
		const merchant = { classes: ["Unit", "Ship", "Trader"], metadata: { role: "trader", sea: SEA } };
		const stuck = ship(s.world, 210, [200, 160], merchant);
		stuck.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const other = ship(s.world, 211, [210, 165], merchant);
		init(s);
		const ranged: Array<[number, number[]]> = [];
		for (const [ent, id] of [[stuck.ent, 210], [other.ent, 211]] as Array<[CommonEntity, number]>)
		{
			override(ent, { moveToRange: (...args: number[]) => ranged.push([id, args]) });
		}

		s.naval.moveApart(s.world.gameState);
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + STUCK_SECONDS);
		s.naval.moveApart(s.world.gameState);

		assert.ok(ranged.some(([id, args]) => id === 210 && args[2] === 30), "the stuck merchant");
		assert.ok(
			ranged.some(([id, args]) => id === 211 && args[0] === 200 && args[2] === 40),
			"the merchant in its way",
		);
	});

	it("a merchant on its way to market keeps 30 m off a stuck one, and merchants of other seas are left be", () =>
	{
		const s = seat();
		const merchant = (sea: number, role = "trader") => ({
			classes: ["Unit", "Ship", "Trader"],
			metadata: { role, sea },
		});
		const stuck = ship(s.world, 210, [200, 160], merchant(SEA));
		stuck.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const sailing = ship(s.world, 211, [205, 170], merchant(SEA));
		sailing.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const foreign = ship(s.world, 212, [205, 150], merchant(9));
		ship(s.world, 214, undefined, merchant(SEA)); // aboard nothing, nowhere: a ship being built
		init(s);
		const ranged: Array<[number, number[]]> = [];
		for (const c of [stuck, sailing, foreign])
		{
			override(c.ent, { moveToRange: (...args: number[]) => ranged.push([c.ent.id(), args]) });
		}

		s.naval.moveApart(s.world.gameState);
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + STUCK_SECONDS);
		sailing.state.pos = [204, 170];
		s.naval.moveApart(s.world.gameState);

		assert.ok(
			ranged.some(([id, args]) => id === 211 && args[0] === 200 && args[2] === 30),
			"the moving merchant keeps off",
		);
		assert.ok(!ranged.some(([id]) => id === 212), "the merchant of another sea is left be");
	});

	// only the port passes: Petra took a ship unmoved for two turns for blocked,
	// and a ship turning in place was sent aside again and again (FINDINGS §45)
	it("a merchant stopped, or turning, on its way to market is not nudged before STUCK_SECONDS", () =>
	{
		const s = seat();
		const merchant = ship(s.world, 210, [200, 160], {
			classes: ["Unit", "Ship", "Trader"],
			metadata: { role: "trader", sea: SEA },
		});
		merchant.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const ranged: number[][] = [];
		override(merchant.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		init(s);

		let heading = 0;
		override(merchant.ent, { angle: () => heading });
		const start = s.world.ai.elapsedTime;
		s.naval.moveApart(s.world.gameState); // position noted
		s.world.ai.playedTurn += 2;
		s.world.ai.elapsedTime = seconds(start + STUCK_SECONDS - 1);
		s.naval.moveApart(s.world.gameState); // two turns, but not yet STUCK_SECONDS
		assert.deepEqual(ranged, []);

		heading = 1; // it turned in place
		s.world.ai.elapsedTime = seconds(start + STUCK_SECONDS);
		s.naval.moveApart(s.world.gameState);
		assert.deepEqual(ranged, [], "turning: not stuck");

		s.world.ai.elapsedTime = seconds(start + 2 * STUCK_SECONDS);
		s.naval.moveApart(s.world.gameState); // still, neither moved nor turned, for STUCK_SECONDS
		assert.equal(ranged.length, 1);
	});

	it("an idle merchant stays put when no dock of its sea is near", () =>
	{
		const s = seat();
		const parked = ship(s.world, 210, [200, 160], {
			classes: ["Unit", "Ship", "Trader"],
			metadata: { role: "trader", sea: SEA },
		});
		const ranged: number[][] = [];
		override(parked.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		const near = dock(s.world, 300, [180, 160]); // near, but on another sea
		dock(s.world, 301, [156, 40]); // on its sea, but far
		init(s);
		near.setMetadata(PlayerID, "sea", seaRegion(9));

		s.naval.moveApart(s.world.gameState); // noted
		s.naval.moveApart(s.world.gameState); // still: it looks around once

		assert.deepEqual(ranged, []);
	});

	it("an idle merchant parked by a dock moves off it", () =>
	{
		const s = seat();
		const parked = ship(s.world, 210, [170, 160], {
			classes: ["Unit", "Ship", "Trader"],
			metadata: { role: "trader", sea: SEA },
		});
		const ranged: number[][] = [];
		override(parked.ent, { moveToRange: (...args: number[]) => ranged.push(args) });
		dock(s.world, 300, [156, 160]);
		init(s);

		s.naval.moveApart(s.world.gameState);
		parked.state.pos = [171, 160];
		s.naval.moveApart(s.world.gameState); // it drifted
		s.naval.moveApart(s.world.gameState); // now still
		s.naval.moveApart(s.world.gameState); // already moved off once

		assert.deepEqual(ranged, [[156, 160, 70, 75]]);
	});
});

describe("docks and shipyards raised: buildNavalStructures", () =>
{
	/** a town big enough to want a dock, whose builders know the naval cards */
	function harbourTown(population: number, extra: Partial<Parameters<typeof navalWorld>[0]> = {})
	{
		const s = seat({ ...extra, worldOptions: { population, ...extra.worldOptions } });
		for (const name of ["dock", "shipyard", "super_dock", "market"])
		{
			s.world.templates["structures/athen/" + name] = structureTemplate("structures/athen/" + name, {
				classes: ["Structure", name === "market" ? "Market" : name === "dock" ? "Dock" : "Shipyard"],
				placement: name === "market" ? undefined : "shore",
				territories: ["own", "ally", "neutral"],
			});
		}
		s.world.addEntity(
			makeHqEntity({ id: 9001, owner: PLAYER, position: [30, 30], classes: ["Unit", "Support", "Worker"] }, {
				buildableEntities: () =>
					["dock", "shipyard", "super_dock", "market"].map((n) => "structures/athen/" + n),
			}),
		);
		s.hq.buildManager = BuildManager.start(s.world.gameState);
		init(s);
		return s;
	}

	it("a town big enough, on a land with no dock, queues one for the sea it lacks", () =>
	{
		const s = harbourTown(40);

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		const plan = queues(s.world).dock.plans.at(-1);
		assert.ok(plan, "a dock is queued");
		assert.deepEqual(plan.metadata, { land: { [WEST]: true }, sea: SEA });
	});

	it("a small town, or a town already raising a dock, queues none", () =>
	{
		const small = harbourTown(10);
		small.naval.buildNavalStructures(small.world.gameState, queues(small.world));
		assert.equal(queues(small.world).dock.plans.length, 0);

		const raising = harbourTown(40);
		dock(raising.world, 300, [156, 200], [], { foundation: true });
		raising.naval.buildNavalStructures(raising.world.gameState, queues(raising.world));
		assert.equal(queues(raising.world).dock.plans.length, 0);
	});

	it("a big town past the first phase with a dock and a market adds a shipyard", () =>
	{
		const s = harbourTown(200, { worldOptions: { phase: 2 } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(
			makeHqEntity({ id: 310, owner: PLAYER, position: [80, 80], classes: ["Structure", "Market"] }),
		);
		s.hq.currentPhase = 2;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		const plan = queues(s.world).militaryBuilding.plans.at(-1);
		assert.ok(plan, "a shipyard is queued");
		assert.equal(plan.type, "structures/athen/super_dock", "the super dock when the civ has one");
		assert.deepEqual(plan.metadata, { land: { [WEST]: true }, sea: SEA });
	});

	it("a civ with no super dock builds an ordinary shipyard, and with neither builds none", () =>
	{
		const s = harbourTown(200, { worldOptions: { phase: 2, disabledTemplates: ["structures/athen/super_dock"] } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(
			makeHqEntity({ id: 310, owner: PLAYER, position: [80, 80], classes: ["Structure", "Market"] }),
		);
		s.hq.currentPhase = 2;
		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));
		assert.equal(queues(s.world).militaryBuilding.plans.at(-1)?.type, "structures/athen/shipyard");

		const none = harbourTown(200, {
			worldOptions: { phase: 2, disabledTemplates: ["structures/athen/super_dock", "structures/athen/shipyard"] },
		});
		dock(none.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		none.world.addEntity(
			makeHqEntity({ id: 310, owner: PLAYER, position: [80, 80], classes: ["Structure", "Market"] }),
		);
		none.hq.currentPhase = 2;
		none.naval.buildNavalStructures(none.world.gameState, queues(none.world));
		assert.equal(queues(none.world).militaryBuilding.plans.length, 0);
	});

	it("a town that already has a shipyard builds no second one", () =>
	{
		const s = harbourTown(200, { worldOptions: { phase: 2 } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		dock(s.world, 301, [156, 220], [], { classes: ["Structure", "Shipyard"] }).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(
			makeHqEntity({ id: 310, owner: PLAYER, position: [80, 80], classes: ["Structure", "Market"] }),
		);
		s.hq.currentPhase = 2;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).militaryBuilding.plans.length, 0);
	});

	it("only one dock is queued per turn, and only for a town standing, on a sea we sail", () =>
	{
		const s = harbourTown(40);
		// a second town on the island, with its own sea to reach, and a colony still being raised
		const colony = s.world.addEntity(
			makeHqEntity({
				id: 320,
				owner: PLAYER,
				position: [280, 160],
				classes: ["Structure", "CivCentre"],
				templateName: "structures/athen/civil_centre",
			}),
		);
		const BaseManagerModule = s.hq.basesManager;
		BaseManagerModule.createBase(s.world.gameState, colony, "withAnchor");
		const rising = BaseManagerModule.createBase(s.world.gameState, colony, "withAnchor");
		rising.constructing = true;
		s.hq.navalRegions = { [SEA]: true };
		s.world.ai.accessibility.regionLinks[WEST] = [landRegion(9), SEA];

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).dock.plans.length, 1, "one dock this turn");
		assert.deepEqual(
			queues(s.world).dock.plans[0].metadata,
			{ land: { [WEST]: true }, sea: SEA },
			"sea 9 is not sailed",
		);
	});

	it("no dock is queued for a town with no civic centre, or one still being raised; a standing one gets it", () =>
	{
		const { BaseManager } = baseModule;
		/** a big town already connected by its dock, and on the island a town of the given kind,
		 * whose land also touches a second sea (9) its dock does not open on */
		const withIslandTown = (kind: "anchorless" | "unconstructed" | "anchored") =>
		{
			const s = harbourTown(40);
			dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
			s.hq.navalRegions = { [SEA]: true, 9: true };
			s.world.ai.accessibility.regionLinks[ISLAND] = [SEA, landRegion(9)];
			const islandDock = dock(s.world, 301, [244, 160]);
			islandDock.setMetadata(PlayerID, "sea", SEA);
			const create = (ent: CommonEntity, state: string) =>
				s.hq.basesManager.createBase(s.world.gameState, ent, state);
			if (kind === "anchorless")
			{
				create(islandDock, BaseManager.STATE_ANCHORLESS);
			}
			else
			{
				create(
					s.world.addEntity(
						makeHqEntity({
							id: 320,
							owner: PLAYER,
							position: [280, 160],
							classes: ["Structure", "CivCentre"],
							templateName: (kind === "unconstructed" ? "foundation|" : "") +
								"structures/athen/civil_centre",
						}, { foundationProgress: () => kind === "unconstructed" ? 0.2 : undefined }),
					),
					kind === "unconstructed" ? BaseManager.STATE_UNCONSTRUCTED : BaseManager.STATE_WITH_ANCHOR,
				);
			}
			s.naval.buildNavalStructures(s.world.gameState, queues(s.world));
			return queues(s.world).dock.plans;
		};

		assert.deepEqual(withIslandTown("anchorless"), [], "a base around a dock has no centre to serve");
		assert.deepEqual(withIslandTown("unconstructed"), [], "a centre still a foundation waits");
		const plans = withIslandTown("anchored");
		assert.equal(plans.length, 1);
		assert.deepEqual(plans[0].metadata, { land: { [ISLAND]: true }, sea: 9 });
	});

	it("a big town keeps its resources for a market first", () =>
	{
		const s = harbourTown(200, { worldOptions: { phase: 2 } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		s.hq.currentPhase = 2;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).militaryBuilding.plans.length, 0);
	});

	it("a land map raises no naval structure", () =>
	{
		const s = harbourTown(40);
		s.hq.navalMap = false;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).dock.plans.length, 0);
	});
});

describe("the fleet hearing the turn's events: checkEvents", () =>
{
	const events = (extra: Record<string, unknown[]>) => (eventsWith({ ...extra }));

	it("a new dock foundation, a ship just trained and a dock captured learn their sea", () =>
	{
		const s = seat();
		init(s);
		const rising = dock(s.world, 300, [156, 120], [], { foundation: true });
		const trained = ship(s.world, 200, [200, 160]);
		const captured = dock(s.world, 301, [156, 200]);

		s.naval.checkEvents(
			s.world.gameState,
			queues(s.world),
			events({
				Create: [{ entity: 300 }],
				TrainingFinished: [{ entities: [200] }],
				OwnershipChanged: [{ entity: 301, to: PLAYER }, { entity: 300, to: ENEMY }],
			}),
		);

		for (const ent of [rising, trained.ent, captured])
		{
			assert.equal(ent.getMetadata(PlayerID, "sea"), SEA);
		}
	});

	it("lets pass the events that concern no ship or dock of ours", () =>
	{
		const s = seat();
		init(s);
		const theirs = dock(s.world, 300, [156, 120], [], { foundation: true, owner: ENEMY });
		const house = s.world.addEntity(
			makeHqEntity({ id: 301, owner: PLAYER, position: [80, 80], classes: ["Structure", "House"] }, {
				foundationProgress: () => 0.2,
			}),
		);
		const recruit = soldier(s.world, 100, [80, 90]);

		assert.doesNotThrow(() =>
			s.naval.checkEvents(
				s.world.gameState,
				queues(s.world),
				events({
					Create: [{}, { entity: 300 }, { entity: 301 }],
					TrainingFinished: [{}, { entities: [100, 999] }],
					Destroy: [{ entity: 400, metadata: { [PlayerID]: { transporter: 77 } } }],
					OwnershipChanged: [{ entity: 999, to: PLAYER }],
				}),
			)
		);

		for (const ent of [theirs, house, recruit.ent])
		{
			assert.equal(ent.getMetadata(PlayerID, "sea"), undefined);
		}
	});
});

describe("the fleet through its turn: update", () =>
{
	it("closes a finished passage, hands out ships, and every third turn checks the fleet", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		const done = ship(s.world, 201, [200, 260]);
		init(s);
		const a = soldier(s.world, 100, [140, 160]);
		s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const finished = soldier(s.world, 101, [140, 260]);
		s.transports.requireTransport(s.world.gameState, finished.ent, ISLAND, WEST, worldPos(100, 260));
		const old = s.transports.plans[1];
		done.ent.setMetadata(PlayerID, "transporter", old.ID);
		s.world.removeEntity(101); // its last unit died

		s.world.ai.playedTurn = 3;
		s.naval.update(s.world.gameState, queues(s.world), emptyEvents());

		assert.equal(s.transports.plans.length, 1, "the empty passage is closed");
		assert.equal(done.ent.getMetadata(PlayerID, "transporter"), undefined, "and its ship freed");
		assert.ok(carrier.ent.getMetadata(PlayerID, "transporter") !== undefined, "the waiting passage got a ship");
	});
});

describe("the fleet saved and loaded", () =>
{
	it("comes back with the same wanted ships and passages", () =>
	{
		const s = seat();
		init(s);
		s.transports.requireTransport(
			s.world.gameState,
			soldier(s.world, 100, [140, 160]).ent,
			WEST,
			ISLAND,
			worldPos(280, 160),
		);
		s.naval.wantedTransportShips[SEA] = 2;
		const saved = s.naval.Serialize();
		// the passages are saved with the town
		const savedTown = s.hq.town.Serialize();

		const loaded = NavalManager.restore(s.hq.Config, s.world.gameState, s.hq.geography, saved, s.hq);
		s.hq.navalManager = loaded;
		s.hq.town.resume(s.world.gameState, savedTown);

		assert.equal(loaded.wantedTransportShips[SEA], 2);
		assert.equal(s.transports.plans.length, 1);
		assert.equal(s.transports.plans[0].units.length, 1, "the passage finds its unit again");
		assert.deepEqual(s.hq.town.Serialize(), savedTown);
	});
});
