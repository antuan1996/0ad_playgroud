/**
 * The town's transports (`gameState.ai.town.transports`, part of execution/town.ts): the transport plans that carry
 * our units between lands — made when a unit asks a passage, split when the ships cannot take all, given free
 * ships, closed when done, and saved with the town — and what units, plans and workers ask of the naval manager:
 * our ships and fleets, where ships may land, the ships a sea needs, and the fishing grounds. It reaches the naval
 * manager only through TransportHQ.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, isSiegeUnit, requireValue } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import type { Config } from "../world/config.ts";
import { TransportPlan, type SeaFleet } from "./transportPlan.ts";

/** The transport plans as the town saves them, keyed by their place in the list */
export type SerializedTransports = Record<string, ReturnType<TransportPlan["Serialize"]>>;

/** What the transports desk asks of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface TransportHQ
{
	readonly navalManager: {
		readonly ships: CommonEntityCollection;
		readonly transportShips: CommonEntityCollection;
		fleet(sea: number): SeaFleet | undefined;
		setMinimalTransportShips(gameState: CommonGameState, sea: SeaIndex, number: number): void;
		resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void;
		getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number;
		canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean;
	};
}

export class TransportDesk
{
	private readonly config: Config;
	private readonly hq: TransportHQ;
	/** the transports under way, in the order they were made */
	private transportPlans: TransportPlan[] = [];

	constructor(config: Config, hq: TransportHQ)
	{
		this.config = config;
		this.hq = hq;
	}

	/** the transports under way, in the order they were made */
	get plans(): readonly TransportPlan[]
	{
		return this.transportPlans;
	}

	/** our ships */
	get ships(): CommonEntityCollection
	{
		return this.hq.navalManager.ships;
	}

	/** our ships that carry units */
	get transportShips(): CommonEntityCollection
	{
		return this.hq.navalManager.transportShips;
	}

	/** our ships on a sea, by kind */
	fleet(sea: number): SeaFleet | undefined
	{
		return this.hq.navalManager.fleet(sea);
	}

	/** The transports' turn: those with no unit left close and free their ships, then free ships go to those in need */
	update(gameState: CommonGameState): void
	{
		for (let i = 0; i < this.transportPlans.length; ++i)
		{
			const remaining = this.transportPlans[i].update(gameState);
			if (remaining)
			{
				continue;
			}
			debugWarn(this.config, 1, () => "no more units on transport plan " + this.transportPlans[i].ID);
			this.transportPlans[i].releaseAll();
			this.transportPlans.splice(i--, 1);
		}
		this.assignShipsToPlans(gameState);
	}

	/** Our ships destroyed: the transports they served lose them */
	checkShipsLost(gameState: CommonGameState, destroyed: EngineAIEvents["Destroy"]): void
	{
		for (const evt of destroyed)
		{
			const transporter = evt.metadata?.[PlayerID]?.transporter;
			if (!transporter)
			{
				continue;
			}
			const plan = this.getPlan(transporter);
			if (!plan)
			{
				continue;
			}

			this.onShipLost(gameState, plan, evt.entity);
		}
	}

	/** Whether a transport with units waits for ships */
	waitingForShips(): boolean
	{
		return this.transportPlans.some((plan) => plan.needTransportShips && plan.units.length > 0);
	}

	/** A ship of a transport plan was destroyed: the units it was to carry wait for another, those landed ask anew. */
	private onShipLost(gameState: CommonGameState, plan: TransportPlan, shipId: EntityId): void
	{
		debugWarn(
			this.config,
			1,
			() => "one ship " + shipId + " from plan " + plan.ID + " destroyed during " + plan.state,
		);
		if (plan.state === TransportPlan.BOARDING)
		{
			// just reset the units onBoard metadata and wait for a new ship to be assigned to this plan
			plan.units.forEach((ent) =>
			{
				if (
					ent.getMetadata(PlayerID, "onBoard") === "onBoard" && isPlaced(ent) ||
					ent.getMetadata(PlayerID, "onBoard") === shipId
				)
				{
					ent.setMetadata(PlayerID, "onBoard", undefined);
				}
			});
			plan.needTransportShips = !plan.transportShips.hasEntities();
		}
		else if (plan.state === TransportPlan.SAILING)
		{
			const endIndex = plan.endIndex;
			for (const ent of plan.units.values())
			{
				if (!isPlaced(ent))
				{ // unit from another ship of this plan ... do nothing
					continue;
				}
				const access = getLandAccess(gameState, ent);
				const endPos = plan.destinationOf(ent);
				ent.setMetadata(PlayerID, "transport", undefined);
				ent.setMetadata(PlayerID, "onBoard", undefined);
				ent.setMetadata(PlayerID, "endPos", undefined);
				// nothing else to do if access = endIndex as already at destination
				// otherwise, we should require another transport
				// TODO if attacking and no more ships available, remove the units from the attack
				// to avoid delaying it too much
				if (access !== endIndex)
				{
					this.requireTransport(gameState, ent, access, endIndex, endPos);
				}
			}
		}
	}

	getPlan(ID: TransportPlanId | undefined): TransportPlan | undefined
	{
		for (const plan of this.transportPlans)
		{
			if (plan.ID === ID)
			{
				return plan;
			}
		}
		return undefined;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	addPlan(plan: TransportPlan): void
	{
		this.transportPlans.push(plan);
	}

	/**
	 * complete already existing plan or create a new one for this requirement
	 * (many units can then call this separately and end up in the same plan)
	 * TODO  check garrison classes
	 */
	requireTransport(
		gameState: CommonGameState,
		ent: CommonEntity,
		startIndex: AccessIndex,
		endIndex: AccessIndex,
		endPos: CommonPosition,
	): boolean
	{
		if (!ent.canGarrison())
		{
			return false;
		}

		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			debugWarn(
				this.config,
				0,
				() => "Petra naval manager error: unit " + ent.id() + " has already required a transport",
			);
			return false;
		}

		const plans: TransportPlan[] = [];
		for (const plan of this.transportPlans)
		{
			if (plan.startIndex !== startIndex || plan.endIndex !== endIndex || plan.state !== TransportPlan.BOARDING)
			{
				continue;
			}
			// Limit the number of siege units per transport to avoid problems when ungarrisoning
			if (isSiegeUnit(ent) && plan.units.filter((unit) => isSiegeUnit(unit)).length > 3)
			{
				continue;
			}
			plans.push(plan);
		}

		if (plans.length)
		{
			// join the plan with the fewest units
			plans.sort((a: TransportPlan, b: TransportPlan): number => a.units.length - b.units.length);
			plans[0].addUnit(ent, endPos);
			return true;
		}

		const plan = TransportPlan.create(gameState, [ent], { startIndex, endIndex, endPos });
		if (!plan)
		{
			debugWarn(this.config, 1, () => ">>>> transport plan aborted <<<<");
			return false;
		}
		this.transportPlans.push(plan);
		return true;
	}

	/** split a transport plan in two, moving all entities not yet affected to a ship in the new plan */
	splitTransport(gameState: CommonGameState, plan: TransportPlan, needSplit: CommonEntity[]): boolean
	{
		debugWarn(this.config, 1, () => ">>>> split of transport plan started <<<<");
		const newplan = TransportPlan.create(gameState, [], plan);
		if (!newplan)
		{
			debugWarn(this.config, 1, () => ">>>> split of transport plan aborted <<<<");
			return false;
		}

		for (const ent of needSplit)
		{
			if (ent.getMetadata(PlayerID, "onBoard"))
			{ // Should never happen.
				continue;
			}
			newplan.addUnit(ent, plan.destinationOf(ent));
			plan.units.updateEnt(ent);
		}

		if (newplan.units.length)
		{
			this.transportPlans.push(newplan);
		}
		return newplan.units.length !== 0;
	}

	/**
	 * create a transport from a garrisoned ship to a land location
	 * needed at start game when starting with a garrisoned ship
	 */
	createTransportIfNeeded(
		gameState: CommonGameState,
		fromPos: CommonPosition,
		toPos: CommonPosition,
		toAccess: AccessIndex,
	): void
	{
		const fromAccess = gameState.ai.accessibility.getAccessValue(fromPos);
		if (fromAccess !== 1)
		{
			return;
		}
		if (toAccess < 2)
		{
			return;
		}

		for (const ship of this.hq.navalManager.ships.values())
		{
			if (!ship.isGarrisonHolder() || !ship.garrisoned().length)
			{
				continue;
			}
			if (ship.getMetadata(PlayerID, "transporter") !== undefined)
			{
				continue;
			}
			const units = ship.garrisoned().map((entId: EntityId): CommonEntity =>
				requireValue(gameState.getEntityById(entId))
			);
			// TODO check that the garrisoned units have not another purpose
			const plan = TransportPlan.create(gameState, units, {
				startIndex: fromAccess,
				endIndex: toAccess,
				endPos: toPos,
			}, ship);
			if (!plan)
			{
				continue;
			}
			this.transportPlans.push(plan);
		}
	}

	/** assigns free ships to plans that need some */
	assignShipsToPlans(gameState: CommonGameState): void
	{
		for (const plan of this.transportPlans)
		{
			if (plan.needTransportShips)
			{
				plan.assignShip(gameState);
			}
		}
	}

	/** Return true if this ship is likeky (un)garrisoning units */
	isShipBoarding(ship: CommonEntity): boolean
	{
		if (!isPlaced(ship))
		{
			return false;
		}
		const plan = this.getPlan(ship.getMetadata(PlayerID, "transporter"));
		const bp = plan?.shipPoints()[ship.id()];
		if (!plan || !bp)
		{
			return false;
		}
		return SquareVectorDistance(bp, ship.position()) < plan.boardingRange;
	}

	/** at least `number` transport ships wanted on the sea */
	setMinimalTransportShips(gameState: CommonGameState, sea: SeaIndex, number: number): void
	{
		this.hq.navalManager.setMinimalTransportShips(gameState, sea, number);
	}

	/** the fishing boats (of a sea, or all) look for fish anew */
	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void
	{
		this.hq.navalManager.resetFishingBoats(gameState, sea);
	}

	getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
	{
		return this.hq.navalManager.getFishSea(gameState, fish);
	}

	canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
	{
		return this.hq.navalManager.canFishSafely(gameState, fish);
	}

	Serialize(): SerializedTransports
	{
		const transports: SerializedTransports = {};
		// keyed by the plan's place in the list, as the save always was
		this.transportPlans.forEach((plan, i) =>
		{
			transports[i] = plan.Serialize();
		});
		return transports;
	}

	/** The saved transports, their units and ships found again; a plan whose sea has no fleet (too small to sail) is left */
	resume(gameState: CommonGameState, data: SerializedTransports): void
	{
		this.transportPlans = [];
		for (const i in data)
		{
			const plan = TransportPlan.restore(gameState, this, data[i]);
			if (plan)
			{
				this.transportPlans.push(plan);
			}
		}
	}
}
