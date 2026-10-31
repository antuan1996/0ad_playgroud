import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { getLandAccess, requireMetadata, requireValue } from "../adapter/entityExtend.ts";
import { Worker } from "./worker.ts";
import { seaRegion, transportPlanId, worldPos } from "../adapter/brands.ts";
import { isInState, stateIs, unitState } from "../adapter/unitState.ts";
import { debugShade } from "../adapter/commands.ts";
import { hqOf } from "./hq.ts";
import { debugWarn } from "../adapter/debug.ts";

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

export interface SerializedTransportPlan {
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
	recovered: Array<{ entId: EntityId; entPos: CommonPosition; shipId: EntityId }>;
}

export class TransportPlan
{
	ID: TransportPlanId;
	boardingPos: Record<string, CommonPosition | undefined>;
	declare boardingRange: number;
	declare canceled: boolean | undefined;
	debug: number;
	endIndex: AccessIndex;
	endPos: CommonPosition;
	flotilla: boolean;
	nTry: Record<number, number>;
	needSplit: CommonEntity[];
	needTransportShips: boolean;
	declare recovered: Array<{ entId: EntityId; entPos: CommonPosition; shipId: EntityId }>;
	sea: SeaIndex;
	declare ships: CommonEntityCollection;
	startIndex: AccessIndex;
	state: string;
	declare transportShips: CommonEntityCollection;
	declare units: CommonEntityCollection;
	declare unloaded: EntityId[];

	/**
	 * The sea a transport crosses: a garrisoned ship's own (from the sea,
	 * index 1), or the sea between the two lands; undefined when there is
	 * none (land-sea-land only, for the moment).
	 */
	static findSea(gameState: CommonGameState, startIndex: AccessIndex, endIndex: AccessIndex, ship?: CommonEntity): SeaIndex | undefined
	{
		if (startIndex === 1)
			// our ships always have their sea set (see NavalManager init and checkEvents)
			return ship && requireMetadata(ship, "sea");
		const sea = hqOf(gameState).getSeaBetweenIndices(gameState, startIndex, endIndex);
		if (!sea)
		{
			debugWarn(gameState.ai.Config, 1, () => "transport plan with bad path: startIndex " + startIndex + " endIndex " +
				endIndex);
			return undefined;
		}
		return sea;
	}

	/** A new transport, or undefined when there is no sea to cross (findSea); the plan's ID is used up either way. */
	static create(gameState: CommonGameState, units: CommonEntity[], startIndex: AccessIndex, endIndex: AccessIndex,
		endPos: CommonPosition, ship?: CommonEntity): TransportPlan | undefined
	{
		const id = transportPlanId(gameState.ai.uniqueIDs.transports++);
		const sea = TransportPlan.findSea(gameState, startIndex, endIndex, ship);
		return sea === undefined ? undefined : new TransportPlan(gameState, id, units, startIndex, endIndex, endPos, sea, ship);
	}

	/** A saved transport, before its Deserialize: made as a new one, the save's ID and sea replacing what it found. */
	static restore(gameState: CommonGameState, startIndex: AccessIndex, endIndex: AccessIndex, endPos: CommonPosition): TransportPlan
	{
		const id = transportPlanId(gameState.ai.uniqueIDs.transports++);
		const sea = TransportPlan.findSea(gameState, startIndex, endIndex);
		return new TransportPlan(gameState, id, [], startIndex, endIndex, endPos, sea ?? seaRegion(0));
	}

	constructor(gameState: CommonGameState, id: TransportPlanId, units: CommonEntity[], startIndex: AccessIndex, endIndex: AccessIndex,
		endPos: CommonPosition, sea: SeaIndex, ship?: CommonEntity)
	{
		this.ID = id;
		this.debug = gameState.ai.Config.debug;
		this.flotilla = false;   // when false, only one ship per transport ... not yet tested when true
		this.needSplit = [];

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
				ent.setMetadata(PlayerID, "onBoard", "onBoard");
		}

		for (const ent of units)
		{
			ent.setMetadata(PlayerID, "transport", this.ID);
			ent.setMetadata(PlayerID, "endPos", endPos);
		}

		debugWarn(this, 1, () => "Starting a new transport plan with ID " + this.ID + " to index " + endIndex +
			" with units length " + units.length);

		this.state = TransportPlan.BOARDING;
		this.boardingPos = {};
		this.needTransportShips = ship === undefined;
		this.nTry = {};
	}

	/**
	 * We're trying to board units onto our ships.
	 */
	static BOARDING = "boarding";
	/**
	 * We're moving ships and eventually unload units.
	 */
	static SAILING = "sailing";

	init(gameState: CommonGameState): void
	{
		this.units = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "transport", this.ID));
		this.ships = hqOf(gameState).navalManager.ships.filter(filters.byMetadata(PlayerID, "transporter",
			this.ID));
		this.transportShips = hqOf(gameState).navalManager.transportShips.filter(filters.byMetadata(PlayerID,
			"transporter", this.ID));

		this.units.registerUpdates();
		this.ships.registerUpdates();
		this.transportShips.registerUpdates();

		this.boardingRange = 18*18;	// TODO compute it from the ship clearance and garrison range
	}

	/** count available slots. TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	countFreeSlots(): number
	{
		let slots = 0;
		for (const ship of this.transportShips.values())
			slots += this.countFreeSlotsOnShip(ship);
		return slots;
	}

	countFreeSlotsOnShip(ship: CommonEntity): number
	{
		if (ship.hitpoints() < ship.garrisonEjectHealth() * ship.maxHitpoints())
			return 0;
		const occupied = ship.garrisoned().length +
			this.units.filter(filters.byMetadata(PlayerID, "onBoard", ship.id())).length;
		return Math.max(ship.garrisonMax() - occupied, 0);
	}

	/** returns the ship the unit is sent to, if any has room */
	assignUnitToShip(gameState: CommonGameState, ent: CommonEntity): CommonEntity | undefined
	{
		if (this.needTransportShips)
			return undefined;

		for (const ship of this.transportShips.values())
		{
			if (this.countFreeSlotsOnShip(ship) === 0)
				continue;
			ent.setMetadata(PlayerID, "onBoard", ship.id());
			if (this.debug > 1)
			{
				if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_ATTACK)
					debugShade([ent.id()], [2, 0, 0]);
				else
					debugShade([ent.id()], [0, 2, 0]);
			}
			return ship;
		}

		if (this.flotilla)
		{
			this.needTransportShips = true;
			return undefined;
		}

		this.needSplit.push(ent);
		return undefined;
	}

	assignShip(gameState: CommonGameState): boolean
	{
		let pos: CommonPosition | undefined;
		// choose a unit of this plan not yet assigned to a ship
		for (const ent of this.units.values())
		{
			if (!ent.position() || ent.getMetadata(PlayerID, "onBoard") !== undefined)
				continue;
			pos = ent.position();
			break;
		}
		// and choose the nearest available ship from this unit
		let distmin = Math.min();
		let nearest: CommonEntity | undefined;
		requireValue(hqOf(gameState).navalManager.seaTransportShips[this.sea]).forEach((ship) =>
		{
			if (ship.getMetadata(PlayerID, "transporter"))
				return;
			if (pos)
			{
				const dist = SquareVectorDistance(pos, ship.position());
				if (dist > distmin)
					return;
				distmin = dist;
				nearest = ship;
			}
			else if (!nearest)
				nearest = ship;
		});
		if (!nearest)
			return false;

		nearest.setMetadata(PlayerID, "transporter", this.ID);
		nearest.setStance("none");
		this.ships.updateEnt(nearest);
		this.transportShips.updateEnt(nearest);
		this.needTransportShips = false;
		return true;
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
			return;			// too late, already onBoard
		else if (shipId !== undefined)
			unit.stopMoving();	// cancel the garrison order
		unit.setMetadata(PlayerID, "transport", undefined);
		unit.setMetadata(PlayerID, "endPos", undefined);
		this.units.updateEnt(unit);
		if (shipId)
		{
			unit.setMetadata(PlayerID, "onBoard", undefined);
			const ship = gameState.getEntityById(shipId);
			if (ship && !ship.garrisoned().length &&
				!this.units.filter(filters.byMetadata(PlayerID, "onBoard", shipId)).length)
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
			aiWarn(" Petra: try removing a transporter ship with " +
				ship.getMetadata(PlayerID, "transporter") + " from " + this.ID + " and stance " +
				ship.getStance());
			return;
		}

		const defaultStance = ship.get("UnitAI/DefaultStance");
		if (defaultStance)
			ship.setStance(defaultStance);

		ship.setMetadata(PlayerID, "transporter", undefined);
		if (ship.getMetadata(PlayerID, "role") === Worker.ROLE_SWITCH_TO_TRADER)
			ship.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
	}

	releaseAll(): void
	{
		for (const ship of this.ships.values())
			this.releaseShip(ship);

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
		if (!base || !base.anchor || !base.anchor.position())
		{
			for (const newbase of hqOf(gameState).baseManagers())
			{
				if (!newbase.anchor || !newbase.anchor.position())
					continue;
				ent.setMetadata(PlayerID, "base", newbase.ID);
				base = newbase;
				break;
			}
			if (!base || !base.anchor || !base.anchor.position())
				return false;
			const baseForUnits = base;
			this.units.forEach((unit) => { unit.setMetadata(PlayerID, "base", baseForUnits.ID); });
		}
		this.endIndex = this.startIndex;
		if (base && base.anchor)
		{
			const anchorPos = base.anchor.position();
			if (anchorPos)
				this.endPos = anchorPos;
		}
		this.canceled = true;
		return true;
	}


	/**
	 * Try to move on and then clear the plan.
	 */
	update(gameState: CommonGameState): number
	{
		if (this.state === TransportPlan.BOARDING)
			this.onBoarding(gameState);
		else if (this.state === TransportPlan.SAILING)
			this.onSailing(gameState);

		return this.units.length;
	}

	onBoarding(gameState: CommonGameState): void
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
				const ship = this.assignUnitToShip(gameState, ent);
				if (ship)
				{
					const shipId = ship.id();
					if (!this.boardingPos[shipId])
					{
						// with the unit's position as destination, a boarding position is always found
						const bp = requireValue(this.getBoardingPos(gameState, ship, this.startIndex, this.sea, ent.position(), false));
						this.boardingPos[shipId] = bp;
						ship.move(bp[0], bp[1]);
						ship.setMetadata(PlayerID, "timeGarrison", time);
					}
					ent.garrison(ship);
					ent.setMetadata(PlayerID, "timeGarrison", time);
					ent.setMetadata(PlayerID, "posGarrison", ent.position());
				}
			}
			else if (onBoard !== "onBoard" && !this.isOnBoard(ent))
			{
				ready = false;
				const shipId = onBoard;
				const ship = gameState.getEntityById(shipId);
				if (!ship)    // the ship must have been destroyed
				{
					ent.setMetadata(PlayerID, "onBoard", undefined);
					continue;
				}
				// set when the first unit was sent to this ship; a ship without one
				// (FINDINGS §32: the original threw too, ending the boarding for the
				// turn) is not tested for having drifted from it
				const boardingPos = this.boardingPos[shipId];
				const distShip = boardingPos ? SquareVectorDistance(boardingPos, ship.position()) : 0;
				if (!shipTested[shipId] && distShip > this.boardingRange)
				{
					shipTested[shipId] = true;
					let retry = false;
					const state = unitState(ship);
					if (stateIs(state, "INDIVIDUAL.WALKING") ||
					    stateIs(state, "INDIVIDUAL.PICKUP.APPROACHING"))
					{
						if (time - requireMetadata(ship, "timeGarrison") > 2)
						{
							const oldPos = requireMetadata(ent, "posGarrison");
							const newPos = ent.position();
							if (oldPos[0] === newPos[0] && oldPos[1] === newPos[1])
								retry = true;
							ent.setMetadata(PlayerID, "posGarrison", newPos);
							ent.setMetadata(PlayerID, "timeGarrison", time);
						}
					}

					else if (!stateIs(state, "INDIVIDUAL.PICKUP.LOADING") &&
						   time - requireMetadata(ship, "timeGarrison") > 5 ||
						   time - requireMetadata(ship, "timeGarrison") > 8)
					{
						retry = true;
						ent.setMetadata(PlayerID, "timeGarrison", time);
					}

					if (retry)
					{
						if (!this.nTry[shipId])
							this.nTry[shipId] = 1;
						else
							++this.nTry[shipId];
						if (this.nTry[shipId] > 1)	// we must have been blocked by something ... try with another boarding point
						{
							this.nTry[shipId] = 0;
							debugWarn(this, 1, () => "ship " + shipId + " new attempt for a landing point ");
							this.boardingPos[shipId] = this.getBoardingPos(gameState, ship, this.startIndex, this.sea, undefined, false);
						}
						// a new search falls back to the previous boarding position
						const bp = requireValue(this.boardingPos[shipId]);
						ship.move(bp[0], bp[1]);
						ship.setMetadata(PlayerID, "timeGarrison", time);
					}
				}

				if (time - requireMetadata(ent, "timeGarrison") > 2)
				{
					const oldPos = requireMetadata(ent, "posGarrison");
					const newPos = ent.position();
					if (oldPos[0] === newPos[0] && oldPos[1] === newPos[1])
					{
						if (distShip < this.boardingRange)	// looks like we are blocked ... try to go out of this trap
						{
							if (!this.nTry[ent.id()])
								this.nTry[ent.id()] = 1;
							else
								++this.nTry[ent.id()];
							if (this.nTry[ent.id()] > 5)
							{
								debugWarn(this, 1, () => "unit blocked, but no ways out of the trap ... " +
									"destroy it");
								this.resetUnit(gameState, ent);
								ent.destroy();
								continue;
							}
							if (this.nTry[ent.id()] > 1)
								ent.moveToRange(newPos[0], newPos[1], 30, 35);
							ent.garrison(ship, true);
						}
						else
						{
							const bp = requireValue(this.boardingPos[shipId]);
							if (SquareVectorDistance(bp, newPos) > 225)
								ent.moveToRange(bp[0], bp[1], 0, 15);
						}
					}
					else
						this.nTry[ent.id()] = 0;
					ent.setMetadata(PlayerID, "timeGarrison", time);
					ent.setMetadata(PlayerID, "posGarrison", ent.position());
				}
			}
		}

		if (this.needSplit.length)
		{
			hqOf(gameState).navalManager.splitTransport(gameState, this);
			this.needSplit = [];
		}

		if (!ready)
			return;

		for (const ship of this.ships.values())
		{
			this.boardingPos[ship.id()] = undefined;
			// with the plan's end position as destination, a boarding position is always found
			const bp = requireValue(this.getBoardingPos(gameState, ship, this.endIndex, this.sea, this.endPos, true));
			this.boardingPos[ship.id()] = bp;
			ship.move(bp[0], bp[1]);
		}
		this.state = TransportPlan.SAILING;
		this.nTry = {};
		this.unloaded = [];
		this.recovered = [];
	}

	/** tell if a unit is garrisoned in one of the ships of this plan, and update its metadata if yes */
	isOnBoard(ent: CommonEntity): boolean
	{
		for (const ship of this.transportShips.values())
		{
			if (ship.garrisoned().indexOf(ent.id()) === -1)
				continue;
			ent.setMetadata(PlayerID, "onBoard", "onBoard");
			return true;
		}
		return false;
	}

	/** when avoidEnnemy is true, we try to not board/unboard in ennemy territory */
	getBoardingPos(gameState: CommonGameState, ship: CommonEntity, landIndex: AccessIndex, seaIndex: SeaIndex, destination?: CommonPosition, avoidEnnemy: boolean = false): CommonPosition | undefined
	{
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
		let distmin = Math.min();
		let posmin = destination;
		const width = gameState.getPassabilityMap().width;
		const cell = gameState.getPassabilityMap().cellSize;
		const alliedDocks = gameState.getAllyStructures().filter(filters.and(filters.byClass("Dock"),
			filters.byMetadata(PlayerID, "sea", seaIndex))).toEntityArray();
		for (const i of hqOf(gameState).navalManager.landingZones[landIndex][seaIndex])
		{
			let pos: CommonPosition = worldPos(i%width+0.5, Math.floor(i/width)+0.5);
			pos = worldPos(cell*pos[0], cell*pos[1]);
			let dist = VectorDistance(startPos, pos);
			if (destination)
				dist += VectorDistance(pos, destination);
			if (avoidEnnemy)
			{
				const territoryOwner = hqOf(gameState).geography.territoryMap.getOwner(pos);
				if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
					dist += 100000000;
			}
			// require a small distance between all ships of the transport plan to avoid path finder problems
			// this is also used when the ship is blocked and we want to find a new boarding point
			for (const shipId in this.boardingPos)
			{
				if (this.boardingPos[shipId] !== undefined &&
					SquareVectorDistance(this.boardingPos[shipId], pos) < this.boardingRange)
				{
					dist += 1000000;
				}
			}
			// and not too near our allied docks to not disturb naval traffic
			let distSquare;
			for (const dock of alliedDocks)
			{
				if (dock.foundationProgress() !== undefined)
					distSquare = 900;
				else
					distSquare = 4900;
				const dockDist = SquareVectorDistance(dock.position(), pos);
				if (dockDist < distSquare)
					dist += 100000 * (distSquare - dockDist) / distSquare;
			}
			if (dist > distmin)
				continue;
			distmin = dist;
			posmin = pos;
		}
		// We should always have either destination or the previous boardingPos defined
		// so let's return this value if everything failed
		if (!posmin && this.boardingPos[ship.id()])
			posmin = this.boardingPos[ship.id()];
		return posmin;
	}

	onSailing(gameState: CommonGameState): void
	{
		// Check that the units recovered on the previous turn have been reloaded
		for (const recov of this.recovered)
		{
			const ent = gameState.getEntityById(recov.entId);
			if (!ent)  // entity destroyed
				continue;
			if (!ent.position())  // reloading succeeded ... move a bit the ship before trying again
			{
				const ship = gameState.getEntityById(recov.shipId);
				if (ship)
					ship.moveApart(recov.entPos, 15);
				continue;
			}
			debugWarn(this, 1, () => ">>> transport " + this.ID + " reloading failed ... <<<");
			// destroy the unit if inaccessible otherwise leave it there
			const index = requireValue(getLandAccess(gameState, ent));
			if (hqOf(gameState).geography.landRegions[index])
			{
				debugWarn(this, 1, () => " recovered entity kept " + ent.id());
				this.resetUnit(gameState, ent);
				// Cancel its garrison order, so it is not reloaded on the next turn without a plan
				ent.stopMoving();
			}
			else
			{
				debugWarn(this, 1, () => "recovered entity destroyed " + ent.id());
				this.resetUnit(gameState, ent);
				ent.destroy();
			}
		}
		this.recovered = [];

		// Check that the units unloaded on the previous turn have been really unloaded and in the right position
		const shipsToMove: Record<number, CommonEntity> = {};
		for (const entId of this.unloaded)
		{
			const ent = gameState.getEntityById(entId);
			if (!ent)  // entity destroyed
				continue;
			else if (!ent.position())  // unloading failed
			{
				const ship = this.shipOf(gameState, ent);
				if (ship)
				{
					if (ship.garrisoned().indexOf(entId) !== -1)
						ent.setMetadata(PlayerID, "onBoard", "onBoard");
					else
					{
						aiWarn("Petra transportPlan problem: unit not on ship without position ???");
						this.resetUnit(gameState, ent);
						ent.destroy();
					}
				}
				else
				{
					aiWarn("Petra transportPlan problem: unit on ship, but no ship ???");
					this.resetUnit(gameState, ent);
					ent.destroy();
				}
			}
			else if (getLandAccess(gameState, ent) !== this.endIndex)
			{
				// unit unloaded on a wrong region - try to regarrison it and move a bit the ship
				debugWarn(this, 1, () => ">>> unit unloaded on a wrong region ! try to garrison it again <<<");
				const ship = this.shipOf(gameState, ent);
				if (ship && !this.canceled)
				{
					shipsToMove[ship.id()] = ship;
					this.recovered.push({ "entId": ent.id(), "entPos": ent.position(), "shipId": ship.id() });
					ent.garrison(ship);
					ent.setMetadata(PlayerID, "onBoard", "onBoard");
				}
				else
				{
					debugWarn(this, 1, () => "no way ... we destroy it");
					this.resetUnit(gameState, ent);
					ent.destroy();
				}
			}
			else
			{
				// And make some room for other units
				// a unit without a destination (FINDINGS §32: as the original, it steps aside;
				// the port's requireMetadata threw, ending the unloading for the turn)
				const pos = ent.position();
				const goal = ent.getMetadata(PlayerID, "endPos");
				const dist = goal ? VectorDistance(pos, goal) : 0;
				if (goal && dist > 30)
					ent.moveToRange(goal[0], goal[1], dist-25, dist-20);
				else
					ent.moveToRange(pos[0], pos[1], 20, 25);
				ent.setMetadata(PlayerID, "transport", undefined);
				ent.setMetadata(PlayerID, "onBoard", undefined);
				ent.setMetadata(PlayerID, "endPos", undefined);
			}
		}
		for (const shipId in shipsToMove)
		{
			const boardingPos = requireValue(this.getBoardingPos(gameState, shipsToMove[shipId], this.endIndex, this.sea, this.endPos, true));
			this.boardingPos[shipId] = boardingPos;
			shipsToMove[shipId].move(boardingPos[0], boardingPos[1]);
		}
		this.unloaded = [];

		if (this.canceled)
		{
			for (const ship of this.ships.values())
			{
				this.boardingPos[ship.id()] = undefined;
				const boardingPos = requireValue(this.getBoardingPos(gameState, ship, this.endIndex, this.sea, this.endPos, true));
				this.boardingPos[ship.id()] = boardingPos;
				ship.move(boardingPos[0], boardingPos[1]);
			}
			this.canceled = undefined;
		}

		for (const ship of this.transportShips.values())
		{
			if (isInState(ship, "INDIVIDUAL.WALKING"))
				continue;
			const shipId = ship.id();
			// set for every ship of the plan when it set sail
			const bp = requireValue(this.boardingPos[shipId]);
			const dist = SquareVectorDistance(ship.position(), bp);
			let remaining = 0;
			for (const entId of ship.garrisoned())
			{
				const ent = requireValue(gameState.getEntityById(entId));
				if (!ent.getMetadata(PlayerID, "transport"))
					continue;
				remaining++;
				if (dist < 625)
				{
					ship.unload(entId);
					this.unloaded.push(entId);
					ent.setMetadata(PlayerID, "onBoard", shipId);
				}
			}

			let recovering = 0;
			for (const recov of this.recovered)
				if (recov.shipId === shipId)
					recovering++;

			if (!remaining && !recovering)   // when empty, release the ship and move apart to leave room for other ships. TODO fight
			{
				ship.moveApart(bp, 30);
				this.releaseShip(ship);
				continue;
			}
			if (dist > this.boardingRange)
			{
				if (!this.nTry[shipId])
					this.nTry[shipId] = 1;
				else
					++this.nTry[shipId];
				if (this.nTry[shipId] > 2)	// we must have been blocked by something ... try with another boarding point
				{
					this.nTry[shipId] = 0;
					debugWarn(this, 1, () => shipId + " new attempt for a landing point ");
					this.boardingPos[shipId] = this.getBoardingPos(gameState, ship, this.endIndex, this.sea, undefined, true);
				}
				// a new search falls back to the previous boarding position
				const newBp = requireValue(this.boardingPos[shipId]);
				ship.move(newBp[0], newBp[1]);
			}
		}
	}

	/** the ship a unit of this plan was sent to (its onBoard metadata holds the ship id until on board) */
	shipOf(gameState: CommonGameState, ent: CommonEntity): CommonEntity | undefined
	{
		const onBoard = ent.getMetadata(PlayerID, "onBoard");
		return onBoard === "onBoard" ? undefined : gameState.getEntityById(onBoard);
	}

	resetUnit(gameState: CommonGameState, ent: CommonEntity): void
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
				attackPlan.removeUnit(ent, true);
		}
		const partOfArmy = ent.getMetadata(PlayerID, "PartOfArmy");
		if (partOfArmy)
		{
			const army = hqOf(gameState).defenseManager.getArmy(partOfArmy);
			if (army)
				army.removeOwn(gameState, ent.id());
		}
	}

	Serialize(): SerializedTransportPlan
	{
		return {
			"ID": this.ID,
			"flotilla": this.flotilla,
			"endPos": this.endPos,
			"endIndex": this.endIndex,
			"startIndex": this.startIndex,
			"sea": this.sea,
			"state": this.state,
			"boardingPos": this.boardingPos,
			"needTransportShips": this.needTransportShips,
			"nTry": this.nTry,
			"canceled": this.canceled,
			"unloaded": this.unloaded,
			"recovered": this.recovered
		};
	}

	Deserialize(data: SerializedTransportPlan): void
	{
		this.ID = data.ID;
		this.flotilla = data.flotilla;
		this.endPos = data.endPos;
		this.endIndex = data.endIndex;
		this.startIndex = data.startIndex;
		this.sea = data.sea;
		this.state = data.state;
		this.boardingPos = data.boardingPos;
		this.needTransportShips = data.needTransportShips;
		this.nTry = data.nTry;
		this.canceled = data.canceled;
		this.unloaded = data.unloaded;
		this.recovered = data.recovered;

	}
}
