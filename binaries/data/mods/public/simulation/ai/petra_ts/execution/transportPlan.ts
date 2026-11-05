import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { transportPlanId, worldPos } from "../adapter/brands.ts";
import { debugShade } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, getSeaAccess, requireValue } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { stateIs, unitState } from "../adapter/unitState.ts";
import { seaRoute, shootersOf, threatsAlong, threatsAt, type Shooter } from "../world/seaRoute.ts";
import { hqOf } from "./hq.ts";
import { Worker } from "./worker.ts";

/** The ships we have on one sea, by kind (a transport may be a warship too) */
export type SeaFleet = {
	ships: CommonEntityCollection;
	transports: CommonEntityCollection;
	warShips: CommonEntityCollection;
	fishers: CommonEntityCollection;
};

/**
 * Describes a transport plan
 * Constructor assign units (units is an ID array), a destination (position).
 * The naval manager will try to deal with it accordingly.
 *
 * By this I mean that the naval manager will find how to go from access point 1 to access point 2
 * and then carry units from there.
 *
 * Note: only assign it units currently over land, or it won't work.
 * Also: destination should probably be land, otherwise the units will be lost at sea.
 *
 * metadata for units:
 *   transport = this.ID
 *   onBoard = ship.id() when affected to a ship but not yet garrisoned
 *           = "onBoard" when garrisoned in a ship
 *           = undefined otherwise
 *   endPos  = position of destination
 *
 *   metadata for ships
 *   transporter = this.ID
 */

/** The naval manager's ships, from which a plan picks its own by their metadata */
type TransportFleet = {
	ships: CommonEntityCollection;
	transportShips: CommonEntityCollection;
	fleet(sea: number): SeaFleet | undefined;
};

interface SerializedTransportPlan
{
	ID: TransportPlanId;
	flotilla: boolean;
	endPos: CommonPosition;
	endIndex: AccessIndex;
	startIndex: AccessIndex;
	sea: SeaIndex;
	state: string;
	boardingPos: Record<string, CommonPosition | undefined>;
	needTransportShips: boolean;
	nTry: Record<number, number>;
	canceled: boolean | undefined;
	unloaded: EntityId[];
	recovered: Array<{ entId: EntityId; entPos: CommonPosition; shipId: EntityId; }>;
}

/** A transport's way: from a land to another, to a position there */
type TransportRoute = { startIndex: AccessIndex; endIndex: AccessIndex; endPos: CommonPosition; };

/** The ship a unit was sent to (its onBoard metadata holds the ship id until on board) */
function shipOf(gameState: CommonGameState, ent: CommonEntity): CommonEntity | undefined
{
	const onBoard = ent.getMetadata(PlayerID, "onBoard");
	return onBoard === "onBoard" ? undefined : gameState.getEntityById(onBoard);
}

/** A unit no longer belongs to a transport: it leaves its attack and defense army too */
export function resetUnit(gameState: CommonGameState, ent: CommonEntity): void
{
	ent.setMetadata(PlayerID, "transport", undefined);
	ent.setMetadata(PlayerID, "onBoard", undefined);
	ent.setMetadata(PlayerID, "endPos", undefined);
	// if from an army or attack, remove it
	const plan = ent.getMetadata(PlayerID, "plan");
	if (plan !== undefined && plan >= 0)
	{
		const attackPlan = hqOf(gameState).attackManager.getPlan(plan);
		if (attackPlan)
		{
			attackPlan.removeUnit(ent, true);
		}
	}
	const partOfArmy = ent.getMetadata(PlayerID, "PartOfArmy");
	if (partOfArmy)
	{
		const army = hqOf(gameState).defenseManager.getArmy(partOfArmy);
		if (army)
		{
			army.removeOwn(gameState, ent.id());
		}
	}
}

/** A unit not on the map after its unloading: still on its ship, or lost and destroyed */
function onUnloadFailed(gameState: CommonGameState, ent: CommonEntity): void
{
	const ship = shipOf(gameState, ent);
	if (ship && ship.garrisoned().indexOf(ent.id()) !== -1)
	{
		ent.setMetadata(PlayerID, "onBoard", "onBoard");
		return;
	}
	if (ship)
	{
		aiWarn("Petra transportPlan problem: unit not on ship without position ???");
	}
	else
	{
		aiWarn("Petra transportPlan problem: unit on ship, but no ship ???");
	}
	resetUnit(gameState, ent);
	ent.destroy();
}

/** What a new transport plan is: its id, its way and sea, and the ship already holding its units, if any */
type TransportCrossing = TransportRoute & { id: TransportPlanId; sea: SeaIndex; ship?: CommonEntity; };

/** A land's shore on a sea */
type Shore = { land: AccessIndex; sea: SeaIndex; };

/** The boarding turn's time and the boarding stage */
type BoardingTurn = { time: GameSeconds; boarding: Boarding; };

/**
 * A unit landed makes some room for other units, walking on towards its destination
 * (a unit without a destination steps aside, FINDINGS §32: as the original;
 * the port's requireMetadata threw, ending the unloading for the turn)
 */
function stepAsideLanded(ent: CommonPlacedEntity): void
{
	const pos = ent.position();
	const goal = ent.getMetadata(PlayerID, "endPos");
	const dist = goal ? VectorDistance(pos, goal) : 0;
	if (goal && dist > 30)
	{
		ent.moveToRange(goal[0], goal[1], dist - 25, dist - 20);
	}
	else
	{
		ent.moveToRange(pos[0], pos[1], 20, 25);
	}
	ent.setMetadata(PlayerID, "transport", undefined);
	ent.setMetadata(PlayerID, "onBoard", undefined);
	ent.setMetadata(PlayerID, "endPos", undefined);
}

/**
 * Seconds since a unit or ship was last sent to board (its timeGarrison), NaN
 * when it never was, so that no "more than" test holds (FINDINGS §33: as the
 * original's arithmetic on undefined; the port's requireMetadata threw).
 */
function since(ent: CommonEntity, time: GameSeconds): number
{
	const sent = ent.getMetadata(PlayerID, "timeGarrison");
	return sent === undefined ? NaN : time - sent;
}

/** Seconds a ship sailing to its boarding point must stand still, neither moving nor turning, to be sent again (onBoarding). */
export const SHIP_STUCK = 5;
/** Seconds between two checks of the sailing ships' routes against the threats (checkRoutes). */
const ROUTE_CHECK = 3;
/** The fewest seconds between two re-routings of a ship (checkRoutes). */
export const ROUTE_RESEND_MIN = 15;
/** What a threat in reach of a landing point adds to its distance: a kilometre's detour. */
const LANDING_THREAT_COST = 1000;

/** A ship's point, by ship id: where it boards, or where it lands */
type ShipPoints = Record<string, CommonPosition | undefined>;
/** Boarding: each ship's boarding point, the tries of ships and units to meet, the units waiting for another plan */
type Boarding = {
	state: "boarding";
	boardingPos: ShipPoints;
	nTry: Record<number, number>;
	needSplit: CommonEntity[];
};
/** Sailing: each ship's landing point, the tries to land, the units unloaded last turn and those sent back on board */
type Sailing = {
	state: "sailing";
	landingPos: ShipPoints;
	nTry: Record<number, number>;
	unloaded: EntityId[];
	recovered: Array<{ entId: EntityId; entPos: CommonPosition; shipId: EntityId; }>;
	canceled: boolean | undefined;
};
/** A transport plan's state and what each state holds (PLAN.md §3.1) */
type TransportStage = Boarding | Sailing;

export class TransportPlan
{
	ID: TransportPlanId;
	/** The ships on the plan's sea */
	seaFleet: SeaFleet;
	/** The plan's state and what it holds: boarding, then sailing (onBoarding moves it on) */
	stage: TransportStage;
	get state(): TransportStage["state"]
	{
		return this.stage.state;
	}
	boardingRange = 18 * 18; // TODO compute it from the ship clearance and garrison range
	debug: number;
	endIndex: AccessIndex;
	endPos: CommonPosition;
	flotilla: boolean;
	needTransportShips: boolean;
	/**
	 * Each sailing ship's route to its landing point and how many threats
	 * reached it when planned (FINDINGS §36). Not saved: after a load a ship
	 * sails on unchecked until it is sent again.
	 */
	routes: Record<number, { waypoints: CommonPosition[]; threats: number; sent: number; }> = {};
	/** Game seconds of the last check of the routes. */
	lastRouteCheck = 0;
	sea: SeaIndex;
	ships: CommonEntityCollection;
	startIndex: AccessIndex;
	transportShips: CommonEntityCollection;
	units: CommonEntityCollection;

	/**
	 * The sea a transport crosses: a garrisoned ship's own (from the sea,
	 * index 1), or the sea between the two lands; undefined when there is
	 * none (land-sea-land only, for the moment).
	 */
	static findSea(
		gameState: CommonGameState,
		startIndex: AccessIndex,
		endIndex: AccessIndex,
		ship?: CommonEntity,
	): SeaIndex | undefined
	{
		if (startIndex === 1)
		{
			// our ships always have their sea set (see NavalManager init and checkEvents)
			return ship && getSeaAccess(gameState, ship);
		}
		const sea = hqOf(gameState).getSeaBetweenIndices(gameState, startIndex, endIndex);
		if (!sea)
		{
			debugWarn(
				gameState.ai.Config,
				1,
				() => "transport plan with bad path: startIndex " + startIndex + " endIndex " + endIndex,
			);
			return undefined;
		}
		return sea;
	}

	/**
	 * A new transport, or undefined when there is no sea to cross (findSea) or
	 * no fleet on it (a sea too small to sail); the plan's ID is used up either way.
	 */
	static create(
		gameState: CommonGameState,
		units: CommonEntity[],
		route: TransportRoute,
		ship?: CommonEntity,
	): TransportPlan | undefined
	{
		const id = transportPlanId(gameState.ai.uniqueIDs.transports++);
		const { startIndex, endIndex, endPos } = route;
		const sea = TransportPlan.findSea(gameState, startIndex, endIndex, ship);
		const fleet = hqOf(gameState).navalManager;
		const seaFleet = sea === undefined ? undefined : fleet.fleet(sea);
		return sea === undefined || !seaFleet ?
			undefined :
			new TransportPlan(gameState, { fleet, seaFleet }, { id, startIndex, endIndex, endPos, sea, ship }, units);
	}

	/** Each ship's point in this state: where it takes its units on board, then where it lands them */
	shipPoints(): Record<string, CommonPosition | undefined>
	{
		return this.stage.state === TransportPlan.BOARDING ? this.stage.boardingPos : this.stage.landingPos;
	}

	/** A saved transport, as it was saved: its units and ships found again by their metadata; none when its sea has no fleet. */
	static restore(
		gameState: CommonGameState,
		fleet: TransportFleet,
		data: SerializedTransportPlan,
	): TransportPlan | undefined
	{
		const seaFleet = fleet.fleet(data.sea);
		if (!seaFleet)
		{
			return undefined;
		}
		const plan = new TransportPlan(gameState, { fleet, seaFleet }, {
			id: data.ID,
			startIndex: data.startIndex,
			endIndex: data.endIndex,
			endPos: data.endPos,
			sea: data.sea,
		}, []);
		plan.resume(data);
		return plan;
	}

	constructor(
		gameState: CommonGameState,
		fleets: { fleet: TransportFleet; seaFleet: SeaFleet; },
		crossing: TransportCrossing,
		units: CommonEntity[],
	)
	{
		const { fleet, seaFleet } = fleets;
		const { id, startIndex, endIndex, endPos, sea, ship } = crossing;
		this.ID = id;
		this.seaFleet = seaFleet;
		this.debug = gameState.ai.Config.debug;
		this.flotilla = false; // when false, only one ship per transport ... not yet tested when true

		this.endPos = endPos;
		this.endIndex = endIndex;
		this.startIndex = startIndex;
		this.sea = sea;
		// special transport from an already garrisoned ship
		if (startIndex === 1 && ship)
		{
			ship.setMetadata(PlayerID, "transporter", this.ID);
			ship.setStance("none");
			for (const ent of units)
			{
				ent.setMetadata(PlayerID, "onBoard", "onBoard");
			}
		}

		for (const ent of units)
		{
			ent.setMetadata(PlayerID, "transport", this.ID);
			ent.setMetadata(PlayerID, "endPos", endPos);
		}

		debugWarn(
			this,
			1,
			() =>
				"Starting a new transport plan with ID " + this.ID + " to index " + endIndex +
				" with units length " + units.length,
		);

		this.stage = { state: TransportPlan.BOARDING, boardingPos: {}, nTry: {}, needSplit: [] };
		this.needTransportShips = ship === undefined;

		this.units = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "transport", this.ID));
		this.ships = fleet.ships.filter(filters.byMetadata(PlayerID, "transporter", this.ID));
		this.transportShips = fleet.transportShips.filter(filters.byMetadata(PlayerID, "transporter", this.ID));

		this.units.registerUpdates();
		this.ships.registerUpdates();
		this.transportShips.registerUpdates();
	}

	/**
	 * We're trying to board units onto our ships.
	 */
	static readonly BOARDING = "boarding";
	/**
	 * We're moving ships and eventually unload units.
	 */
	static readonly SAILING = "sailing";

	/** count available slots. TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	countFreeSlots(): number
	{
		let slots = 0;
		for (const ship of this.transportShips.values())
		{
			slots += this.countFreeSlotsOnShip(ship);
		}
		return slots;
	}

	countFreeSlotsOnShip(ship: CommonEntity): number
	{
		if (ship.hitpoints() < ship.garrisonEjectHealth() * ship.maxHitpoints())
		{
			return 0;
		}
		const occupied = ship.garrisoned().length +
			this.units.filter(filters.byMetadata(PlayerID, "onBoard", ship.id())).length;
		return Math.max(ship.garrisonMax() - occupied, 0);
	}

	/** returns the ship the unit is sent to, if any has room */
	assignUnitToShip(gameState: CommonGameState, ent: CommonEntity, boarding: Boarding): CommonEntity | undefined
	{
		if (this.needTransportShips)
		{
			return undefined;
		}

		for (const ship of this.transportShips.values())
		{
			if (this.countFreeSlotsOnShip(ship) === 0)
			{
				continue;
			}
			ent.setMetadata(PlayerID, "onBoard", ship.id());
			if (this.debug > 1)
			{
				if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_ATTACK)
				{
					debugShade([ent.id()], [2, 0, 0]);
				}
				else
				{
					debugShade([ent.id()], [0, 2, 0]);
				}
			}
			return ship;
		}

		if (this.flotilla)
		{
			this.needTransportShips = true;
			return undefined;
		}

		boarding.needSplit.push(ent);
		return undefined;
	}

	assignShip(gameState: CommonGameState): boolean
	{
		let pos: CommonPosition | undefined;
		// choose a unit of this plan not yet assigned to a ship
		for (const ent of this.units.values())
		{
			if (!isPlaced(ent) || ent.getMetadata(PlayerID, "onBoard") !== undefined)
			{
				continue;
			}
			pos = ent.position();
			break;
		}
		// and choose the nearest available ship from this unit
		let distmin = Math.min();
		let nearest: CommonEntity | undefined;
		this.seaFleet.transports.forEach((ship) =>
		{
			if (ship.getMetadata(PlayerID, "transporter") || !isPlaced(ship))
			{
				return;
			}
			if (pos)
			{
				const dist = SquareVectorDistance(pos, ship.position());
				if (dist > distmin)
				{
					return;
				}
				distmin = dist;
				nearest = ship;
			}
			else if (!nearest)
			{
				nearest = ship;
			}
		});
		if (!nearest)
		{
			return false;
		}

		nearest.setMetadata(PlayerID, "transporter", this.ID);
		nearest.setStance("none");
		this.ships.updateEnt(nearest);
		this.transportShips.updateEnt(nearest);
		this.needTransportShips = false;
		return true;
	}

	/** Where a unit of the plan goes: its own destination, else the plan's (FINDINGS §32: a unit without one) */
	destinationOf(ent: CommonEntity): CommonPosition
	{
		return ent.getMetadata(PlayerID, "endPos") ?? this.endPos;
	}

	/** add a unit to this plan */
	addUnit(unit: CommonEntity, endPos: CommonPosition): void
	{
		unit.setMetadata(PlayerID, "transport", this.ID);
		unit.setMetadata(PlayerID, "endPos", endPos);
		this.units.updateEnt(unit);
	}

	/** remove a unit from this plan, if not yet on board */
	removeUnit(gameState: CommonGameState, unit: CommonEntity): void
	{
		const shipId = unit.getMetadata(PlayerID, "onBoard");
		if (shipId === "onBoard")
		{
			return; // too late, already onBoard
		}
		else if (shipId !== undefined)
		{
			unit.stopMoving(); // cancel the garrison order
		}
		unit.setMetadata(PlayerID, "transport", undefined);
		unit.setMetadata(PlayerID, "endPos", undefined);
		this.units.updateEnt(unit);
		if (shipId)
		{
			unit.setMetadata(PlayerID, "onBoard", undefined);
			const ship = gameState.getEntityById(shipId);
			if (
				ship && !ship.garrisoned().length &&
				!this.units.filter(filters.byMetadata(PlayerID, "onBoard", shipId)).length
			)
			{
				this.releaseShip(ship);
				this.ships.updateEnt(ship);
				this.transportShips.updateEnt(ship);
			}
		}
	}

	releaseShip(ship: CommonEntity): void
	{
		if (ship.getMetadata(PlayerID, "transporter") !== this.ID)
		{
			aiWarn(
				" Petra: try removing a transporter ship with " +
					ship.getMetadata(PlayerID, "transporter") + " from " + this.ID + " and stance " +
					ship.getStance(),
			);
			return;
		}

		const defaultStance = ship.get("UnitAI/DefaultStance");
		if (defaultStance)
		{
			ship.setStance(defaultStance);
		}

		ship.setMetadata(PlayerID, "transporter", undefined);
		delete this.routes[ship.id()];
		if (ship.getMetadata(PlayerID, "role") === Worker.ROLE_SWITCH_TO_TRADER)
		{
			ship.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
		}
	}

	releaseAll(): void
	{
		for (const ship of this.ships.values())
		{
			this.releaseShip(ship);
		}

		for (const ent of this.units.values())
		{
			ent.setMetadata(PlayerID, "endPos", undefined);
			ent.setMetadata(PlayerID, "onBoard", undefined);
			ent.setMetadata(PlayerID, "transport", undefined);
			// TODO if the index of the endPos of the entity is !=,
			// require again another transport (we could need land-sea-land-sea-land)
		}

		this.transportShips.unregister();
		this.ships.unregister();
		this.units.unregister();
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used (to be fixed first) */
	cancelTransport(gameState: CommonGameState): boolean
	{
		const ent = this.units.toEntityArray()[0];
		const baseID = ent.getMetadata(PlayerID, "base");
		let base = baseID === undefined ? undefined : hqOf(gameState).getBaseByID(baseID);
		if (!base || !base.anchor || !isPlaced(base.anchor))
		{
			for (const newbase of hqOf(gameState).baseManagers())
			{
				if (!newbase.anchor || !isPlaced(newbase.anchor))
				{
					continue;
				}
				ent.setMetadata(PlayerID, "base", newbase.ID);
				base = newbase;
				break;
			}
			if (!base || !base.anchor || !isPlaced(base.anchor))
			{
				return false;
			}
			const baseForUnits = base;
			this.units.forEach((unit) =>
			{
				unit.setMetadata(PlayerID, "base", baseForUnits.ID);
			});
		}
		this.endIndex = this.startIndex;
		if (base && base.anchor)
		{
			const anchorPos = base.anchor.position();
			if (anchorPos)
			{
				this.endPos = anchorPos;
			}
		}
		// (sailing: a plan cancelled while boarding sails nowhere yet)
		if (this.stage.state === TransportPlan.SAILING)
		{
			this.stage.canceled = true;
		}
		return true;
	}

	/**
	 * Try to move on and then clear the plan.
	 */
	update(gameState: CommonGameState): number
	{
		const stage = this.stage;
		if (stage.state === TransportPlan.BOARDING)
		{
			this.onBoarding(gameState, stage);
		}
		else
		{
			this.onSailing(gameState, stage);
		}

		return this.units.length;
	}

	onBoarding(gameState: CommonGameState, boarding: Boarding): void
	{
		let ready = true;
		const time = gameState.ai.elapsedTime;
		const shipTested: Record<number, boolean> = {};

		for (const ent of this.units.values())
		{
			const onBoard = ent.getMetadata(PlayerID, "onBoard");
			if (!onBoard)
			{
				ready = false;
				this.sendToShip(gameState, ent, time, boarding);
			}
			else if (onBoard !== "onBoard" && !this.isOnBoard(ent))
			{
				ready = false;
				const shipId = onBoard;
				const ship = gameState.getEntityById(shipId);
				if (!ship)
				{ // the ship must have been destroyed
					ent.setMetadata(PlayerID, "onBoard", undefined);
					continue;
				}
				// a ship sails: never off the map
				if (!isPlaced(ship))
				{
					continue;
				}
				// set when the first unit was sent to this ship; a ship without one
				// (FINDINGS §32: the original threw too, ending the boarding for the
				// turn) is not tested for having drifted from it
				const boardingPos = boarding.boardingPos[shipId];
				const distShip = boardingPos ? SquareVectorDistance(boardingPos, ship.position()) : 0;
				if (boardingPos && !shipTested[shipId] && distShip > this.boardingRange)
				{
					shipTested[shipId] = true;
					this.checkBoardingShip(gameState, ent, ship, boardingPos, { time, boarding });
				}

				if (since(ent, time) > 2)
				{
					this.checkBoardingUnit(gameState, ent, ship, { boardingPos, distShip }, { time, boarding });
				}
			}
		}

		if (boarding.needSplit.length)
		{
			hqOf(gameState).navalManager.splitTransport(gameState, this, boarding.needSplit);
			boarding.needSplit = [];
		}

		if (!ready)
		{
			return;
		}

		// the landing points, over the record of the boarding points (a ship no longer in the plan keeps its old one)
		const landingPos = boarding.boardingPos;
		const shooters = shootersOf(gameState);
		for (const ship of this.ships.values())
		{
			const bp = this.getBoardingPos(gameState, ship, this.landingShore(), this.endPos, true);
			landingPos[ship.id()] = bp;
			this.sailTo(gameState, ship, bp, shooters);
		}
		this.stage = {
			state: TransportPlan.SAILING,
			landingPos,
			nTry: {},
			unloaded: [],
			recovered: [],
			canceled: undefined,
		};
	}

	/** A unit not yet on a ship: give it one, sent to a boarding point near the unit if it has none */
	sendToShip(gameState: CommonGameState, ent: CommonEntity, time: GameSeconds, boarding: Boarding): void
	{
		const ship = this.assignUnitToShip(gameState, ent, boarding);
		if (ship)
		{
			const shipId = ship.id();
			// a ship goes to a boarding point near the unit; one inside a building
			// leaves that to the next unit on the map (the original threw)
			const entPos = ent.position();
			if (!boarding.boardingPos[shipId] && entPos)
			{
				const bp = this.getBoardingPos(
					gameState,
					ship,
					{ land: this.startIndex, sea: this.sea },
					entPos,
					false,
				);
				boarding.boardingPos[shipId] = bp;
				this.sailTo(gameState, ship, bp);
				ship.setMetadata(PlayerID, "timeGarrison", time);
				ship.setMetadata(PlayerID, "posGarrison", ship.position());
				ship.setMetadata(PlayerID, "previousAngle", ship.angle());
			}
			ent.garrison(ship);
			ent.setMetadata(PlayerID, "timeGarrison", time);
			ent.setMetadata(PlayerID, "posGarrison", ent.position());
		}
	}

	/** Where the units land: the destination's land on the plan's sea */
	landingShore(): Shore
	{
		return { land: this.endIndex, sea: this.sea };
	}

	/** A ship far from its boarding point while a unit waits for it: is it stuck? Then send it again, or to another point */
	checkBoardingShip(
		gameState: CommonGameState,
		ent: CommonEntity,
		ship: CommonPlacedEntity,
		boardingPos: CommonPosition,
		turn: BoardingTurn,
	): void
	{
		const shipId = ship.id();
		const { time, boarding } = turn;
		let retry = false;
		const state = unitState(ship);
		if (stateIs(state, "INDIVIDUAL.WALKING") || stateIs(state, "INDIVIDUAL.PICKUP.APPROACHING"))
		{
			// stuck if the ship itself neither moved nor turned for 5 s: Petra
			// looked at the unit, which waits on the shore for its ship, and sent
			// a ship sailing round the enemy's shooters again every 2 s (FINDINGS
			// §41); judged by its position alone, a ship turning in place to set
			// out was sent again as it turned (§45)
			if (since(ship, time) > SHIP_STUCK)
			{
				const oldPos = ship.getMetadata(PlayerID, "posGarrison");
				const newPos = ship.position();
				const angle = ship.angle();
				if (
					oldPos && newPos && oldPos[0] === newPos[0] && oldPos[1] === newPos[1] &&
					ship.getMetadata(PlayerID, "previousAngle") === angle
				)
				{
					retry = true;
				}
				ship.setMetadata(PlayerID, "posGarrison", newPos);
				ship.setMetadata(PlayerID, "previousAngle", angle);
				ship.setMetadata(PlayerID, "timeGarrison", time);
			}
		}
		else if (!stateIs(state, "INDIVIDUAL.PICKUP.LOADING") && since(ship, time) > 5 || since(ship, time) > 8)
		{
			retry = true;
			ent.setMetadata(PlayerID, "timeGarrison", time);
		}

		if (retry)
		{
			if (!boarding.nTry[shipId])
			{
				boarding.nTry[shipId] = 1;
			}
			else
			{
				++boarding.nTry[shipId];
			}
			let bp = boardingPos;
			if (boarding.nTry[shipId] > 1)
			{ // we must have been blocked by something ... try with another boarding point
				boarding.nTry[shipId] = 0;
				debugWarn(this, 1, () => "ship " + shipId + " new attempt for a landing point ");
				bp = this.retryBoardingPos(gameState, ship, boardingPos, this.startIndex, false);
				boarding.boardingPos[shipId] = bp;
			}
			this.sailTo(gameState, ship, bp);
			ship.setMetadata(PlayerID, "timeGarrison", time);
		}
	}

	/** A unit that has not moved for 2 s on its way to its ship: get it out of a trap, or nearer the boarding point */
	checkBoardingUnit(
		gameState: CommonGameState,
		ent: CommonEntity,
		ship: CommonEntity,
		shipAt: { boardingPos: CommonPosition | undefined; distShip: number; },
		turn: BoardingTurn,
	): void
	{
		const { boardingPos, distShip } = shipAt;
		const { time, boarding } = turn;
		// a unit without a position has just gone in (the original threw too)
		const oldPos = ent.getMetadata(PlayerID, "posGarrison");
		const newPos = ent.position();
		if (oldPos && newPos && oldPos[0] === newPos[0] && oldPos[1] === newPos[1])
		{
			// (a ship without a boarding point is no distance from it)
			if (!boardingPos || distShip < this.boardingRange)
			{ // looks like we are blocked ... try to go out of this trap
				if (!boarding.nTry[ent.id()])
				{
					boarding.nTry[ent.id()] = 1;
				}
				else
				{
					++boarding.nTry[ent.id()];
				}
				if (boarding.nTry[ent.id()] > 5)
				{
					debugWarn(this, 1, () => "unit blocked, but no ways out of the trap ... " + "destroy it");
					resetUnit(gameState, ent);
					ent.destroy();
					return;
				}
				if (boarding.nTry[ent.id()] > 1)
				{
					ent.moveToRange(newPos[0], newPos[1], 30, 35);
				}
				ent.garrison(ship, true);
			}
			else
			{
				if (SquareVectorDistance(boardingPos, newPos) > 225)
				{
					ent.moveToRange(boardingPos[0], boardingPos[1], 0, 15);
				}
			}
		}
		else
		{
			boarding.nTry[ent.id()] = 0;
		}
		ent.setMetadata(PlayerID, "timeGarrison", time);
		ent.setMetadata(PlayerID, "posGarrison", ent.position());
	}

	/** tell if a unit is garrisoned in one of the ships of this plan, and update its metadata if yes */
	isOnBoard(ent: CommonEntity): boolean
	{
		for (const ship of this.transportShips.values())
		{
			if (ship.garrisoned().indexOf(ent.id()) === -1)
			{
				continue;
			}
			ent.setMetadata(PlayerID, "onBoard", "onBoard");
			return true;
		}
		return false;
	}

	/**
	 * Another landing point for a ship blocked on its way to `current` (its
	 * plan's land and sea): the nearest to the ship, or `current` when none is.
	 */
	retryBoardingPos(
		gameState: CommonGameState,
		ship: CommonEntity,
		current: CommonPosition,
		landIndex: AccessIndex,
		avoidEnnemy: boolean,
	): CommonPosition
	{
		return this.getBoardingPos(gameState, ship, { land: landIndex, sea: this.sea }, undefined, avoidEnnemy) ??
			current;
	}

	/**
	 * The landing point nearest the destination on that land and sea; when
	 * avoidEnnemy is true, we try to not board/unboard in ennemy territory.
	 * With a destination there always is one (the destination itself when no
	 * landing zone is better); without one, the ship's present boarding point
	 * when nothing is found.
	 */
	getBoardingPos(
		gameState: CommonGameState,
		ship: CommonEntity,
		shore: Shore,
		destination: CommonPosition,
		avoidEnnemy?: boolean,
	): CommonPosition;
	getBoardingPos(
		gameState: CommonGameState,
		ship: CommonEntity,
		shore: Shore,
		destination?: CommonPosition,
		avoidEnnemy?: boolean,
	): CommonPosition | undefined;
	getBoardingPos(
		gameState: CommonGameState,
		ship: CommonEntity,
		shore: Shore,
		destination?: CommonPosition,
		avoidEnnemy: boolean = false,
	): CommonPosition | undefined
	{
		const landIndex = shore.land;
		const seaIndex = shore.sea;
		if (!hqOf(gameState).navalManager.landingZones[landIndex])
		{
			aiWarn(" >>> no landing zone for land " + landIndex);
			return destination;
		}
		else if (!hqOf(gameState).navalManager.landingZones[landIndex][seaIndex])
		{
			aiWarn(" >>> no landing zone for land " + landIndex + " and sea " + seaIndex);
			return destination;
		}

		const startPos = ship.position();
		// a ship off the map (never: ships are not garrisoned) has no landing nearer than the destination
		if (!startPos)
		{
			return destination;
		}
		let distmin = Math.min();
		let posmin = destination;
		const width = gameState.getPassabilityMap().width;
		const cell = gameState.getPassabilityMap().cellSize;
		const alliedDocks = gameState.getAllyStructures().filter(
			filters.and(filters.byClass("Dock"), filters.byMetadata(PlayerID, "sea", seaIndex)),
		).toEntityArray();
		const shooters = avoidEnnemy ? shootersOf(gameState) : [];
		const leg = { startPos, destination, shooters: avoidEnnemy ? shooters : undefined, alliedDocks };
		for (const i of hqOf(gameState).navalManager.landingZones[landIndex][seaIndex])
		{
			let pos: CommonPosition = worldPos(i % width + 0.5, Math.floor(i / width) + 0.5);
			pos = worldPos(cell * pos[0], cell * pos[1]);
			const dist = this.landingCost(gameState, pos, leg);
			if (dist > distmin)
			{
				continue;
			}
			distmin = dist;
			posmin = pos;
		}
		// none found and no destination: the caller keeps the ship's present point (retryBoardingPos)
		return posmin;
	}

	/**
	 * What landing at pos costs: the way there and on to the destination, with penalties for enemy territory and
	 * threats (when shooters are given), for the other ships' points and for our allied docks.
	 */
	private landingCost(
		gameState: CommonGameState,
		pos: CommonPosition,
		leg: {
			startPos: CommonPosition;
			destination: CommonPosition | undefined;
			shooters: Parameters<typeof threatsAt>[1] | undefined;
			alliedDocks: CommonPlacedEntity[];
		},
	): number
	{
		let dist = VectorDistance(leg.startPos, pos);
		if (leg.destination)
		{
			dist += VectorDistance(pos, leg.destination);
		}
		if (leg.shooters)
		{
			const territoryOwner = hqOf(gameState).geography.territoryMap.getOwner(pos);
			if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
			{
				dist += 100000000;
			}
			// and away from the enemy's soldiers and towers there (FINDINGS §36)
			dist += LANDING_THREAT_COST * threatsAt(pos, leg.shooters);
		}
		// require a small distance between all ships of the transport plan to avoid path finder problems
		// this is also used when the ship is blocked and we want to find a new boarding point
		const points = this.shipPoints();
		for (const shipId in points)
		{
			const point = points[shipId];
			if (point !== undefined && SquareVectorDistance(point, pos) < this.boardingRange)
			{
				dist += 1000000;
			}
		}
		// and not too near our allied docks to not disturb naval traffic
		for (const dock of leg.alliedDocks)
		{
			const distSquare = dock.foundationProgress() !== undefined ? 900 : 4900;
			const dockDist = SquareVectorDistance(dock.position(), pos);
			if (dockDist < distSquare)
			{
				dist += 100000 * (distSquare - dockDist) / distSquare;
			}
		}
		return dist;
	}

	onSailing(gameState: CommonGameState, sailing: Sailing): void
	{
		this.checkRoutes(gameState);

		this.checkRecovered(gameState, sailing);
		this.checkUnloaded(gameState, sailing);

		if (sailing.canceled)
		{
			for (const ship of this.ships.values())
			{
				const boardingPos = this.getBoardingPos(gameState, ship, this.landingShore(), this.endPos, true);
				sailing.landingPos[ship.id()] = boardingPos;
				this.sailTo(gameState, ship, boardingPos);
			}
			sailing.canceled = undefined;
		}

		for (const ship of this.transportShips.values())
		{
			this.landShip(gameState, ship, sailing);
		}
	}

	/** Units unloaded on a wrong region last turn and sent back on board: are they on board again? */
	checkRecovered(gameState: CommonGameState, sailing: Sailing): void
	{
		// Check that the units recovered on the previous turn have been reloaded
		for (const recov of sailing.recovered)
		{
			const ent = gameState.getEntityById(recov.entId);
			if (!ent)
			{ // entity destroyed
				continue;
			}
			if (!isPlaced(ent))
			{ // reloading succeeded ... move a bit the ship before trying again
				const ship = gameState.getEntityById(recov.shipId);
				if (ship)
				{
					ship.moveApart(recov.entPos, 15);
				}
				continue;
			}
			debugWarn(this, 1, () => ">>> transport " + this.ID + " reloading failed ... <<<");
			// destroy the unit if inaccessible otherwise leave it there
			const index = getLandAccess(gameState, ent);
			if (hqOf(gameState).geography.landRegions[index])
			{
				debugWarn(this, 1, () => " recovered entity kept " + ent.id());
				resetUnit(gameState, ent);
				// Cancel its garrison order, so it is not reloaded on the next turn without a plan
				ent.stopMoving();
			}
			else
			{
				debugWarn(this, 1, () => "recovered entity destroyed " + ent.id());
				resetUnit(gameState, ent);
				ent.destroy();
			}
		}
		sailing.recovered = [];
	}

	checkUnloaded(gameState: CommonGameState, sailing: Sailing): void
	{
		// Check that the units unloaded on the previous turn have been really unloaded and in the right position
		const shipsToMove: Record<number, CommonEntity> = {};
		for (const entId of sailing.unloaded)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent)
			{ // entity destroyed
				continue;
			}
			else if (!isPlaced(ent))
			{ // unloading failed
				onUnloadFailed(gameState, ent);
			}
			else if (getLandAccess(gameState, ent) !== this.endIndex)
			{
				// unit unloaded on a wrong region - try to regarrison it and move a bit the ship
				debugWarn(this, 1, () => ">>> unit unloaded on a wrong region ! try to garrison it again <<<");
				const ship = shipOf(gameState, ent);
				if (ship && !sailing.canceled)
				{
					shipsToMove[ship.id()] = ship;
					sailing.recovered.push({ entId: ent.id(), entPos: ent.position(), shipId: ship.id() });
					ent.garrison(ship);
					ent.setMetadata(PlayerID, "onBoard", "onBoard");
				}
				else
				{
					debugWarn(this, 1, () => "no way ... we destroy it");
					resetUnit(gameState, ent);
					ent.destroy();
				}
			}
			else
			{
				stepAsideLanded(ent);
			}
		}
		for (const shipId in shipsToMove)
		{
			const boardingPos = this.getBoardingPos(
				gameState,
				shipsToMove[shipId],
				this.landingShore(),
				this.endPos,
				true,
			);
			sailing.landingPos[shipId] = boardingPos;
			this.sailTo(gameState, shipsToMove[shipId], boardingPos);
		}
		sailing.unloaded = [];
	}

	/** A stopped ship of the plan: unload it at its landing point, release it empty, or send it again */
	landShip(gameState: CommonGameState, ship: CommonEntity, sailing: Sailing): void
	{
		// only a ship that has stopped: Petra took any ship not WALKING, one
		// between two of its route's waypoints too, and sent it again by a new
		// route every turn, a new landing point every third (FINDINGS §41)
		if (!ship.isIdle() || !isPlaced(ship))
		{
			return;
		}
		const shipId = ship.id();
		// set for every ship of the plan when it set sail; a ship that joined since has none yet
		const bp = sailing.landingPos[shipId] ??
			this.getBoardingPos(gameState, ship, this.landingShore(), this.endPos, true);
		sailing.landingPos[shipId] = bp;
		const dist = SquareVectorDistance(ship.position(), bp);
		let remaining = 0;
		for (const entId of ship.garrisoned())
		{
			const ent = requireValue(gameState.getEntityById(entId));
			if (!ent.getMetadata(PlayerID, "transport"))
			{
				continue;
			}
			remaining++;
			if (dist < 625)
			{
				ship.unload(entId);
				sailing.unloaded.push(entId);
				ent.setMetadata(PlayerID, "onBoard", shipId);
			}
		}

		let recovering = 0;
		for (const recov of sailing.recovered)
		{
			if (recov.shipId === shipId)
			{
				recovering++;
			}
		}

		if (!remaining && !recovering)
		{ // when empty, release the ship and move apart to leave room for other ships. TODO fight
			ship.moveApart(bp, 30);
			this.releaseShip(ship);
			return;
		}
		if (dist > this.boardingRange)
		{
			if (!sailing.nTry[shipId])
			{
				sailing.nTry[shipId] = 1;
			}
			else
			{
				++sailing.nTry[shipId];
			}
			let newBp = bp;
			if (sailing.nTry[shipId] > 2)
			{ // we must have been blocked by something ... try with another boarding point
				sailing.nTry[shipId] = 0;
				debugWarn(this, 1, () => shipId + " new attempt for a landing point ");
				newBp = this.retryBoardingPos(gameState, ship, bp, this.endIndex, true);
				sailing.landingPos[shipId] = newBp;
			}
			this.sailTo(gameState, ship, newBp);
		}
	}

	/**
	 * Sends a ship to its landing point by a route round the enemy shooters it
	 * can avoid (world/seaRoute.ts), one move and the rest queued; straight
	 * there when no route is found.
	 */
	sailTo(
		gameState: CommonGameState,
		ship: CommonEntity,
		destination: CommonPosition,
		shooters: readonly Shooter[] = shootersOf(gameState),
		planned?: CommonPosition[],
	): void
	{
		const from = ship.position();
		const route = planned ?? (from && seaRoute(gameState.ai.accessibility, this.sea, from, destination, shooters));
		if (!from || !route)
		{
			delete this.routes[ship.id()];
			ship.move(destination[0], destination[1]);
			return;
		}
		this.routes[ship.id()] = {
			waypoints: route,
			threats: threatsAlong(from, route, shooters),
			sent: gameState.ai.elapsedTime,
		};
		ship.move(route[0][0], route[0][1]);
		for (const waypoint of route.slice(1))
		{
			ship.move(waypoint[0], waypoint[1], true);
		}
	}

	/**
	 * Every ROUTE_CHECK seconds, each sailing ship's way ahead (from its
	 * nearest waypoint on) against the threats now: more of them within reach
	 * than when it was planned (archers or soldiers come to the shore, a
	 * warship), and the ship is sent again by a new route from where it is.
	 * As many or fewer, and the route stands: a landing point under fire
	 * cannot be avoided, and sending again for it would only repeat orders.
	 */
	checkRoutes(gameState: CommonGameState): void
	{
		const now = gameState.ai.elapsedTime;
		if (now - this.lastRouteCheck < ROUTE_CHECK)
		{
			return;
		}
		this.lastRouteCheck = now;
		let shooters: Shooter[] | undefined;
		for (const ship of this.transportShips.values())
		{
			const route = this.routes[ship.id()];
			const pos = ship.position();
			if (!route || !pos)
			{
				continue;
			}
			let nearest = 0;
			for (let i = 1; i < route.waypoints.length; ++i)
			{
				if (SquareVectorDistance(pos, route.waypoints[i]) < SquareVectorDistance(pos, route.waypoints[nearest]))
				{
					nearest = i;
				}
			}
			const ahead = route.waypoints.slice(nearest);
			shooters ??= shootersOf(gameState);
			const threats = threatsAlong(pos, ahead, shooters);
			// sent again only by a route with fewer threats than the way ahead, and
			// not twice within ROUTE_RESEND_MIN: re-sent at every check as enemies
			// moved, by routes no safer that began from where the ship stood, ships
			// turned back and forth (a 4-player match: a median 3.2 s between two
			// sends of a ship, one sent 543 times; FINDINGS §41)
			if (threats > route.threats && now - route.sent >= ROUTE_RESEND_MIN)
			{
				const destination = requireValue(ahead.at(-1));
				const better = seaRoute(gameState.ai.accessibility, this.sea, pos, destination, shooters);
				if (better && threatsAlong(pos, better, shooters) < threats)
				{
					this.sailTo(gameState, ship, destination, shooters, better);
					continue;
				}
			}
			route.threats = threats;
		}
	}

	Serialize(): SerializedTransportPlan
	{
		return {
			ID: this.ID,
			flotilla: this.flotilla,
			endPos: this.endPos,
			endIndex: this.endIndex,
			startIndex: this.startIndex,
			sea: this.sea,
			state: this.state,
			boardingPos: this.shipPoints(),
			needTransportShips: this.needTransportShips,
			nTry: this.stage.nTry,
			canceled: this.stage.state === TransportPlan.SAILING ? this.stage.canceled : undefined,
			unloaded: this.stage.state === TransportPlan.SAILING ? this.stage.unloaded : [],
			recovered: this.stage.state === TransportPlan.SAILING ? this.stage.recovered : [],
		};
	}

	/** A restored plan takes up where its save left it. */
	private resume(data: SerializedTransportPlan): void
	{
		this.flotilla = data.flotilla;
		this.needTransportShips = data.needTransportShips;
		this.stage = data.state === TransportPlan.SAILING ?
			{
				state: TransportPlan.SAILING,
				landingPos: data.boardingPos,
				nTry: data.nTry,
				unloaded: data.unloaded,
				recovered: data.recovered,
				canceled: data.canceled,
			} :
			{ state: TransportPlan.BOARDING, boardingPos: data.boardingPos, nTry: data.nTry, needSplit: [] };
	}
}
