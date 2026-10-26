/**
 * NavalManager: everything with a hull — the fleet sorted by sea, the
 * fishing boats a sea can feed, the transports that carry units across, the
 * ships trained and the docks raised. The suites seat a real office and its
 * real naval manager on the naval board (see tests/harness/navalWorld.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyEvents, eventsWith, fake, makeTemplate, override } from "./harness/fakes.ts";
import {
	ENEMY, makeGaiaSupply, makeHqEntity, MAP_CELLS, PLAYER, structureTemplate
} from "./harness/hqWorld.ts";
import { board, type HqWorld, ISLAND, navalWorld, SEA, ship, soldier, WEST } from "./harness/navalWorld.ts";

import { landRegion, seaRegion, worldPos } from "../adapter/brands.ts";
import * as baseModule from "../decision/baseManager.ts";
import { NavalManager } from "../decision/navalManager.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { TransportPlan } from "../execution/transportPlan.ts";

const PlayerID = PLAYER;

/** the naval board, its naval manager not yet initialised */
function seat(options: Parameters<typeof navalWorld>[0] = {})
{
	const s = navalWorld(options);
	// the trade office's merchants, as TradeManager.init collects them (role trader)
	const traders = s.world.gameState.getOwnUnits().filter((e: CommonEntity) => e.getMetadata(PlayerID, "role") === "trader");
	traders.registerUpdates();
	s.hq.tradeManager.traders = traders;
	return { ...s, "naval": s.hq.navalManager };
}

const init = (s: ReturnType<typeof seat>, deserializing = false) => s.naval.init(s.world.gameState, deserializing);

const queues = (world: HqWorld) => world.ai.queues;

/** a shoal of fish */
function fish(world: HqWorld, id: number, position: [number, number], amount = 1000)
{
	return world.addEntity(makeGaiaSupply({ id, position, "generic": "food", "specific": "fish", "classes": ["SeaCreature"], amount }));
}

/** a dock of ours, which may train the given ships */
function dock(world: HqWorld, id: number, position: [number, number], trainable: string[] = [],
	options: { foundation?: boolean; classes?: string[]; owner?: number } = {})
{
	return world.addEntity(makeHqEntity({
		id, "owner": options.owner ?? PLAYER, position, "classes": options.classes ?? ["Structure", "Dock"],
		"templateName": (options.foundation ? "foundation|" : "") + "structures/athen/dock"
	}, {
		"trainingQueue": () => [],
		"trainableEntities": () => trainable,
		"foundationProgress": () => options.foundation ? 0.5 : undefined
	}));
}

/** a ship card, answering what the common-api Template reads for ships */
function shipCard(world: HqWorld, name: string, detail: {
	classes?: string[]; capacity?: number; arrows?: number; garrisonable?: string[]; available?: boolean; category?: string;
} = {}): string
{
	world.templates[name] = fake<CommonTemplate>({
		...makeTemplate(name, { "classes": detail.classes ?? ["Unit", "Ship"], "available": detail.available ?? true,
			"trainingCategory": detail.category }),
		"getDefaultArrow": () => detail.arrows,
		"garrisonMax": () => detail.capacity,
		"garrisonableClasses": () => detail.garrisonable ?? ["Infantry"]
	});
	return name;
}

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

	it("sorts our ships by kind and by sea, leaving the merchant ships to the trade office", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 100]);
		ship(s.world, 201, [200, 200], { "classes": ["Unit", "Ship", "FishingBoat"], "capacity": 0 });
		ship(s.world, 202, [200, 250], { "classes": ["Unit", "Ship", "Trader"], "metadata": { "role": "trader" } });
		init(s);

		assert.equal(s.naval.ships.length, 2);
		assert.equal(s.naval.transportShips.length, 1, "the warship carries troops, the fishing boat does not");
		assert.equal(s.naval.warShips.length, 1);
		assert.equal(s.naval.fishShips.length, 1);
		assert.equal(s.naval.seaShips[SEA]?.length, 2, "each ship knows its sea");
		assert.equal(s.naval.seaTransportShips[SEA]?.length, 1);
		assert.equal(s.naval.seaFishShips[SEA]?.length, 1);
		assert.equal(s.naval.seaShips[WEST], undefined, "a land keeps no fleet");
	});

	it("maps where units can board and land: the shallows of each land on each sea", () =>
	{
		const s = seat();
		init(s);

		const width = MAP_CELLS * 4;
		for (const [land, from, to] of [[WEST, 152, 160], [ISLAND, 240, 248]])
		{
			const zone = s.naval.landingZones[land]?.[SEA];
			assert.ok(zone && zone.size > 0, `land ${land} has landing spots`);
			for (const i of zone)
			{
				const x = 2 * (i % width);
				assert.ok(x >= from && x < to, `in the shallows, got x = ${x}`);
			}
		}
	});

	it("leaves out a lone shallow cell with no room around it", () =>
	{
		const s = seat();
		// a single flooded cell inside our land: land 2 and sea 5 at once
		const width = MAP_CELLS * 4;
		const naval = s.world.map.navalPassMap;
		const lone = 20 + 80 * width;
		naval[lone] = SEA;
		init(s);

		assert.equal(s.naval.landingZones[WEST][SEA].has(lone), false);
	});

	it("tells each dock of ours which sea it opens on", () =>
	{
		const s = seat();
		const harbour = dock(s.world, 300, [156, 160]);
		init(s);

		assert.equal(harbour.getMetadata(PlayerID, "sea"), SEA);
	});

	it("on a loaded game, keeps the landing spots it saved rather than mapping them anew", () =>
	{
		const s = seat();
		init(s, true);
		assert.deepEqual(s.naval.landingZones, {});
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

describe("where fish can be caught: getFishSea and canFishSafely", () =>
{
	it("a shoal far from any shore is in the open sea, safe from everyone", () =>
	{
		const s = seat({ "island": false });
		const shoal = fish(s.world, 400, [300, 160]);
		init(s);

		assert.equal(s.naval.getFishSea(s.world.gameState, shoal), SEA);
		assert.equal(shoal.getMetadata(PlayerID, "opensea"), true);
		assert.equal(s.naval.canFishSafely(s.world.gameState, shoal), true);
	});

	it("a shoal by rocks, or by the edge of a round map, is still in the open sea; by land it is not", () =>
	{
		const access = (s: ReturnType<typeof seat>) =>
			s.world.ai.accessibility as unknown as { landPassMap: Uint8Array; navalPassMap: Uint8Array };
		// the farthest sample north of the shoal, 120 m off: passability cell (150, 140)
		const sample = 150 + 140 * MAP_CELLS * 4;

		const rocks = seat({ "island": false });
		const byRocks = fish(rocks.world, 400, [300, 160]);
		access(rocks).landPassMap[sample] = 1;	// neither land nor sea: region 1 on both grids
		access(rocks).navalPassMap[sample] = 1;
		init(rocks);	// counting the fish measures each shoal's sea
		assert.equal(byRocks.getMetadata(PlayerID, "opensea"), true, "the next sample inward is open water");

		const islet = seat({ "island": false });
		const byLand = fish(islet.world, 400, [300, 160]);
		access(islet).landPassMap[sample] = WEST;	// a scrap of land there instead
		init(islet);
		assert.equal(byLand.getMetadata(PlayerID, "opensea"), undefined);
	});

	it("a shoal near a shore is not in the open sea, and its sea is remembered", () =>
	{
		const s = seat();
		const shoal = fish(s.world, 400, [200, 160]);
		init(s);

		assert.equal(s.naval.getFishSea(s.world.gameState, shoal), SEA);
		assert.equal(shoal.getMetadata(PlayerID, "opensea"), undefined);
		assert.equal(shoal.getMetadata(PlayerID, "sea"), SEA);
		shoal.setMetadata(PlayerID, "sea", 9);
		assert.equal(s.naval.getFishSea(s.world.gameState, shoal), 9, "read back, not measured again");
	});

	it("a shoal near enemy ground is not safe to fish", () =>
	{
		const s = seat();
		const shoal = fish(s.world, 400, [200, 160]);
		init(s);
		assert.equal(s.naval.canFishSafely(s.world.gameState, shoal), true, "our ground and the open water around it");

		s.world.map.setTerritoryOwner(33, 20, ENEMY);	// on the island, 60 m east
		assert.equal(s.naval.canFishSafely(s.world.gameState, shoal), false);
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
		const yard = dock(s.world, 300, [156, 160], [], { "classes": ["Structure", "Shipyard"] });
		yard.setMetadata(PlayerID, "access", WEST);
		yard.setMetadata(PlayerID, "sea", SEA);

		assert.deepEqual(s.naval.getUnconnectedSeas(s.world.gameState, WEST), [SEA]);
	});
});

describe("units asking to cross the sea: requireTransport", () =>
{
	it("a unit that cannot board a ship gets no passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160], {}, { "canGarrison": () => false });
		init(s);

		assert.equal(s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), false);
		assert.equal(s.naval.transportPlans.length, 0);
	});

	it("a unit already booked on a passage gets no second one", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160], { "transport": 7 });
		init(s);

		assert.equal(s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), false);
	});

	it("the first unit opens a passage, the next on the same route joins it, the way back is another", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		const c = soldier(s.world, 102, [260, 170]);
		init(s);

		assert.equal(s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), true);
		assert.equal(s.naval.requireTransport(s.world.gameState, b.ent, WEST, ISLAND, worldPos(290, 160)), true);
		assert.equal(s.naval.requireTransport(s.world.gameState, c.ent, ISLAND, WEST, worldPos(100, 160)), true);

		assert.equal(s.naval.transportPlans.length, 2);
		assert.equal(s.naval.transportPlans[0].units.length, 2);
		assert.deepEqual(b.ent.getMetadata(PlayerID, "endPos"), [290, 160], "each keeps its own goal");
	});

	// only the port passes: the original sorts the waiting passages with a
	// one-argument function, which orders nothing; the port joins the unit to
	// the passage with the fewest units, as the code intends
	it("a unit joins the emptier of two passages waiting on its route, whichever was opened first", () =>
	{
		for (const smallFirst of [false, true])
		{
			const s = seat();
			const big = [0, 1, 2].map((k) => soldier(s.world, 100 + k, [140, 150 + 5 * k]));
			const lone = soldier(s.world, 110, [140, 200]);
			const newcomer = soldier(s.world, 120, [140, 210]);
			init(s);
			const open = (units: Array<ReturnType<typeof soldier>>) =>
			{
				for (const u of units)
					s.naval.requireTransport(s.world.gameState, u.ent, WEST, ISLAND, worldPos(280, 160));
				// close it to newcomers while the other one opens
				s.naval.transportPlans.at(-1)!.state = "opening";
			};
			if (smallFirst)
			{
				open([lone]);
				open(big);
			}
			else
			{
				open(big);
				open([lone]);
			}
			for (const p of s.naval.transportPlans)
				p.state = TransportPlan.BOARDING;

			s.naval.requireTransport(s.world.gameState, newcomer.ent, WEST, ISLAND, worldPos(280, 160));

			assert.equal(newcomer.ent.getMetadata(PlayerID, "transport"), lone.ent.getMetadata(PlayerID, "transport"),
				smallFirst ? "the small passage opened first" : "the small passage opened second");
		}
	});

	it("a passage already at sea takes no one more", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		init(s);
		s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		s.naval.transportPlans[0].state = TransportPlan.SAILING;

		s.naval.requireTransport(s.world.gameState, b.ent, WEST, ISLAND, worldPos(280, 160));

		assert.equal(s.naval.transportPlans.length, 2);
	});

	it("a passage with four siege engines takes no fifth", () =>
	{
		const s = seat();
		const rams = [0, 1, 2, 3, 4].map((k) => soldier(s.world, 110 + k, [140, 150 + k * 4], {}, {
			"hasClasses": (list: string[]) => list.includes("Siege")
		}));
		init(s);

		for (const ram of rams)
			s.naval.requireTransport(s.world.gameState, ram.ent, WEST, ISLAND, worldPos(280, 160));

		assert.equal(s.naval.transportPlans.length, 2);
		assert.equal(s.naval.transportPlans[0].units.length, 4);
	});

	it("a route with no sea between the lands gets no passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		init(s);

		assert.equal(s.naval.requireTransport(s.world.gameState, a.ent, WEST, landRegion(7), worldPos(280, 160)), false);
		assert.equal(s.naval.transportPlans.length, 0);
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});

	it("a split with no unit left to move makes no new passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		init(s);
		s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.naval.transportPlans[0];
		a.ent.setMetadata(PlayerID, "onBoard", 202);
		p.needSplit = [a.ent];

		assert.equal(s.naval.splitTransport(s.world.gameState, p), false);
		assert.equal(s.naval.transportPlans.length, 1);
	});
});

describe("a ship that starts the game with units aboard: createTransportIfNeeded", () =>
{
	/** a ship at sea with two soldiers aboard */
	function loaded(s: ReturnType<typeof seat>, id = 200, metadata: Record<string, unknown> = {})
	{
		const carrier = ship(s.world, id, [200, 160], { metadata });
		for (const k of [0, 1])
			board(soldier(s.world, id * 10 + k, undefined), carrier);
		return carrier;
	}

	it("carries its units to the land of the first building, from the sea where it waits", () =>
	{
		const s = seat();
		const carrier = loaded(s);
		ship(s.world, 201, [200, 200]);	// an empty ship has nothing to carry
		init(s);

		s.naval.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(280, 160), ISLAND);

		assert.equal(s.naval.transportPlans.length, 1);
		const p = s.naval.transportPlans[0];
		assert.equal(p.startIndex, 1, "from aboard");
		assert.equal(p.endIndex, ISLAND);
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), p.ID);
		assert.equal(p.units.length, 2);
	});

	it("does nothing for a ship already carrying for a plan, from land, or towards no land", () =>
	{
		const s = seat();
		loaded(s, 200, { "transporter": 99 });
		loaded(s, 201);
		init(s);

		s.naval.createTransportIfNeeded(s.world.gameState, worldPos(140, 160), worldPos(280, 160), ISLAND);
		// (the first building's caller always knows its land: ConstructionPlan.start sets it)
		s.naval.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(200, 160), landRegion(1));
		assert.equal(s.naval.transportPlans.length, 0);

		s.naval.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(280, 160), ISLAND);
		assert.equal(s.naval.transportPlans.length, 1, "only the free ship");
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
			s.naval.requireTransport(s.world.gameState, soldier(s.world, first + k, [140, 150 + 10 * k]).ent,
				WEST, ISLAND, worldPos(280, 160));
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
		lone.naval.requireTransport(lone.world.gameState, soldier(lone.world, 100, [140, 160]).ent, WEST, ISLAND, worldPos(280, 160));
		lone.naval.checkLevels(lone.world.gameState, queues(lone.world));
		assert.equal(lone.naval.wantedTransportShips[SEA], 0, "one unit");

		const training = seat();
		init(training);
		waiting(training);
		training.world.gameState
			.countOwnQueuedEntitiesWithMetadata = () => 1;
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
		ship(s.world, 200, [200, 100], { "metadata": { "transporter": 98 } });
		ship(s.world, 201, [200, 200], { "metadata": { "transporter": 99 } });
		init(s);
		s.naval.wantedTransportShips[SEA] = 2;
		for (const first of [100, 110, 120])
		{
			waiting(s, first);
			// each its own passage
			s.naval.transportPlans.at(-1)!.state = "waiting";
		}
		for (const p of s.naval.transportPlans)
			p.state = TransportPlan.BOARDING;

		s.naval.checkLevels(s.world.gameState, queues(s.world));

		assert.equal(s.naval.neededTransportShips[SEA], 3);
		assert.equal(s.naval.wantedTransportShips[SEA], 3);
	});
});

describe("ships trained and handed out: maintainFleet, getBestShip and assignShipsToPlans", () =>
{
	/** a dock on our coast training the given ships */
	function yard(s: ReturnType<typeof seat>, trainable: string[])
	{
		dock(s.world, 300, [156, 160], trainable);
	}

	it("trains a transport for a sea short of them, and a fishing boat for a sea short of those", () =>
	{
		const s = seat();
		const bireme = shipCard(s.world, "units/athen/ship_bireme", { "classes": ["Unit", "Ship", "Warship"], "capacity": 20 });
		const boat = shipCard(s.world, "units/athen/ship_fishing", { "classes": ["Unit", "Ship", "FishingBoat"] });
		yard(s, [bireme, boat]);
		fish(s.world, 400, [200, 100], 2000);
		init(s);
		s.naval.wantedTransportShips[SEA] = 1;

		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		const transport = queues(s.world).ships.plans.at(-1)!;
		assert.equal(transport.type, bireme);
		assert.deepEqual(transport.metadata, { "sea": SEA });

		s.naval.wantedTransportShips[SEA] = 0;
		queues(s.world).ships.plans.length = 0;
		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		const fisher = queues(s.world).ships.plans.at(-1)!;
		assert.equal(fisher.type, boat);
		assert.deepEqual(fisher.metadata, { "base": 0, "role": "worker", "sea": SEA });
	});

	it("trains nothing with no dock standing, while the ship queue is busy, or while a ship of that sea trains", () =>
	{
		const s = seat();
		const bireme = shipCard(s.world, "units/athen/ship_bireme", { "capacity": 20 });
		dock(s.world, 300, [156, 160], [bireme], { "foundation": true });
		init(s);
		s.naval.wantedTransportShips[SEA] = 1;
		s.naval.maintainFleet(s.world.gameState, queues(s.world));
		assert.equal(queues(s.world).ships.plans.length, 0, "the dock is still a foundation");

		const t = seat();
		const card = shipCard(t.world, "units/athen/ship_bireme", { "capacity": 20 });
		yard(t, [card]);
		init(t);
		t.naval.wantedTransportShips[SEA] = 1;
		t.world.gameState
			.countOwnQueuedEntitiesWithMetadata = () => 1;
		t.naval.maintainFleet(t.world.gameState, queues(t.world));
		assert.equal(queues(t.world).ships.plans.length, 0, "a ship already in training there");

		queues(t.world).ships.addPlan(new TrainingPlan(t.world.gameState, card, { "sea": SEA }, 1, 1));
		t.world.gameState
			.countOwnQueuedEntitiesWithMetadata = () => 0;
		t.naval.maintainFleet(t.world.gameState, queues(t.world));
		assert.equal(queues(t.world).ships.plans.length, 1, "the queue is busy");
	});

	it("a transport is the ship that carries most: arrows and siege room count", () =>
	{
		const s = seat();
		const small = shipCard(s.world, "units/athen/ship_small", { "capacity": 10 });
		const archers = shipCard(s.world, "units/athen/ship_archers", { "capacity": 10, "arrows": 2 });
		const raft = shipCard(s.world, "units/athen/ship_raft", { "capacity": 1 });
		const siege = shipCard(s.world, "units/athen/ship_siege", { "capacity": 10, "garrisonable": ["Infantry", "Siege"] });
		yard(s, [siege, small, archers, raft]);
		init(s);

		assert.equal(s.naval.getBestShip(s.world.gameState, SEA, "transport"), siege, "10 + 50 for siege beats 10 + 20");
	});

	it("a warship is the one with most arrows, a fishing boat a FishingBoat", () =>
	{
		const s = seat();
		const two = shipCard(s.world, "units/athen/ship_two", { "classes": ["Unit", "Ship", "Warship"], "arrows": 2 });
		const five = shipCard(s.world, "units/athen/ship_five", { "classes": ["Unit", "Ship", "Warship"], "arrows": 5 });
		const one = shipCard(s.world, "units/athen/ship_one", { "classes": ["Unit", "Ship", "Warship"], "arrows": 1 });
		const boat = shipCard(s.world, "units/athen/ship_fishing", { "classes": ["Unit", "Ship", "FishingBoat"] });
		yard(s, [two, five, one, boat]);
		init(s);

		assert.equal(s.naval.getBestShip(s.world.gameState, SEA, "attack"), five);
		assert.equal(s.naval.getBestShip(s.world.gameState, SEA, "fishing"), boat);
	});

	it("leaves out ships the civ cannot train now, those disabled, those at their limit, and other units", () =>
	{
		const s = seat({ "worldOptions": {
			"disabledTemplates": ["units/athen/ship_disabled"],
			"entityLimits": { "Hero": 1 }, "entityCounts": { "Hero": 1 }
		} });
		const locked = shipCard(s.world, "units/athen/ship_locked", { "capacity": 30, "available": false });
		const disabled = shipCard(s.world, "units/athen/ship_disabled", { "capacity": 30 });
		const hero = shipCard(s.world, "units/athen/ship_hero", { "capacity": 30, "category": "Hero" });
		const soldierCard = "units/athen/infantry";
		s.world.templates[soldierCard] = makeTemplate(soldierCard, { "classes": ["Unit", "Infantry"] });
		const plain = shipCard(s.world, "units/athen/ship_plain", { "capacity": 5 });
		yard(s, [locked, disabled, hero, soldierCard, plain]);
		init(s);

		assert.equal(s.naval.getBestShip(s.world.gameState, SEA, "transport"), plain);
	});

	it("hands free ships to the passages waiting for one", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		init(s);
		s.naval.requireTransport(s.world.gameState, soldier(s.world, 100, [140, 160]).ent, WEST, ISLAND, worldPos(280, 160));

		s.naval.assignShipsToPlans(s.world.gameState);

		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), s.naval.transportPlans[0].ID);
	});
});

describe("ships boarding and ships in the way: isShipBoarding and moveApart", () =>
{
	/** a passage with its ship sent to our shore */
	function boarding(s: ReturnType<typeof seat>)
	{
		const carrier = ship(s.world, 200, [200, 160]);
		init(s);
		s.naval.requireTransport(s.world.gameState, soldier(s.world, 100, [140, 160]).ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.naval.transportPlans[0];
		s.naval.assignShipsToPlans(s.world.gameState);
		p.update(s.world.gameState);
		return { carrier, p };
	}

	it("a ship of a passage is boarding once at its landing spot, not before", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		assert.equal(s.naval.isShipBoarding(carrier.ent), false, "still at sea");

		carrier.state.pos = p.boardingPos[200];
		assert.equal(s.naval.isShipBoarding(carrier.ent), true);

		carrier.state.pos = undefined;
		assert.equal(s.naval.isShipBoarding(carrier.ent), false, "a ship with no position is not boarding");
	});

	it("a ship of no passage is not boarding", () =>
	{
		const s = seat();
		const free = ship(s.world, 200, [200, 160]);
		init(s);
		assert.equal(s.naval.isShipBoarding(free.ent), false);
	});

	it("a transport stuck in one place for two turns nudges itself, and pushes idle ships out of its way", () =>
	{
		const s = seat();
		const { carrier } = boarding(s);
		// ships trained since the fleet was counted: they learned their sea then (checkEvents)
		const idle = ship(s.world, 201, [210, 165], { "metadata": { "sea": SEA } });
		const otherTransport = ship(s.world, 202, [205, 170], { "metadata": { "transporter": 99, "sea": SEA } });
		const ranged: Array<[number, number[]]> = [];
		for (const [ent, id] of [[carrier.ent, 200], [idle.ent, 201], [otherTransport.ent, 202]] as Array<[CommonEntity, number]>)
			override(ent, { "moveToRange": (...args: number[]) => ranged.push([id, args]) });

		s.naval.moveApart(s.world.gameState);	// position noted
		s.world.ai.playedTurn += 2;
		otherTransport.state.pos = [204, 170];	// that one is under way
		s.naval.moveApart(s.world.gameState);	// the first is still there two turns later

		// the stuck ship moves a little around itself; the others make way, away from it
		const pushed = (id: number, min: number) => ranged.some(([who, args]) => who === id && args[0] === 200 && args[1] === 160 && args[2] === min);
		assert.ok(ranged.some(([id, args]) => id === 200 && args[2] === 30 && args[3] === 35), "the stuck ship moves a little");
		assert.ok(pushed(201, 40), "the idle ship makes way, 40 m off");
		assert.ok(pushed(202, 30), "another passage's ship under way keeps 30 m off");
	});

	it("a transport moving, or stuck for only a turn, or at its landing spot is left alone", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		const ranged: number[][] = [];
		override(carrier.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });

		s.naval.moveApart(s.world.gameState);
		carrier.state.pos = [195, 160];
		s.naval.moveApart(s.world.gameState);	// it moved
		s.world.ai.playedTurn += 1;
		s.naval.moveApart(s.world.gameState);	// stuck one turn only
		carrier.state.pos = p.boardingPos[200];
		s.world.ai.playedTurn += 5;
		s.naval.moveApart(s.world.gameState);	// boarding at the shore
		s.naval.moveApart(s.world.gameState);

		assert.deepEqual(ranged, []);
	});

	it("an idle ship moves off a dock only once it has stayed put, once, and not off another sea's dock", () =>
	{
		const s = seat();
		const parked = ship(s.world, 201, [200, 160]);
		const ranged: number[][] = [];
		override(parked.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });
		const near = dock(s.world, 300, [180, 160]);
		const far = dock(s.world, 301, [156, 40]);
		init(s);
		near.setMetadata(PlayerID, "sea", 9);	// a dock on another sea
		void far;

		s.naval.moveApart(s.world.gameState);	// noted
		parked.state.pos = [201, 160];
		s.naval.moveApart(s.world.gameState);	// it drifted: noted again
		s.naval.moveApart(s.world.gameState);	// now it stays: no dock of its sea near
		s.naval.moveApart(s.world.gameState);	// already looked

		assert.deepEqual(ranged, []);
	});

	it("an idle ship parked by a dock moves off so as not to block it", () =>
	{
		const s = seat();
		const parked = ship(s.world, 201, [170, 160]);
		const ranged: number[][] = [];
		override(parked.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });
		dock(s.world, 300, [156, 160]);
		init(s);

		s.naval.moveApart(s.world.gameState);	// position noted
		s.naval.moveApart(s.world.gameState);	// it did not move

		assert.deepEqual(ranged, [[156, 160, 70, 75]]);
	});

	it("a merchant ship stuck on its way to market nudges itself and pushes other merchants out of its way", () =>
	{
		const s = seat();
		// merchant ships learn their sea when trained (checkEvents, TrainingFinished)
		const merchant = { "classes": ["Unit", "Ship", "Trader"], "metadata": { "role": "trader", "sea": SEA } };
		const stuck = ship(s.world, 210, [200, 160], merchant);
		stuck.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const other = ship(s.world, 211, [210, 165], merchant);
		init(s);
		const ranged: Array<[number, number[]]> = [];
		for (const [ent, id] of [[stuck.ent, 210], [other.ent, 211]] as Array<[CommonEntity, number]>)
			override(ent, { "moveToRange": (...args: number[]) => ranged.push([id, args]) });

		s.naval.moveApart(s.world.gameState);
		s.world.ai.playedTurn += 2;
		s.naval.moveApart(s.world.gameState);

		assert.ok(ranged.some(([id, args]) => id === 210 && args[2] === 30), "the stuck merchant");
		assert.ok(ranged.some(([id, args]) => id === 211 && args[0] === 200 && args[2] === 40), "the merchant in its way");
	});

	it("a merchant on its way to market keeps 30 m off a stuck one, and merchants of other seas are left be", () =>
	{
		const s = seat();
		const merchant = (sea: number, role = "trader") => ({ "classes": ["Unit", "Ship", "Trader"], "metadata": { role, sea } });
		const stuck = ship(s.world, 210, [200, 160], merchant(SEA));
		stuck.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const sailing = ship(s.world, 211, [205, 170], merchant(SEA));
		sailing.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const foreign = ship(s.world, 212, [205, 150], merchant(9));
		ship(s.world, 214, undefined, merchant(SEA));	// aboard nothing, nowhere: a ship being built
		init(s);
		const ranged: Array<[number, number[]]> = [];
		for (const c of [stuck, sailing, foreign])
			override(c.ent, { "moveToRange": (...args: number[]) => ranged.push([c.ent.id(), args]) });

		s.naval.moveApart(s.world.gameState);
		s.world.ai.playedTurn += 2;
		sailing.state.pos = [204, 170];
		s.naval.moveApart(s.world.gameState);

		assert.ok(ranged.some(([id, args]) => id === 211 && args[0] === 200 && args[2] === 30), "the moving merchant keeps off");
		assert.ok(!ranged.some(([id]) => id === 212), "the merchant of another sea is left be");
	});

	it("a merchant stopped for a single turn on its way to market is not nudged yet", () =>
	{
		const s = seat();
		const merchant = ship(s.world, 210, [200, 160], { "classes": ["Unit", "Ship", "Trader"], "metadata": { "role": "trader", "sea": SEA } });
		merchant.state.aiState = "INDIVIDUAL.TRADE.APPROACHINGMARKET";
		const ranged: number[][] = [];
		override(merchant.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });
		init(s);

		s.naval.moveApart(s.world.gameState);	// position noted
		s.world.ai.playedTurn += 1;
		s.naval.moveApart(s.world.gameState);	// one turn: it may just be turning
		assert.deepEqual(ranged, []);

		s.world.ai.playedTurn += 1;
		s.naval.moveApart(s.world.gameState);	// two turns: stuck
		assert.equal(ranged.length, 1);
	});

	it("an idle merchant stays put when no dock of its sea is near", () =>
	{
		const s = seat();
		const parked = ship(s.world, 210, [200, 160], { "classes": ["Unit", "Ship", "Trader"], "metadata": { "role": "trader", "sea": SEA } });
		const ranged: number[][] = [];
		override(parked.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });
		const near = dock(s.world, 300, [180, 160]);	// near, but on another sea
		dock(s.world, 301, [156, 40]);	// on its sea, but far
		init(s);
		near.setMetadata(PlayerID, "sea", 9);

		s.naval.moveApart(s.world.gameState);	// noted
		s.naval.moveApart(s.world.gameState);	// still: it looks around once

		assert.deepEqual(ranged, []);
	});

	it("an idle merchant parked by a dock moves off it", () =>
	{
		const s = seat();
		const parked = ship(s.world, 210, [170, 160], { "classes": ["Unit", "Ship", "Trader"], "metadata": { "role": "trader", "sea": SEA } });
		const ranged: number[][] = [];
		override(parked.ent, { "moveToRange": (...args: number[]) => ranged.push(args) });
		dock(s.world, 300, [156, 160]);
		init(s);

		s.naval.moveApart(s.world.gameState);
		parked.state.pos = [171, 160];
		s.naval.moveApart(s.world.gameState);	// it drifted
		s.naval.moveApart(s.world.gameState);	// now still
		s.naval.moveApart(s.world.gameState);	// already moved off once

		assert.deepEqual(ranged, [[156, 160, 70, 75]]);
	});
});

describe("docks and shipyards raised: buildNavalStructures", () =>
{
	/** a town big enough to want a dock, whose builders know the naval cards */
	function harbourTown(population: number, extra: Partial<Parameters<typeof navalWorld>[0]> = {})
	{
		const s = seat({ ...extra, "worldOptions": { population, ...extra.worldOptions } });
		for (const name of ["dock", "shipyard", "super_dock", "market"])
			s.world.templates["structures/athen/" + name] = structureTemplate("structures/athen/" + name, {
				"classes": ["Structure", name === "market" ? "Market" : name === "dock" ? "Dock" : "Shipyard"],
				"placement": name === "market" ? undefined : "shore", "territories": ["own", "ally", "neutral"]
			});
		s.world.addEntity(makeHqEntity({ "id": 9001, "owner": PLAYER, "position": [30, 30], "classes": ["Unit", "Support", "Worker"] }, {
			"buildableEntities": () => ["dock", "shipyard", "super_dock", "market"].map((n) => "structures/athen/" + n)
		}));
		s.hq.buildManager.init(s.world.gameState);
		init(s);
		return s;
	}

	it("a town big enough, on a land with no dock, queues one for the sea it lacks", () =>
	{
		const s = harbourTown(40);

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		const plan = queues(s.world).dock.plans.at(-1);
		assert.ok(plan, "a dock is queued");
		assert.deepEqual(plan.metadata, { "land": { [WEST]: true }, "sea": SEA });
	});

	it("a small town, or a town already raising a dock, queues none", () =>
	{
		const small = harbourTown(10);
		small.naval.buildNavalStructures(small.world.gameState, queues(small.world));
		assert.equal(queues(small.world).dock.plans.length, 0);

		const raising = harbourTown(40);
		dock(raising.world, 300, [156, 200], [], { "foundation": true });
		raising.naval.buildNavalStructures(raising.world.gameState, queues(raising.world));
		assert.equal(queues(raising.world).dock.plans.length, 0);
	});

	it("a big town past the first phase with a dock and a market adds a shipyard", () =>
	{
		const s = harbourTown(200, { "worldOptions": { "phase": 2 } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(makeHqEntity({ "id": 310, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "Market"] }));
		s.hq.currentPhase = 2;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		const plan = queues(s.world).militaryBuilding.plans.at(-1);
		assert.ok(plan, "a shipyard is queued");
		assert.equal(plan.type, "structures/athen/super_dock", "the super dock when the civ has one");
		assert.deepEqual(plan.metadata, { "land": { [WEST]: true }, "sea": SEA });
	});

	it("a civ with no super dock builds an ordinary shipyard, and with neither builds none", () =>
	{
		const s = harbourTown(200, { "worldOptions": { "phase": 2, "disabledTemplates": ["structures/athen/super_dock"] } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(makeHqEntity({ "id": 310, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "Market"] }));
		s.hq.currentPhase = 2;
		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));
		assert.equal(queues(s.world).militaryBuilding.plans.at(-1)?.type, "structures/athen/shipyard");

		const none = harbourTown(200, { "worldOptions": { "phase": 2,
			"disabledTemplates": ["structures/athen/super_dock", "structures/athen/shipyard"] } });
		dock(none.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		none.world.addEntity(makeHqEntity({ "id": 310, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "Market"] }));
		none.hq.currentPhase = 2;
		none.naval.buildNavalStructures(none.world.gameState, queues(none.world));
		assert.equal(queues(none.world).militaryBuilding.plans.length, 0);
	});

	it("a town that already has a shipyard builds no second one", () =>
	{
		const s = harbourTown(200, { "worldOptions": { "phase": 2 } });
		dock(s.world, 300, [156, 160]).setMetadata(PlayerID, "sea", SEA);
		dock(s.world, 301, [156, 220], [], { "classes": ["Structure", "Shipyard"] }).setMetadata(PlayerID, "sea", SEA);
		s.world.addEntity(makeHqEntity({ "id": 310, "owner": PLAYER, "position": [80, 80], "classes": ["Structure", "Market"] }));
		s.hq.currentPhase = 2;

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).militaryBuilding.plans.length, 0);
	});

	it("only one dock is queued per turn, and only for a town standing, on a sea we sail", () =>
	{
		const s = harbourTown(40);
		// a second town on the island, with its own sea to reach, and a colony still being raised
		const colony = s.world.addEntity(makeHqEntity({ "id": 320, "owner": PLAYER, "position": [280, 160],
			"classes": ["Structure", "CivCentre"], "templateName": "structures/athen/civil_centre" }));
		const BaseManagerModule = s.hq.basesManager;
		BaseManagerModule.createBase(s.world.gameState, colony, "withAnchor");
		const rising = BaseManagerModule.createBase(s.world.gameState, colony, "withAnchor");
		rising.constructing = true;
		s.hq.navalRegions = { [SEA]: true };
		s.world.ai.accessibility.regionLinks[WEST] = [landRegion(9), SEA];

		s.naval.buildNavalStructures(s.world.gameState, queues(s.world));

		assert.equal(queues(s.world).dock.plans.length, 1, "one dock this turn");
		assert.deepEqual(queues(s.world).dock.plans[0].metadata, { "land": { [WEST]: true }, "sea": SEA }, "sea 9 is not sailed");
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
				create(islandDock, BaseManager.STATE_ANCHORLESS);
			else
				create(s.world.addEntity(makeHqEntity({
					"id": 320, "owner": PLAYER, "position": [280, 160], "classes": ["Structure", "CivCentre"],
					"templateName": (kind === "unconstructed" ? "foundation|" : "") + "structures/athen/civil_centre"
				}, { "foundationProgress": () => kind === "unconstructed" ? 0.2 : undefined })),
				kind === "unconstructed" ? BaseManager.STATE_UNCONSTRUCTED : BaseManager.STATE_WITH_ANCHOR);
			s.naval.buildNavalStructures(s.world.gameState, queues(s.world));
			return queues(s.world).dock.plans;
		};

		assert.deepEqual(withIslandTown("anchorless"), [], "a base around a dock has no centre to serve");
		assert.deepEqual(withIslandTown("unconstructed"), [], "a centre still a foundation waits");
		const plans = withIslandTown("anchored");
		assert.equal(plans.length, 1);
		assert.deepEqual(plans[0].metadata, { "land": { [ISLAND]: true }, "sea": 9 });
	});

	it("a big town keeps its resources for a market first", () =>
	{
		const s = harbourTown(200, { "worldOptions": { "phase": 2 } });
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
		const rising = dock(s.world, 300, [156, 120], [], { "foundation": true });
		const trained = ship(s.world, 200, [200, 160]);
		const captured = dock(s.world, 301, [156, 200]);

		s.naval.checkEvents(s.world.gameState, queues(s.world), events({
			"Create": [{ "entity": 300 }],
			"TrainingFinished": [{ "entities": [200] }],
			"OwnershipChanged": [{ "entity": 301, "to": PLAYER }, { "entity": 300, "to": ENEMY }]
		}));

		for (const ent of [rising, trained.ent, captured])
			assert.equal(ent.getMetadata(PlayerID, "sea"), SEA);
	});

	it("lets pass the events that concern no ship or dock of ours", () =>
	{
		const s = seat();
		init(s);
		const theirs = dock(s.world, 300, [156, 120], [], { "foundation": true, "owner": ENEMY });
		const house = s.world.addEntity(makeHqEntity({ "id": 301, "owner": PLAYER, "position": [80, 80],
			"classes": ["Structure", "House"] }, { "foundationProgress": () => 0.2 }));
		const recruit = soldier(s.world, 100, [80, 90]);

		assert.doesNotThrow(() => s.naval.checkEvents(s.world.gameState, queues(s.world), events({
			"Create": [{}, { "entity": 300 }, { "entity": 301 }],
			"TrainingFinished": [{}, { "entities": [100, 999] }],
			"Destroy": [{ "entity": 400, "metadata": { [PlayerID]: { "transporter": 77 } } }],
			"OwnershipChanged": [{ "entity": 999, "to": PLAYER }]
		})));

		for (const ent of [theirs, house, recruit.ent])
			assert.equal(ent.getMetadata(PlayerID, "sea"), undefined);
	});

	it("a passage whose ship sank at sea leaves the units still aboard another of its ships alone", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 160]);
		const aboard = soldier(s.world, 100, [140, 160]);
		init(s);
		s.naval.requireTransport(s.world.gameState, aboard.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.naval.transportPlans[0];
		p.state = TransportPlan.SAILING;
		aboard.state.pos = undefined;	// aboard the plan's other ship
		s.world.removeEntity(200);

		s.naval.checkEvents(s.world.gameState, queues(s.world), events({
			"Destroy": [{ "entity": 200, "metadata": { [PlayerID]: { "transporter": p.ID } } }]
		}));

		assert.equal(aboard.ent.getMetadata(PlayerID, "transport"), p.ID);
	});

	it("a passage whose ship sank while boarding waits for another ship", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		init(s);
		s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.naval.transportPlans[0];
		s.naval.assignShipsToPlans(s.world.gameState);
		p.update(s.world.gameState);
		s.world.removeEntity(200);

		s.naval.checkEvents(s.world.gameState, queues(s.world), events({
			"Destroy": [{ "entity": 200, "metadata": { [PlayerID]: { "transporter": p.ID } } }]
		}));

		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), undefined);
		assert.equal(p.needTransportShips, true);
		void carrier;
	});

	it("a passage whose ship sank at sea lets the survivors ashore ask again from where they stand", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		init(s);
		for (const u of [a, b])
			s.naval.requireTransport(s.world.gameState, u.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.naval.transportPlans[0];
		p.state = TransportPlan.SAILING;
		b.state.pos = [250, 160];	// already landed on the island
		s.world.removeEntity(200);

		s.naval.checkEvents(s.world.gameState, queues(s.world), events({
			"Destroy": [{ "entity": 200, "metadata": { [PlayerID]: { "transporter": p.ID } } }, { "entity": 999 }]
		}));

		assert.notEqual(a.ent.getMetadata(PlayerID, "transport"), p.ID);
		assert.equal(s.naval.transportPlans.length, 2, "a new passage for the one still on our land");
		assert.equal(b.ent.getMetadata(PlayerID, "transport"), undefined, "the one at its goal needs none");
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
		s.naval.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const finished = soldier(s.world, 101, [140, 260]);
		s.naval.requireTransport(s.world.gameState, finished.ent, ISLAND, WEST, worldPos(100, 260));
		const old = s.naval.transportPlans[1];
		done.ent.setMetadata(PlayerID, "transporter", old.ID);
		s.world.removeEntity(101);	// its last unit died

		s.world.ai.playedTurn = 3;
		s.naval.update(s.world.gameState, queues(s.world), emptyEvents());

		assert.equal(s.naval.transportPlans.length, 1, "the empty passage is closed");
		assert.equal(done.ent.getMetadata(PlayerID, "transporter"), undefined, "and its ship freed");
		assert.ok(carrier.ent.getMetadata(PlayerID, "transporter") !== undefined, "the waiting passage got a ship");
	});
});

describe("the fleet saved and loaded", () =>
{
	it("comes back with the same wanted ships, landing spots and passages", () =>
	{
		const s = seat();
		init(s);
		s.naval.requireTransport(s.world.gameState, soldier(s.world, 100, [140, 160]).ent, WEST, ISLAND, worldPos(280, 160));
		s.naval.wantedTransportShips[SEA] = 2;
		const saved = s.naval.Serialize();

		const loaded = new NavalManager(s.hq.Config);
		s.hq.navalManager = loaded;
		loaded.init(s.world.gameState, true);
		loaded.Deserialize(s.world.gameState, saved);

		assert.equal(loaded.wantedTransportShips[SEA], 2);
		assert.equal(loaded.landingZones, saved.properties.landingZones);
		assert.equal(loaded.transportPlans.length, 1);
		assert.equal(loaded.transportPlans[0].units.length, 1, "the passage finds its unit again");
		assert.deepEqual(loaded.Serialize().transports, saved.transports);
	});
});
