/**
 * TransportPlan: a few units of ours carried across the sea, from the land
 * they stand on to a spot on another land. The suites seat a real office and
 * its real naval manager on the naval board (see tests/harness/navalWorld.ts),
 * and play the engine's part by hand: when a ship is told to move, the suite
 * decides whether it arrives; when a soldier is told to board, the suite puts
 * it aboard.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { override } from "./harness/fakes.ts";
import { ENEMY, makeHqEntity, PLAYER } from "./harness/hqWorld.ts";
import { board, disembark, ISLAND, navalWorld, SEA, ship, soldier, WEST } from "./harness/navalWorld.ts";

import { landRegion, seaRegion, seconds, worldPos } from "../adapter/brands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import { TransportPlan } from "../execution/transportPlan.ts";

const PlayerID = PLAYER;

/** the naval board with its naval manager initialised, as the opening strategy does */
function seat()
{
	const s = navalWorld();
	return s;
}

function initNaval(s: ReturnType<typeof seat>): void
{
	s.hq.navalManager.init(s.world.gameState);
}

/** a plan, initialised and handed to the naval manager, as requireTransport makes one */
function plan(s: ReturnType<typeof seat>, units: CommonEntity[], end = worldPos(280, 160), start: AccessIndex = WEST, endIndex: AccessIndex = ISLAND): TransportPlan
{
	const p = TransportPlan.create(s.world.gameState, units, start, endIndex, end);
	assert.ok(p, "a sea to cross");
	p.init(s.world.gameState);
	s.hq.navalManager.transportPlans.push(p);
	return p;
}

describe("a transport plan made: the sea between the two lands", () =>
{
	it("a plan across the sea takes the sea between the lands and books its units", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);

		const p = plan(s, [a.ent]);

		assert.equal(p.sea, SEA);
		assert.equal(p.state, TransportPlan.BOARDING);
		assert.equal(p.needTransportShips, true, "no ship yet");
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), p.ID);
		assert.deepEqual(a.ent.getMetadata(PlayerID, "endPos"), [280, 160]);
		assert.equal(p.units.length, 1);
	});

	it("a plan between lands with no sea between them fails and books nobody", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);

		const ids = s.world.gameState.ai.uniqueIDs.transports;
		const p = TransportPlan.create(s.world.gameState, [a.ent], WEST, landRegion(7), worldPos(280, 160));

		assert.equal(p, undefined, "no sea between the lands: no plan");
		assert.equal(s.world.gameState.ai.uniqueIDs.transports, ids + 1, "its ID is used up all the same, as before");
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});

	it("a ship that starts the game with units aboard carries them on its own sea", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 200, [200, 160]);
		const a = soldier(s.world, 100, undefined);
		board(a, carrier);
		initNaval(s);

		const p = TransportPlan.create(s.world.gameState, [a.ent], landRegion(1), ISLAND, worldPos(280, 160), carrier.ent);

		assert.ok(p);
		assert.equal(p.sea, SEA, "the ship's sea, set when the fleet was counted");
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), p.ID);
		assert.equal(carrier.state.stance, "none", "a transport does not stop to fight");
		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), "onBoard");
		assert.equal(p.needTransportShips, false);
	});
});

describe("a transport plan finding its ship: assignShip", () =>
{
	it("takes the free ship nearest its waiting units, on its own sea", () =>
	{
		const s = seat();
		const far = ship(s.world, 201, [200, 300]);
		const near = ship(s.world, 202, [180, 150]);
		const farther = ship(s.world, 204, [220, 150]);
		const busy = ship(s.world, 203, [165, 160], { "metadata": { "transporter": 99 } });
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		assert.equal(p.assignShip(s.world.gameState), true);

		assert.equal(near.ent.getMetadata(PlayerID, "transporter"), p.ID);
		assert.equal(far.ent.getMetadata(PlayerID, "transporter"), undefined);
		assert.equal(farther.ent.getMetadata(PlayerID, "transporter"), undefined);
		assert.equal(busy.ent.getMetadata(PlayerID, "transporter"), 99, "another plan's ship is left to it");
		assert.equal(near.state.stance, "none");
		assert.equal(p.needTransportShips, false);
		assert.equal(p.transportShips.length, 1);
	});

	it("after its ship sank, chooses the next ship near the units still waiting, not those aboard another", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 40], { "onBoard": 207 });	// heading for the plan's other ship
		const b = soldier(s.world, 101, [140, 280]);
		const south = ship(s.world, 205, [180, 40]);
		const north = ship(s.world, 206, [180, 280]);
		initNaval(s);
		const p = plan(s, [a.ent, b.ent]);

		p.assignShip(s.world.gameState);

		assert.equal(north.ent.getMetadata(PlayerID, "transporter"), p.ID);
		assert.equal(south.ent.getMetadata(PlayerID, "transporter"), undefined);
	});

	it("finds nothing when every ship on its sea serves another plan", () =>
	{
		const s = seat();
		ship(s.world, 203, [165, 160], { "metadata": { "transporter": 99 } });
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		assert.equal(p.assignShip(s.world.gameState), false);
		assert.equal(p.needTransportShips, true);
	});
});

describe("a transport plan boarding its units: update", () =>
{
	it("sends the ship to the shore by the units, and the units aboard", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 202, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);
		p.assignShip(s.world.gameState);

		assert.equal(p.update(s.world.gameState), 1, "one unit still in the plan");

		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), 202, "the unit is told which ship to board");
		assert.deepEqual(a.state.garrisons, [[202, undefined]]);
		assert.equal(carrier.state.moves.length, 1, "the ship heads for the shore");
		const [x] = carrier.state.moves[0];
		assert.ok(x >= 152 && x < 160, `to a landing spot on our coast, got ${carrier.state.moves[0]}`);
		assert.equal(p.state, TransportPlan.BOARDING);
	});

	it("sets sail for the far shore once every unit is aboard", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 202, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);
		p.assignShip(s.world.gameState);
		p.update(s.world.gameState);
		board(a, carrier);

		p.update(s.world.gameState);

		assert.equal(p.state, TransportPlan.SAILING);
		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), "onBoard");
		const [x] = carrier.state.moves[carrier.state.moves.length - 1];
		assert.ok(x >= 240 && x < 248, `to a landing spot on the island, got ${carrier.state.moves.at(-1)}`);
	});
});

/** a plan of one ship and the given units, its ship assigned */
function shipped(s: ReturnType<typeof seat>, units: Array<ReturnType<typeof soldier>>, capacity = 20)
{
	const carrier = ship(s.world, 202, [200, 160], { capacity });
	initNaval(s);
	const p = plan(s, units.map((u) => u.ent));
	p.assignShip(s.world.gameState);
	return { carrier, p };
}

describe("a transport plan counting room aboard", () =>
{
	it("counts the room left once those aboard and those on their way are taken", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a], 3);
		carrier.state.garrisoned.push(999);	// someone already aboard
		p.update(s.world.gameState);	// a is sent to it

		assert.equal(p.countFreeSlotsOnShip(carrier.ent), 1);
		assert.equal(p.countFreeSlots(), 1);
	});

	it("counts no room on a ship too damaged to carry anyone", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		carrier.ent.hitpoints = () => 50;

		assert.equal(p.countFreeSlotsOnShip(carrier.ent), 0, "below the eject health");
	});

	it("puts aside the units its ship has no room for, and the fleet carries them in a second plan", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const b = soldier(s.world, 101, [140, 170]);
		const { p } = shipped(s, [a, b], 1);

		p.update(s.world.gameState);

		const plans = s.hq.navalManager.transportPlans;
		assert.equal(plans.length, 2);
		const [first, second] = [a, b].map((u) => u.ent.getMetadata(PlayerID, "transport"));
		assert.equal(first, p.ID);
		assert.equal(second, plans[1].ID, "the unit with no room goes to the new plan");
		assert.equal(plans[1].endIndex, ISLAND);
		assert.equal(p.units.length, 1);
	});

	it("tells no unit where to board while it has no ship", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		p.assignUnitToShip(s.world.gameState, a.ent);
		p.update(s.world.gameState);

		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), undefined);
		assert.equal(s.hq.navalManager.transportPlans.length, 1, "no unit is put aside for a second plan");
	});
});

describe("a transport plan letting units and ships go", () =>
{
	it("a unit taken off before boarding stops, leaves the plan, and frees the ship it was heading for", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);

		p.removeUnit(s.world.gameState, a.ent);

		assert.equal(a.state.stops, 1, "the garrison order is cancelled");
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), undefined);
		assert.equal(p.units.length, 0);
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), undefined, "nobody heads for the ship any more");
		assert.equal(carrier.state.stance, "aggressive", "back to its usual stance");
	});

	it("a unit already aboard stays in the plan", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		board(a, carrier);
		p.update(s.world.gameState);

		p.removeUnit(s.world.gameState, a.ent);

		assert.equal(a.ent.getMetadata(PlayerID, "transport"), p.ID);
	});

	it("a unit taken off before it was given a ship just leaves", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		p.removeUnit(s.world.gameState, a.ent);

		assert.equal(a.state.stops, 0);
		assert.equal(p.units.length, 0);
	});

	it("releasing everything frees the ships, restores a trader-to-be, and clears every unit's booking", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		carrier.ent.setMetadata(PlayerID, "role", "switchToTrader");
		p.update(s.world.gameState);

		p.releaseAll();

		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), undefined);
		assert.equal(carrier.ent.getMetadata(PlayerID, "role"), "trader", "the merchant ship goes back to trade");
		for (const key of ["transport", "onBoard", "endPos"])
			assert.equal(a.ent.getMetadata(PlayerID, key), undefined, key);
	});

	it("leaves alone a ship another plan holds", () =>
	{
		const s = seat();
		const other = ship(s.world, 205, [200, 200], { "metadata": { "transporter": 99 } });
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		p.releaseShip(other.ent);

		assert.equal(other.ent.getMetadata(PlayerID, "transporter"), 99);
	});

	it("a unit lost on the way leaves any attack and army it served", () =>
	{
		const s = seat();
		const left: string[] = [];
		override(s.hq.attackManager, { "getPlan": (id: number) =>
			id === 4 ? { "removeUnit": () => left.push("attack") } : undefined });
		override(s.hq.defenseManager, { "getArmy": (id: number) =>
			id === 6 ? { "removeOwn": () => left.push("army") } : undefined });
		const a = soldier(s.world, 100, [140, 160], { "plan": 4, "PartOfArmy": 6 });
		initNaval(s);
		const p = plan(s, [a.ent]);

		p.resetUnit(s.world.gameState, a.ent);

		assert.deepEqual(left, ["attack", "army"]);
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});
});

describe("a transport plan when boarding goes wrong", () =>
{
	it("a unit whose ship sank before it boarded waits for another ship", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { p } = shipped(s, [a]);
		p.update(s.world.gameState);
		s.world.removeEntity(202);

		p.update(s.world.gameState);

		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), undefined);
	});

	// only the port passes: the original's distance to an unset boarding point threw, every turn
	it("a unit heading for a ship without a boarding point keeps heading for it", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { p } = shipped(s, [a]);
		p.update(s.world.gameState);
		delete p.boardingPos[202];

		p.update(s.world.gameState);

		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), 202, "still bound for its ship");
		assert.equal(p.state, TransportPlan.BOARDING);
	});

	it("a ship that makes no headway to the shore is sent again, then to another landing spot", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		const first = carrier.state.moves[0];
		carrier.state.aiState = "INDIVIDUAL.WALKING";

		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3);
		p.update(s.world.gameState);
		assert.deepEqual(carrier.state.moves.at(-1), first, "first retry: the same spot");
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3);
		p.update(s.world.gameState);

		assert.equal(carrier.state.moves.length, 3);
		assert.notDeepEqual(carrier.state.moves.at(-1), first, "second retry: another spot");
	});

	it("a ship stopped short of the shore for a while is sent again", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		carrier.state.aiState = "INDIVIDUAL.IDLE";

		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 6);
		p.update(s.world.gameState);

		assert.equal(carrier.state.moves.length, 2);
	});

	it("a unit stuck beside its ship tries again, steps aside, and is given up after five tries", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [150, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		carrier.state.pos = p.boardingPos[202];	// the ship is at the shore

		for (let turn = 1; turn <= 6; ++turn)
		{
			s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3);
			p.update(s.world.gameState);
		}

		assert.ok(a.state.garrisons.some(([, queued]) => queued === true), "the garrison order is given again");
		assert.ok(a.state.ranges.some(([, , min, max]) => min === 30 && max === 35), "it steps aside first");
		assert.equal(a.state.destroyed, true);
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});

	it("a unit still walking to the shore is left to walk", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [60, 160]);
		const { p } = shipped(s, [a]);
		p.update(s.world.gameState);

		a.state.pos = [100, 160];
		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3);
		p.update(s.world.gameState);

		assert.deepEqual(a.state.ranges, []);
	});

	it("a unit standing still far from the landing spot is walked to it", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [60, 160]);
		const { p } = shipped(s, [a]);
		p.update(s.world.gameState);

		s.world.ai.elapsedTime = seconds(s.world.ai.elapsedTime + 3);
		p.update(s.world.gameState);

		const bp = p.boardingPos[202] as [number, number];
		assert.deepEqual(a.state.ranges.at(-1), [bp[0], bp[1], 0, 15]);
	});
});

describe("a transport plan at sea: unloading on the far shore", () =>
{
	/** a plan at sea with its one unit aboard, the ship arrived at the island's landing spot */
	function arrived(s: ReturnType<typeof seat>)
	{
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		board(a, carrier);
		p.update(s.world.gameState);
		carrier.state.pos = p.boardingPos[202];
		return { a, carrier, p };
	}

	it("unloads at the landing spot, sends the units on, and frees the empty ship", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);

		p.update(s.world.gameState);
		assert.deepEqual(carrier.state.unloaded, [100]);
		disembark(a, carrier, [250, 160]);

		assert.equal(p.update(s.world.gameState), 0, "nobody left to carry");

		assert.deepEqual(a.state.ranges.at(-1), [250, 160, 20, 25], "it makes room for the next ones");
		for (const key of ["transport", "onBoard", "endPos"])
			assert.equal(a.ent.getMetadata(PlayerID, key), undefined, key);
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), undefined);
		assert.equal(carrier.state.moveApart.length, 1, "the ship clears the landing spot");
	});

	it("a unit landed short of its goal walks the rest of the way", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [250, 160]);
		a.ent.setMetadata(PlayerID, "endPos", worldPos(300, 160));

		p.update(s.world.gameState);

		assert.deepEqual(a.state.ranges.at(-1), [300, 160, 25, 30]);
	});

	it("a unit landed without a destination steps aside, and the landing goes on", () =>
	{
		// island games logged this 72-295 times a game (FINDINGS §32): the port's
		// requireMetadata threw where the original stepped aside
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [250, 160]);
		a.ent.setMetadata(PlayerID, "endPos", undefined);

		assert.equal(p.update(s.world.gameState), 0, "nobody left to carry");

		assert.deepEqual(a.state.ranges.at(-1), [250, 160, 20, 25], "it makes room where it stands");
		assert.equal(a.ent.getMetadata(PlayerID, "transport"), undefined);
	});

	it("a unit put ashore on the wrong land is taken back aboard, and the ship tries another spot", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);	// our own coast
		const target = p.boardingPos[202];

		p.update(s.world.gameState);

		assert.deepEqual(a.state.garrisons.at(-1), [202, undefined]);
		assert.equal(a.ent.getMetadata(PlayerID, "onBoard"), "onBoard");
		assert.notDeepEqual(p.boardingPos[202], target, "another landing spot");
		assert.deepEqual(carrier.state.moves.at(-1), p.boardingPos[202]);
	});

	it("a unit taken back aboard makes the ship move off a little before trying again", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);
		p.update(s.world.gameState);
		board(a, carrier);

		p.update(s.world.gameState);

		assert.deepEqual(carrier.state.moveApart.at(-1), [150, 160]);
	});

	// only the port passes: the original destroys the unit wherever it stands
	// (its comment says it would leave it on a land we use, but a TODO notes
	// the pending garrison order could still reload it). The port leaves it
	// there and cancels that order
	it("a unit that could not be taken back aboard is left on a land we use, its boarding cancelled", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);
		p.update(s.world.gameState);
		const stops = a.state.stops;

		p.update(s.world.gameState);	// still ashore on our own land

		assert.equal(a.state.destroyed, false);
		assert.equal(a.state.stops, stops + 1, "the garrison order to the ship is cancelled");
		for (const key of ["transport", "onBoard", "endPos"])
			assert.equal(a.ent.getMetadata(PlayerID, key), undefined, key);
		assert.equal(p.units.length, 0, "it is out of the plan, which is done");
	});

	it("a unit that could not be taken back aboard on a land we do not use is given up", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);
		p.update(s.world.gameState);
		s.hq.landRegions = { [ISLAND]: true };	// our land is no longer one the office counts on

		p.update(s.world.gameState);

		assert.equal(a.state.destroyed, true);
	});

	it("a unit killed while being taken back aboard is forgotten", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);
		p.update(s.world.gameState);
		s.world.removeEntity(100);

		assert.doesNotThrow(() => p.update(s.world.gameState));
		assert.equal(a.state.destroyed, false, "nothing left to destroy");
	});

	it("a unit killed just after landing is forgotten", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		// ashore, and killed before the next turn (aboard it could not be attacked)
		disembark(a, carrier, [250, 160]);
		s.world.removeEntity(100);

		assert.equal(p.update(s.world.gameState), 0);
		assert.equal(carrier.ent.getMetadata(PlayerID, "transporter"), undefined, "the empty ship is freed");
	});

	it("a unit whose ship sank while unloading it is given up", () =>
	{
		const s = seat();
		const { a, p } = arrived(s);
		p.update(s.world.gameState);
		s.world.removeEntity(202);

		p.update(s.world.gameState);

		assert.equal(a.state.destroyed, true);
	});

	it("a unit put ashore on the wrong land after its ship sank is given up", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		disembark(a, carrier, [150, 160]);
		s.world.removeEntity(202);

		p.update(s.world.gameState);

		assert.equal(a.state.destroyed, true);
	});

	it("a ship still under way is left to sail", () =>
	{
		const s = seat();
		const { carrier, p } = arrived(s);
		carrier.state.aiState = "INDIVIDUAL.WALKING";

		p.update(s.world.gameState);

		assert.deepEqual(carrier.state.unloaded, []);
	});

	it("a ship unloads only the plan's units, not others it carries", () =>
	{
		const s = seat();
		const { carrier, p } = arrived(s);
		const passenger = soldier(s.world, 150, undefined);
		board(passenger, carrier);

		p.update(s.world.gameState);

		assert.deepEqual(carrier.state.unloaded, [100]);
	});

	it("a unit the ship failed to unload stays aboard for the next try", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);	// unload ordered, but it never left the ship

		p.update(s.world.gameState);

		assert.deepEqual(carrier.state.unloaded, [100, 100], "the unload is ordered again");
		assert.equal(a.state.destroyed, false);
	});

	it("a unit neither ashore nor aboard is given up", () =>
	{
		const s = seat();
		const { a, carrier, p } = arrived(s);
		p.update(s.world.gameState);
		carrier.state.garrisoned = [];	// gone from the ship, yet nowhere on the map

		p.update(s.world.gameState);

		assert.equal(a.state.destroyed, true);
	});

	it("a ship that keeps failing to reach the far shore tries another landing spot", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		board(a, carrier);
		p.update(s.world.gameState);
		const target = p.boardingPos[202];
		carrier.state.pos = [200, 160];	// still mid-sea

		for (let turn = 0; turn < 3; ++turn)
			p.update(s.world.gameState);

		assert.notDeepEqual(p.boardingPos[202], target);
	});
});

describe("where a ship puts in: getBoardingPos", () =>
{
	it("with no landing spot known on that land, keeps to the given destination", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 202, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		initNaval(s);
		const p = plan(s, [a.ent]);

		assert.deepEqual(p.getBoardingPos(s.world.gameState, carrier.ent, landRegion(9), SEA, worldPos(10, 10)), [10, 10]);
		assert.deepEqual(p.getBoardingPos(s.world.gameState, carrier.ent, ISLAND, seaRegion(9), worldPos(10, 10)), [10, 10]);
	});

	it("lands units outside enemy territory when it can", () =>
	{
		const s = seat();
		// the enemy holds the island south of z = 200
		for (let ix = 28; ix < 40; ++ix)
			for (let iz = 0; iz < 25; ++iz)
				s.world.map.setTerritoryOwner(ix, iz, ENEMY);
		const carrier = ship(s.world, 202, [200, 100]);
		const a = soldier(s.world, 100, [140, 100]);
		initNaval(s);
		const p = plan(s, [a.ent], worldPos(280, 100));

		const bp = requireValue(p.getBoardingPos(s.world.gameState, carrier.ent, ISLAND, SEA, worldPos(280, 100), true));

		assert.ok(bp[1] >= 200, `north of the enemy's ground, got ${bp}`);
	});

	it("keeps clear of a dock of ours", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 202, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		s.world.addEntity(makeHqEntity({
			"id": 300, "owner": PLAYER, "position": [244, 160], "classes": ["Structure", "Dock"]
		}, {}, { "sea": SEA }));
		initNaval(s);
		const p = plan(s, [a.ent]);

		const bp = requireValue(p.getBoardingPos(s.world.gameState, carrier.ent, ISLAND, SEA, worldPos(244, 160)));

		assert.ok(Math.hypot(bp[0] - 244, bp[1] - 160) > 40, `away from the dock, got ${bp}`);
	});

	it("keeps a smaller berth from a dock still being built", () =>
	{
		const s = seat();
		const carrier = ship(s.world, 202, [200, 160]);
		const a = soldier(s.world, 100, [140, 160]);
		s.world.addEntity(makeHqEntity({
			"id": 300, "owner": PLAYER, "position": [244, 160], "classes": ["Structure", "Dock"]
		}, { "foundationProgress": () => 0.4 }, { "sea": SEA }));
		initNaval(s);
		const p = plan(s, [a.ent]);

		const bp = requireValue(p.getBoardingPos(s.world.gameState, carrier.ent, ISLAND, SEA, worldPos(244, 160)));
		const d = Math.hypot(bp[0] - 244, bp[1] - 160);

		assert.ok(d > 20 && d < 40, `30 m from a foundation rather than 70, got ${d}`);
	});
});

describe("a transport plan saved and loaded", () =>
{
	it("comes back with the same state", () =>
	{
		const s = seat();
		const a = soldier(s.world, 100, [140, 160]);
		const { carrier, p } = shipped(s, [a]);
		p.update(s.world.gameState);
		board(a, carrier);
		p.update(s.world.gameState);
		const saved = JSON.parse(JSON.stringify(p.Serialize()));

		const loaded = TransportPlan.restore(s.world.gameState, saved.startIndex, saved.endIndex, saved.endPos);
		loaded.Deserialize(saved);
		loaded.init(s.world.gameState);

		assert.deepEqual(JSON.parse(JSON.stringify(loaded.Serialize())), saved);
		assert.equal(loaded.units.length, 1, "it finds its unit again by its metadata");
	});
});
