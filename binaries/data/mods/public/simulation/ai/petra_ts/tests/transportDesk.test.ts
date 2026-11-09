/**
 * The town's transports (execution/transportDesk.ts): the passages units ask
 * across the sea, made, joined, split and refused; a starting ship's crossing;
 * free ships handed to the passages; a ship boarding; and a passage mended
 * when one of its ships sinks. The suites seat a real office and its real
 * naval manager, whose desk the town's transports are, on the naval board
 * (tests/harness/navalSeat.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventsWith } from "./harness/fakes.ts";
import { PLAYER } from "./harness/hqWorld.ts";
import { backToBoarding, boarding, init, queues, seat, setSail } from "./harness/navalSeat.ts";
import { ISLAND, WEST, board, ship, soldier } from "./harness/navalWorld.ts";

import { entityId, landRegion, worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";

const PlayerID = PLAYER;

describe("units asking to cross the sea: requireTransport", () =>
{
	it("a unit that cannot board a ship gets no passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160], {}, { canGarrison: () => false });
		init(s);

		assert.equal(s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), false);
		assert.equal(s.transports.plans.length, 0);
	});

	it("a unit already booked on a passage gets no second one", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160], { transport: 7 });
		init(s);

		assert.equal(s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), false);
	});

	it("the first unit opens a passage, the next on the same route joins it, the way back is another", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		const c = soldier(s.world, 102, [260, 170]);
		init(s);

		assert.equal(s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160)), true);
		assert.equal(s.transports.requireTransport(s.world.gameState, b.ent, WEST, ISLAND, worldPos(290, 160)), true);
		assert.equal(s.transports.requireTransport(s.world.gameState, c.ent, ISLAND, WEST, worldPos(100, 160)), true);

		assert.equal(s.transports.plans.length, 2);
		assert.equal(s.transports.plans[0].units.length, 2);
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
				{
					s.transports.requireTransport(s.world.gameState, u.ent, WEST, ISLAND, worldPos(280, 160));
				}
				// close it to newcomers while the other one opens
				setSail(requireValue(s.transports.plans.at(-1)));
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
			for (const p of s.transports.plans)
			{
				backToBoarding(p);
			}

			s.transports.requireTransport(s.world.gameState, newcomer.ent, WEST, ISLAND, worldPos(280, 160));

			assert.equal(
				newcomer.ent.getMetadata(PlayerID, "transport"),
				lone.ent.getMetadata(PlayerID, "transport"),
				smallFirst ? "the small passage opened first" : "the small passage opened second",
			);
		}
	});

	it("a passage already at sea takes no one more", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		init(s);
		s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		setSail(s.transports.plans[0]);

		s.transports.requireTransport(s.world.gameState, b.ent, WEST, ISLAND, worldPos(280, 160));

		assert.equal(s.transports.plans.length, 2);
	});

	it("a passage with four siege engines takes no fifth", () =>
	{
		const s = seat();
		const rams = [0, 1, 2, 3, 4].map((k) =>
			soldier(s.world, 110 + k, [140, 150 + k * 4], {}, {
				hasClasses: (list: string[]) => list.includes("Siege"),
			})
		);
		init(s);

		for (const ram of rams)
		{
			s.transports.requireTransport(s.world.gameState, ram.ent, WEST, ISLAND, worldPos(280, 160));
		}

		assert.equal(s.transports.plans.length, 2);
		assert.equal(s.transports.plans[0].units.length, 4);
	});

	it("a route with no sea between the lands gets no passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		init(s);

		assert.equal(
			s.transports.requireTransport(s.world.gameState, a.ent, WEST, landRegion(7), worldPos(280, 160)),
			false,
		);
		assert.equal(s.transports.plans.length, 0);
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});

	it("a split with no unit left to move makes no new passage", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		init(s);
		s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.transports.plans[0];
		a.ent.setMetadata(PlayerID, "onBoard", entityId(202));
		assert.equal(s.transports.splitTransport(s.world.gameState, p, [a.ent]), false);
		assert.equal(s.transports.plans.length, 1);
	});
});

describe("a ship that starts the game with units aboard: createTransportIfNeeded", () =>
{
	/** a ship at sea with two soldiers aboard */
	function loaded(s: ReturnType<typeof seat>, id = 200, metadata: Record<string, unknown> = {})
	{
		const carrier = ship(s.world, id, [200, 160], { metadata });
		for (const k of [0, 1])
		{
			board(soldier(s.world, id * 10 + k, undefined), carrier);
		}
		return carrier;
	}

	it("carries its units to the land of the first building, from the sea where it waits", () =>
	{
		const s = seat();
		const carrier = loaded(s);
		ship(s.world, 201, [200, 200]); // an empty ship has nothing to carry
		init(s);

		s.transports.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(280, 160), ISLAND);

		assert.equal(s.transports.plans.length, 1);
		const p = s.transports.plans[0];
		assert.equal(p.startIndex, 1, "from aboard");
		assert.equal(p.endIndex, ISLAND);
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), p.ID);
		assert.equal(p.units.length, 2);
	});

	it("does nothing for a ship already carrying for a plan, from land, or towards no land", () =>
	{
		const s = seat();
		loaded(s, 200, { transporter: 99 });
		loaded(s, 201);
		init(s);

		s.transports.createTransportIfNeeded(s.world.gameState, worldPos(140, 160), worldPos(280, 160), ISLAND);
		// (the first building's caller always knows its land: ConstructionPlan.start sets it)
		s.transports.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(200, 160), landRegion(1));
		assert.equal(s.transports.plans.length, 0);

		s.transports.createTransportIfNeeded(s.world.gameState, worldPos(200, 160), worldPos(280, 160), ISLAND);
		assert.equal(s.transports.plans.length, 1, "only the free ship");
	});
});

describe("free ships and boarding ships: assignShipsToPlans and isShipBoarding", () =>
{
	it("hands free ships to the passages waiting for one", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		init(s);
		s.transports.requireTransport(
			s.world.gameState,
			soldier(s.world, 100, [140, 160]).ent,
			WEST,
			ISLAND,
			worldPos(280, 160),
		);

		s.transports.assignShipsToPlans(s.world.gameState);

		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), s.transports.plans[0].ID);
	});

	it("a ship of a passage is boarding once at its landing spot, not before", () =>
	{
		const s = seat();
		const { carrier, p } = boarding(s);
		assert.equal(s.transports.isShipBoarding(carrier.ent), false, "still at sea");

		carrier.state.pos = p.shipPoints()[200];
		assert.equal(s.transports.isShipBoarding(carrier.ent), true);

		carrier.state.pos = undefined;
		assert.equal(s.transports.isShipBoarding(carrier.ent), false, "a ship with no position is not boarding");
	});

	it("a ship of no passage is not boarding", () =>
	{
		const s = seat();
		const free = ship(s.world, 200, [200, 160]);
		init(s);
		assert.equal(s.transports.isShipBoarding(free.ent), false);
	});
});

describe("a passage whose ship sinks: checkShipsLost, through the fleet's events", () =>
{
	const events = (extra: Record<string, unknown[]>) => (eventsWith({ ...extra }));

	it("a passage whose ship sank at sea leaves the units still aboard another of its ships alone", () =>
	{
		const s = seat();
		ship(s.world, 200, [200, 160]);
		const aboard = soldier(s.world, 100, [140, 160]);
		init(s);
		s.transports.requireTransport(s.world.gameState, aboard.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.transports.plans[0];
		setSail(p);
		aboard.state.pos = undefined; // aboard the plan's other ship
		s.world.removeEntity(200);

		s.naval.checkEvents(
			s.world.gameState,
			queues(s.world),
			events({ Destroy: [{ entity: 200, metadata: { [PlayerID]: { transporter: p.ID } } }] }),
		);

		assert.equal(aboard.ent.getMetadata(PlayerID, "transport"), p.ID);
	});

	it("a passage whose ship sank while boarding waits for another ship", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		init(s);
		s.transports.requireTransport(s.world.gameState, a.ent, WEST, ISLAND, worldPos(280, 160));
		const p = s.transports.plans[0];
		s.transports.assignShipsToPlans(s.world.gameState);
		p.update(s.world.gameState);
		s.world.removeEntity(200);

		s.naval.checkEvents(
			s.world.gameState,
			queues(s.world),
			events({ Destroy: [{ entity: 200, metadata: { [PlayerID]: { transporter: p.ID } } }] }),
		);

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
		{
			s.transports.requireTransport(s.world.gameState, u.ent, WEST, ISLAND, worldPos(280, 160));
		}
		const p = s.transports.plans[0];
		setSail(p);
		b.state.pos = [250, 160]; // already landed on the island
		s.world.removeEntity(200);

		s.naval.checkEvents(
			s.world.gameState,
			queues(s.world),
			events({ Destroy: [{ entity: 200, metadata: { [PlayerID]: { transporter: p.ID } } }, { entity: 999 }] }),
		);

		assert.notEqual(a.ent.getMetadata(PlayerID, "transport"), p.ID);
		assert.equal(s.transports.plans.length, 2, "a new passage for the one still on our land");
		assert.equal(b.ent.getMetadata(PlayerID, "transport"), undefined, "the one at its goal needs none");
	});
});
