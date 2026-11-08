import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { GAIA, INVALID_ENTITY, NO_REGION, seconds } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getBuiltEntity, getLandAccess, getSeaAccess, isFastMoving, returnResources } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced, isSupply, type PlacedEntity } from "../adapter/placed.ts";
import { requireActivity, stateIs, unitState, type UnitState } from "../adapter/unitState.ts";
import type { ResourceSupply } from "../world/baseResources.ts";
import { basesOf, type BaseView, type SupplyUpkeep, type WorkerBase } from "../world/bases.ts";
import { allowCapture } from "../world/capture.ts";
import { hqOf } from "./hq.ts";
import { gatherTreasure } from "./treasure.ts";
import { PLAN_RESERVE, isLent } from "./unitPlan.ts";

/**
 * This class makes a worker do as instructed by the economy manager
 */

/**
 * Whether a supply takes no more gatherers: full, or its gatherers and those on their way to it (the bases'
 * tally of the turn, BasesManager.GetTCGatherer) at its maximum. (Moved from adapter/, which may read no AI state.)
 */
function isSupplyFull(gameState: CommonGameState, ent: CommonSupplyEntity): boolean
{
	return ent.isFull() === true ||
		ent.resourceSupplyNumGatherers() + gameState.ai.bases.GetTCGatherer(ent.id()) >= ent.maxGatherers();
}

export class Worker
{
	base: WorkerBase;
	baseID: BaseId;

	constructor(base: WorkerBase)
	{
		this.base = base;
		this.baseID = base.ID;
	}

	static readonly ROLE_ATTACK = "attack";
	static readonly ROLE_TRADER = "trader";
	static readonly ROLE_SWITCH_TO_TRADER = "switchToTrader";
	static readonly ROLE_WORKER = "worker";
	static readonly ROLE_CRITICAL_ENT_GUARD = "criticalEntGuard";
	static readonly ROLE_CRITICAL_ENT_HEALER = "criticalEntHealer";

	static readonly SUBROLE_DEFENDER = "defender";
	static readonly SUBROLE_IDLE = "idle";
	static readonly SUBROLE_BUILDER = "builder";
	static readonly SUBROLE_COMPLETING = "completing";
	static readonly SUBROLE_WALKING = "walking";
	static readonly SUBROLE_ATTACKING = "attacking";
	static readonly SUBROLE_GATHERER = "gatherer";
	static readonly SUBROLE_HUNTER = "hunter";
	static readonly SUBROLE_FISHER = "fisher";
	static readonly SUBROLE_GARRISONING = "garrisoning";

	update(gameState: CommonGameState, ent: CommonEntity): void
	{
		if (!isPlaced(ent) || isLent(ent.getMetadata(PlayerID, "plan")))
		{
			return;
		}

		const subrole = ent.getMetadata(PlayerID, "subrole");

		// If we are waiting for a transport or we are sailing, just wait
		if (ent.getMetadata(PlayerID, "transport") !== undefined && this.waitForTransport(gameState, ent, subrole))
		{
			return;
		}

		const entAccess = getLandAccess(gameState, ent);
		// Base for unassigned entities has no accessIndex, so take the one from the entity.
		const baseAccess = this.baseID === gameState.ai.bases.baselessBase().ID ?
			entAccess :
			this.base.accessIndex ?? NO_REGION;

		if (subrole === undefined)
		{ // subrole may-be undefined after a transport, garrisoning, army, ...
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
			this.base.reassignIdleWorkers(gameState, [ent]);
			this.update(gameState, ent);
			return;
		}

		new UnitWork(this, ent, entAccess, baseAccess).run(gameState, subrole);
	}

	/** A worker booked for a transport: a builder whose foundation is gone, or a gatherer with no dropsite where it goes, leaves it. Whether it still waits for it. */
	waitForTransport(gameState: CommonGameState, ent: CommonEntity, subrole: WorkerSubrole | undefined): boolean
	{
		// Except if builder with their foundation destroyed, in which case cancel the transport if not yet on board
		if (subrole === Worker.SUBROLE_BUILDER && ent.getMetadata(PlayerID, "target-foundation") !== undefined)
		{
			const plan = hqOf(gameState).navalManager.getPlan(ent.getMetadata(PlayerID, "transport"));
			const target = gameState.getEntityById(ent.getMetadata(PlayerID, "target-foundation"));
			if (!target && plan && plan.state === "boarding" && isPlaced(ent))
			{
				plan.removeUnit(gameState, ent);
			}
		}
		// and gatherer if there are no more dropsite accessible in the base the ent is going to
		if (subrole === Worker.SUBROLE_GATHERER || subrole === Worker.SUBROLE_HUNTER)
		{
			const plan = hqOf(gameState).navalManager.getPlan(ent.getMetadata(PlayerID, "transport"));
			if (
				plan && plan.state === "boarding" && isPlaced(ent) &&
				!hasDropsiteOn(gameState, plan.endIndex, ent.getMetadata(PlayerID, "gather-type") || "food")
			)
			{
				plan.removeUnit(gameState, ent);
			}
		}
		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			return true;
		}
		return false;
	}

	/** The nearest gatherer at work on the entity's land whose resource it takes, and its square distance */
	private nearestGatherer(
		gameState: CommonGameState,
		ent: CommonEntity,
		pos: CommonPosition,
	): { dist: number; destination: CommonPosition | undefined; }
	{
		const gatherers = this.base.workersBySubrole(gameState, Worker.SUBROLE_GATHERER);
		let dist = Math.min();
		let destination;
		const access = getLandAccess(gameState, ent);
		const types = ent.resourceDropsiteTypes() ?? [];
		for (const gatherer of gatherers.values())
		{
			const gathererType = gatherer.getMetadata(PlayerID, "gather-type") ?? "";
			if (!gathererType || types.indexOf(gathererType) === -1)
			{
				continue;
			}
			const gathererPos = gatherer.position();
			if (
				!gathererPos || gatherer.getMetadata(PlayerID, "transport") !== undefined ||
				getLandAccess(gameState, gatherer) !== access || gatherer.isIdle()
			)
			{
				continue;
			}
			const distance = SquareVectorDistance(pos, gathererPos);
			if (distance > dist)
			{
				continue;
			}
			dist = distance;
			destination = gathererPos;
		}
		return { dist, destination };
	}

	/**
	 * Workers elephant should move away from the buildings they've built to avoid being trapped in between constructions.
	 * For the time being, we move towards the nearest gatherer (providing him a dropsite).
	 * BaseManager does also use that function to deal with its mobile dropsites.
	 */
	moveToGatherer(gameState: CommonGameState, ent: CommonEntity, forced: boolean): void
	{
		const pos = ent.position();
		if (!pos || ent.getMetadata(PlayerID, "target-foundation") !== undefined)
		{
			return;
		}
		if (!forced && gameState.ai.elapsedTime < (ent.getMetadata(PlayerID, "nextMoveToGatherer") || 5))
		{
			return;
		}
		const { dist, destination } = this.nearestGatherer(gameState, ent, pos);
		ent.setMetadata(PlayerID, "nextMoveToGatherer", seconds(gameState.ai.elapsedTime + (destination ? 12 : 5)));
		if (destination && dist > 10)
		{
			ent.move(destination[0], destination[1]);
		}
	}
}

/**
 * One unit's work for a turn, for the base's Worker: the unit, the land it
 * stands on and its base's land, worked out before it is made.
 */
export class UnitWork
{
	readonly worker: Worker;
	readonly base: WorkerBase;
	readonly baseID: BaseId;
	readonly ent: PlacedEntity;
	readonly entAccess: AccessIndex;
	readonly baseAccess: AccessIndex;

	constructor(worker: Worker, ent: PlacedEntity, entAccess: AccessIndex, baseAccess: AccessIndex)
	{
		this.worker = worker;
		this.base = worker.base;
		this.baseID = worker.baseID;
		this.ent = ent;
		this.entAccess = entAccess;
		this.baseAccess = baseAccess;
	}

	/** The unit's work this turn, by its subrole and what it is doing */
	run(gameState: CommonGameState, subrole: WorkerSubrole): void
	{
		const ent = this.ent;
		const state = unitState(ent);
		if (
			(subrole === Worker.SUBROLE_HUNTER || subrole === Worker.SUBROLE_GATHERER) &&
			(stateIs(state, "INDIVIDUAL.GATHER.GATHERING") || stateIs(state, "INDIVIDUAL.GATHER.APPROACHING") ||
				stateIs(state, "INDIVIDUAL.COMBAT.APPROACHING"))
		)
		{
			if (this.checkGatheringTrip(gameState, ent, subrole, state))
			{
				return;
			}
		}
		else if (ent.getMetadata(PlayerID, "approachingTarget"))
		{
			ent.setMetadata(PlayerID, "approachingTarget", undefined);
			ent.setMetadata(PlayerID, "alreadyTried", undefined);
		}

		const unitAIStateOrder = requireActivity(state);
		// If we're fighting or hunting, let's not start gathering except if inaccessible target
		// but for fishers where UnitAI must have made us target a moving whale.
		// Also, if we are attacking, do not capture
		if (unitAIStateOrder === "COMBAT")
		{
			this.updateFighting(gameState, ent, subrole, state);
			return;
		}

		// Okay so we have a few tasks.
		// If we're gathering, we'll check that we haven't run idle.
		// And we'll also check that we're gathering a resource we want to gather.

		if (subrole === Worker.SUBROLE_GATHERER)
		{
			this.updateGatherer(gameState, ent, state, unitAIStateOrder);
		}
		else if (subrole === Worker.SUBROLE_BUILDER)
		{
			this.updateBuilder(gameState, ent, state, unitAIStateOrder);
		}
		else if (subrole === Worker.SUBROLE_HUNTER)
		{
			this.updateHunter(gameState, ent, state, unitAIStateOrder);
		}
		else if (subrole === Worker.SUBROLE_FISHER)
		{
			this.updateFisher(gameState, ent);
		}
	}

	/** A fisher: back to the fish when idle, or when it drifted towards the enemy. */
	updateFisher(gameState: CommonGameState, ent: PlacedEntity): void
	{
		if (ent.isIdle())
		{
			this.startFishing(gameState);
		}
		// if we have drifted towards ennemy territory during the fishing, go home
		else
		{
			const territoryOwner = gameState.ai.geography.territoryMap.getOwner(ent.position());
			if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
			{ // player is its own ally
				this.startFishing(gameState);
			}
		}
	}

	/** A hunter: a new hunt when idle, or when its prey ran too far. */
	updateHunter(
		gameState: CommonGameState,
		ent: PlacedEntity,
		state: UnitState,
		unitAIStateOrder: string | undefined,
	): void
	{
		const lastHuntSearch = ent.getMetadata(PlayerID, "lastHuntSearch");
		if (ent.isIdle() && (!lastHuntSearch || gameState.ai.elapsedTime - lastHuntSearch > 20))
		{
			// nothing to hunt around. Try another region if any
			if (!this.startHunting(gameState) && !this.huntElsewhere(gameState, ent))
			{
				ent.setMetadata(PlayerID, "lastHuntSearch", gameState.ai.elapsedTime);
			}
		}
		else if (unitAIStateOrder === "GATHER")
		{ // Perform some sanity checks
			// we may have drifted towards ennemy territory during the hunt, if yes go home
			const territoryOwner = gameState.ai.geography.territoryMap.getOwner(ent.position());
			if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
			{ // player is its own ally
				this.startHunting(gameState);
			}
			else if (stateIs(state, "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING"))
			{
				this.checkDropsiteReach(gameState, ent);
			}
		}
	}

	/** A hunter with nothing to hunt around goes to the first base with game near it; whether one has */
	private huntElsewhere(gameState: CommonGameState, ent: PlacedEntity): boolean
	{
		for (const base of basesOf(gameState))
		{
			const baseAnchor = base.anchor;
			const basePos = baseAnchor ? baseAnchor.position() : undefined;
			if (!basePos || !this.startHunting(gameState, basePos))
			{
				continue;
			}
			ent.setMetadata(PlayerID, "base", base.ID);
			if (base.accessIndex === this.entAccess)
			{
				ent.move(basePos[0], basePos[1]);
			}
			else
			{
				hqOf(gameState).navalManager.requireTransport(
					gameState,
					ent,
					this.entAccess,
					base.accessIndex ?? NO_REGION,
					basePos,
				);
			}
			return true;
		}
		return false;
	}

	/** Check that UnitAI does not send us to an inaccessible dropsite */
	private checkDropsiteReach(gameState: CommonGameState, ent: PlacedEntity): void
	{
		const dropsiteId = ordersOf(ent)[0].target ?? INVALID_ENTITY;
		const dropsite = gameState.getEntityById(dropsiteId);
		const dropsitePos = dropsite ? dropsite.position() : undefined;
		if (dropsite && dropsitePos && this.entAccess !== getLandAccess(gameState, dropsite))
		{
			returnResources(gameState, ent);
		}
	}

	/** A builder: its foundation, another one, or back to gathering. */
	updateBuilder(
		gameState: CommonGameState,
		ent: PlacedEntity,
		state: UnitState,
		unitAIStateOrder: string | undefined,
	): void
	{
		if (unitAIStateOrder === "REPAIR" && this.keepsRepairing(gameState, ent))
		{
			return;
		}
		// okay so apparently we aren't working.
		// Unless we've been explicitely told to keep our role, make us idle.
		const targetFoundationId = ent.getMetadata(PlayerID, "target-foundation");
		const target = gameState.getEntityById(targetFoundationId);
		// a foundation or a building to repair: on the map
		if (!target || !isPlaced(target) || target.foundationProgress() === undefined && target.needsRepair() === false)
		{
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
			ent.setMetadata(PlayerID, "target-foundation", undefined);
			// If worker elephant, move away to avoid being trapped in between constructions
			if (ent.hasClass("Elephant"))
			{
				this.worker.moveToGatherer(gameState, ent, true);
			}
			else if (this.baseID !== gameState.ai.bases.baselessBase().ID)
			{
				// reassign it to something useful
				this.base.reassignIdleWorkers(gameState, [ent]);
				this.worker.update(gameState, ent);
				return;
			}
		}
		else if (
			unitAIStateOrder !== "RETURNRESOURCE" || !ordersOf(ent).some((order) => order.target === targetFoundationId)
		)
		{
			// (not while it walks its load home with the building queued after it)
			const goalAccess = getLandAccess(gameState, target);
			const queued = returnResources(gameState, ent);
			if (this.entAccess === goalAccess)
			{
				ent.repair(target, target.hasClass("House"), queued); // autocontinue=true for houses
			}
			else
			{
				hqOf(gameState).navalManager.requireTransport(
					gameState,
					ent,
					this.entAccess,
					goalAccess,
					target.position(),
				);
			}
		}
	}

	/**
	 * A builder repairing: it follows the foundation UnitAI sent it to (autocontinue), unless a field; whether
	 * that settles it (its target stands, or it was given other work).
	 */
	private keepsRepairing(gameState: CommonGameState, ent: PlacedEntity): boolean
	{
		// Update our target in case UnitAI sent us to a different foundation because of autocontinue
		// and abandon it if UnitAI has sent us to build a field (as we build them only when needed)
		const order = ordersOf(ent)[0];
		if (order && order.target && ent.getMetadata(PlayerID, "target-foundation") !== order.target)
		{
			const targetId = order.target;
			const target = gameState.getEntityById(targetId);
			if (target && !target.hasClass("Field"))
			{
				ent.setMetadata(PlayerID, "target-foundation", targetId);
				return true;
			}
			ent.setMetadata(PlayerID, "target-foundation", undefined);
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
			ent.stopMoving();
			if (this.baseID !== gameState.ai.bases.baselessBase().ID)
			{
				// reassign it to something useful
				this.base.reassignIdleWorkers(gameState, [ent]);
				this.worker.update(gameState, ent);
				return true;
			}
		}
		// Otherwise check that the target still exists (useful in REPAIR.APPROACHING)
		const targetId = ent.getMetadata(PlayerID, "target-foundation");
		if (targetId && gameState.getEntityById(targetId))
		{
			return true;
		}
		ent.stopMoving();
		return false;
	}

	/** A gatherer: still at what it should gather, or sent to it. */
	updateGatherer(
		gameState: CommonGameState,
		ent: PlacedEntity,
		state: UnitState,
		unitAIStateOrder: string | undefined,
	): void
	{
		if (ent.isIdle())
		{
			// if we aren't storing resources or it's the same type as what we're about to gather,
			// let's just pick a new resource.
			// TODO if we already carry the max we can ->  returnresources
			const carrying = ent.resourceCarrying();
			if (!carrying || !carrying.length || carrying[0].type === ent.getMetadata(PlayerID, "gather-type"))
			{
				this.startGathering(gameState);
			}
			else if (!returnResources(gameState, ent))
			{ // try to deposit resources
				// no dropsite, abandon old resources and start gathering new ones
				this.startGathering(gameState);
			}
		}
		else if (unitAIStateOrder === "GATHER")
		{
			// we're already gathering. But let's check if there is nothing better
			// in case UnitAI did something bad
			if (ordersOf(ent).length)
			{
				this.checkSupplyGathered(gameState, ent);
			}
			if (stateIs(state, "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING"))
			{
				if (gameState.ai.playedTurn % 10 === 0)
				{
					this.checkDropsiteReach(gameState, ent); // from time to time
				}
				this.forgetFarawaySupply(ent);
			}
		}
	}

	/**
	 * A gatherer at a supply other than its own: it moves on if the supply is nearly shared out, or if its base's
	 * nearby (else medium) supplies do not list it; otherwise that supply is its own.
	 * While returning resources UnitAI targets the dropsite, which is no supply:
	 * the return trip is checked apart, the supply once the unit is back at work.
	 */
	private checkSupplyGathered(gameState: CommonGameState, ent: PlacedEntity): void
	{
		const supplyId = ordersOf(ent)[0].target ?? INVALID_ENTITY;
		const supply = gameState.getEntityById(supplyId);
		if (
			!supply || !isSupply(supply) || supply.hasClasses(["Field", "Animal"]) ||
			supplyId === ent.getMetadata(PlayerID, "supply")
		)
		{
			return;
		}
		const nbGatherers = supply.resourceSupplyNumGatherers() + this.base.GetTCGatherer(supplyId);
		if (nbGatherers > 1 && supply.resourceSupplyAmount() / nbGatherers < 30)
		{
			this.base.RemoveTCGatherer(supplyId);
			this.startGathering(gameState);
			return;
		}
		const gatherType = ent.getMetadata(PlayerID, "gather-type") ?? "";
		const nearby = this.base.resources.dropsiteSupplies[gatherType].nearby;
		const medium = this.base.resources.dropsiteSupplies[gatherType].medium;
		const listed = (list: readonly ResourceSupply[]): boolean =>
			list.some((sup: ResourceSupply): boolean => sup.id === supplyId);
		if (listed(nearby) || !nearby.length && !(medium.length && !listed(medium)))
		{
			ent.setMetadata(PlayerID, "supply", supplyId);
		}
		else
		{
			this.base.RemoveTCGatherer(supplyId);
			this.startGathering(gameState);
		}
	}

	/**
	 * If gathering a sparse resource, we may have been sent to a faraway resource if the one nearby was full.
	 * Let's check if it is still the case. If so, we reset its metadata supplyId so that the unit will be
	 * reordered to gather after having returned the resources (when comparing its supplyId with the UnitAI one).
	 */
	private forgetFarawaySupply(ent: PlacedEntity): void
	{
		const gatherType = ent.getMetadata(PlayerID, "gather-type") ?? "";
		const influenceGroup = Resources.GetResource(gatherType)?.aiAnalysisInfluenceGroup;
		if (!influenceGroup || influenceGroup !== "sparse")
		{
			return;
		}
		const supplyId = ent.getMetadata(PlayerID, "supply");
		if (!supplyId)
		{
			return;
		}
		const nearby = this.base.resources.dropsiteSupplies[gatherType].nearby;
		if (nearby.some((sup: ResourceSupply): boolean => sup.id === supplyId))
		{
			return;
		}
		if (nearby.length)
		{
			ent.setMetadata(PlayerID, "supply", undefined);
		}
		else
		{
			const medium = this.base.resources.dropsiteSupplies[gatherType].medium;
			if (!medium.some((sup: ResourceSupply): boolean => sup.id === supplyId) && medium.length)
			{
				ent.setMetadata(PlayerID, "supply", undefined);
			}
		}
	}

	/** A worker fighting: a fisher back to fishing, one chasing out of reach back to work, a capture made an attack. */
	updateFighting(
		gameState: CommonGameState,
		ent: PlacedEntity,
		subrole: WorkerSubrole | undefined,
		state: UnitState,
	): void
	{
		if (subrole === Worker.SUBROLE_FISHER)
		{
			this.startFishing(gameState);
		}
		else if (
			stateIs(state, "INDIVIDUAL.COMBAT.APPROACHING") && ordersOf(ent).length &&
			!ent.getMetadata(PlayerID, "PartOfArmy")
		)
		{
			this.stopChasingAway(gameState, ent, subrole);
		}
		else if (
			stateIs(state, "INDIVIDUAL.COMBAT.ATTACKING") && ordersOf(ent).length &&
			!ent.getMetadata(PlayerID, "PartOfArmy")
		)
		{
			attackRatherThanCapture(gameState, ent);
		}
	}

	/** A worker chasing a target out of its land goes back to work */
	private stopChasingAway(gameState: CommonGameState, ent: PlacedEntity, subrole: WorkerSubrole | undefined): void
	{
		const orderData = ordersOf(ent)[0];
		if (!orderData || !orderData.target)
		{
			return;
		}
		const target = gameState.getEntityById(orderData.target);
		if (target && (!isPlaced(target) || getLandAccess(gameState, target) !== this.entAccess))
		{
			if (this.retryWorking(gameState, subrole))
			{
				return;
			}
			ent.stopMoving();
		}
	}

	/** A gatherer or hunter on its way: back to work if its supply is out of reach, or its prey far from any dropsite or in enemy land. Whether it was given new work. */
	checkGatheringTrip(
		gameState: CommonGameState,
		ent: PlacedEntity,
		subrole: WorkerSubrole | undefined,
		state: UnitState,
	): boolean
	{
		if (this.isInaccessibleSupply(gameState))
		{
			if (this.retryWorking(gameState, subrole))
			{
				return true;
			}
			ent.stopMoving();
		}

		if (stateIs(state, "INDIVIDUAL.COMBAT.APPROACHING") && ordersOf(ent).length && preyTooFar(gameState, ent))
		{
			if (this.retryWorking(gameState, subrole))
			{
				return true;
			}
			ent.stopMoving();
		}
		return false;
	}

	retryWorking(gameState: CommonGameState, subrole: WorkerSubrole | undefined): boolean
	{
		switch (subrole)
		{
			case Worker.SUBROLE_GATHERER:
				return this.startGathering(gameState);
			case Worker.SUBROLE_HUNTER:
				return this.startHunting(gameState);
			case Worker.SUBROLE_FISHER:
				return this.startFishing(gameState);
			case Worker.SUBROLE_BUILDER:
				return this.startBuilding(gameState);
			default:
				return false;
		}
	}

	startBuilding(gameState: CommonGameState): boolean
	{
		const targetFoundationId = this.ent.getMetadata(PlayerID, "target-foundation");
		const target = gameState.getEntityById(targetFoundationId);
		if (!target || target.foundationProgress() === undefined && target.needsRepair() === false)
		{
			return false;
		}
		if (getLandAccess(gameState, target) !== this.entAccess)
		{
			return false;
		}
		this.ent.repair(target, target.hasClass("House")); // autocontinue=true for houses
		return true;
	}

	startGathering(gameState: CommonGameState): boolean
	{
		// First look for possible treasure if any
		if (gatherTreasure(gameState, this.ent))
		{
			return true;
		}

		const resource = this.ent.getMetadata(PlayerID, "gather-type") ?? "";

		// If we are gathering food, try to hunt first
		if (resource === "food" && this.startHunting(gameState))
		{
			return true;
		}

		// a unit that gathers nothing (a worker elephant builds) finds nothing to gather
		const gatherRates = this.ent.resourceGatherRates();
		if (
			gatherRates &&
			(this.gatherInOwnBase(gameState, resource, gatherRates) ||
				this.gatherInReachableBases(gameState, resource, gatherRates) ||
				this.buildReachableDropsite(gameState, resource) ||
				this.gatherOverseas(gameState, resource, gatherRates) ||
				this.buildOverseasDropsite(gameState, resource) ||
				this.gatherFaraway(gameState, resource, gatherRates))
		)
		{
			return true;
		}

		// If we are here, we have nothing left to gather ... certainly no more resources of this type
		hqOf(gameState).noteNothingToGather(resource, gameState.ai.elapsedTime);
		debugWarn(
			gameState.ai.Config,
			2,
			() => " >>>>> worker with gather-type " + resource + " with nothing to gather ",
		);
		this.ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
		return false;
	}

	/** The first supply of a base's band that is worth one more gatherer, booked for this worker. */
	findSupply(
		gameState: CommonGameState,
		base: BaseView & SupplyUpkeep,
		resource: string,
		band: string,
		gatherRates: Readonly<Record<string, number>>,
	): CommonSupplyEntity | false
	{
		const supplies = base.resources.dropsiteSupplies[resource][band];
		const ent = this.ent;
		let ret: CommonSupplyEntity | false = false;
		for (let i = 0; i < supplies.length; ++i)
		{
			const entity = gameState.getEntityById(supplies[i].id);
			// exhausted resource, remove it from this list
			if (!entity || !isSupply(entity))
			{
				base.forgetSupplyAt(resource, band, i--);
				continue;
			}
			if (isSupplyFull(gameState, entity))
			{
				continue;
			}
			const inaccessibleTime = entity.getMetadata(PlayerID, "inaccessibleTime");
			if (inaccessibleTime && gameState.ai.elapsedTime < inaccessibleTime)
			{
				continue;
			}
			const supplyType = entity.get("ResourceSupply/Type") ?? "";
			if (!gatherRates[supplyType])
			{
				continue;
			}
			// check if available resource is worth one additionnal gatherer (except for farms)
			const nbGatherers = entity.resourceSupplyNumGatherers() + this.base.GetTCGatherer(supplies[i].id);
			const supplyTypeObj = entity.resourceSupplyType();
			if (
				supplyTypeObj && supplyTypeObj.specific !== "grain" && nbGatherers > 0 &&
				entity.resourceSupplyAmount() / (1 + nbGatherers) < 30
			)
			{
				continue;
			}
			// not in ennemy territory
			const territoryOwner = gameState.ai.geography.territoryMap.getOwner(entity.position());
			if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
			{ // player is its own ally
				continue;
			}
			this.base.AddTCGatherer(supplies[i].id);
			ent.setMetadata(PlayerID, "supply", supplies[i].id);
			ret = entity;
			break;
		}
		return ret;
	}

	/** startGathering: the nearby and medium supplies of its own base, fields for food. Whether the worker was given work. */
	gatherInOwnBase(
		gameState: CommonGameState,
		resource: string,
		gatherRates: Readonly<Record<string, number>>,
	): boolean
	{
		let supply;
		// first look in our own base if accessible from our present position
		if (this.baseAccess === this.entAccess)
		{
			supply = this.findSupply(gameState, this.base, resource, "nearby", gatherRates);
			if (supply)
			{
				this.ent.gather(supply);
				return true;
			}
			// --> for food, try to gather from fields if any, otherwise build one if any
			if (resource === "food")
			{
				supply = this.gatherNearestField(gameState, this.baseID, gatherRates);
				if (supply)
				{
					this.ent.gather(supply);
					return true;
				}
				supply = this.buildAnyField(gameState, this.baseID);
				if (supply)
				{
					this.ent.repair(supply);
					return true;
				}
			}
			supply = this.findSupply(gameState, this.base, resource, "medium", gatherRates);
			if (supply)
			{
				this.ent.gather(supply);
				return true;
			}
		}
		return false;
	}

	/** startGathering: the other bases on its land, nearby, fields for food, then medium. Whether the worker was given work. */
	gatherInReachableBases(
		gameState: CommonGameState,
		resource: string,
		gatherRates: Readonly<Record<string, number>>,
	): boolean
	{
		let supply;
		// So if we're here we have checked our whole base for a proper resource (or it was not accessible)
		// --> check other bases directly accessible
		for (const base of this.otherBasesOnLand(gameState))
		{
			supply = this.findSupply(gameState, base, resource, "nearby", gatherRates);
			if (supply)
			{
				return this.gatherFor(base, supply);
			}
		}
		if (resource === "food")
		{ // --> for food, try to gather from fields if any, otherwise build one if any
			for (const base of this.otherBasesOnLand(gameState))
			{
				supply = this.gatherNearestField(gameState, base.ID, gatherRates);
				if (supply)
				{
					return this.gatherFor(base, supply);
				}
				supply = this.buildAnyField(gameState, base.ID);
				if (supply)
				{
					this.ent.setMetadata(PlayerID, "base", base.ID);
					this.ent.repair(supply);
					return true;
				}
			}
		}
		for (const base of this.otherBasesOnLand(gameState))
		{
			supply = this.findSupply(gameState, base, resource, "medium", gatherRates);
			if (supply)
			{
				return this.gatherFor(base, supply);
			}
		}

		return false;
	}

	/** The bases other than its own on the land the unit stands on */
	private *otherBasesOnLand(gameState: CommonGameState): Generator<ReturnType<typeof basesOf>[number]>
	{
		for (const base of basesOf(gameState))
		{
			if (base.ID !== this.baseID && base.accessIndex === this.entAccess)
			{
				yield base;
			}
		}
	}

	/** The bases across the sea from the unit */
	private *basesOverseas(gameState: CommonGameState): Generator<ReturnType<typeof basesOf>[number]>
	{
		for (const base of basesOf(gameState))
		{
			if (base.accessIndex !== this.entAccess)
			{
				yield base;
			}
		}
	}

	/** The unit gathers the supply for that base: true */
	private gatherFor(base: BaseView, supply: CommonSupplyEntity | CommonPlacedEntity): boolean
	{
		this.ent.setMetadata(PlayerID, "base", base.ID);
		this.ent.gather(supply);
		return true;
	}

	/** Whether the unit got a ship to the supply (or field) of a base across the sea; it then works for that base */
	private sailToWork(gameState: CommonGameState, base: BaseView, supply: CommonPlacedEntity | false): boolean
	{
		if (
			!supply ||
			!hqOf(gameState).navalManager.requireTransport(
				gameState,
				this.ent,
				this.entAccess,
				base.accessIndex ?? NO_REGION,
				supply.position(),
			)
		)
		{
			return false;
		}
		if (base.ID !== this.baseID)
		{
			this.ent.setMetadata(PlayerID, "base", base.ID);
		}
		return true;
	}

	/** startGathering: a dropsite foundation of that resource on its land to help build. Whether the worker was given work. */
	buildReachableDropsite(gameState: CommonGameState, resource: string): boolean
	{
		// Okay may-be we haven't found any appropriate dropsite anywhere.
		// Try to help building one if any accessible foundation available
		const foundations = gameState.getOwnFoundations().toEntityArray();
		const shouldBuild = this.ent.isBuilder() && foundations.some((foundation) =>
		{
			if (!foundation || getLandAccess(gameState, foundation) !== this.entAccess)
			{
				return false;
			}
			const dropsiteTypes = getBuiltEntity(gameState, foundation).resourceDropsiteTypes();
			if (dropsiteTypes && dropsiteTypes.indexOf(resource) !== -1)
			{
				this.buildFor(foundation);
				this.ent.repair(foundation);
				return true;
			}
			return false;
		});
		if (shouldBuild)
		{
			return true;
		}

		return false;
	}

	/** The unit becomes the foundation's builder, in its base */
	private buildFor(foundation: CommonEntity): void
	{
		if (foundation.getMetadata(PlayerID, "base") !== this.baseID)
		{
			this.ent.setMetadata(PlayerID, "base", foundation.getMetadata(PlayerID, "base"));
		}
		this.ent.setMetadata(PlayerID, "target-foundation", foundation.id());
		this.ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
	}

	/** startGathering: the bases across the sea, by a transport. Whether the worker was given work. */
	gatherOverseas(gameState: CommonGameState, resource: string, gatherRates: Readonly<Record<string, number>>): boolean
	{
		// Still nothing ... try bases which need a transport
		for (const base of this.basesOverseas(gameState))
		{
			if (this.sailToWork(gameState, base, this.findSupply(gameState, base, resource, "nearby", gatherRates)))
			{
				return true;
			}
		}
		if (resource === "food")
		{ // --> for food, try to gather from fields if any, otherwise build one if any
			for (const base of this.basesOverseas(gameState))
			{
				if (this.sailToWork(gameState, base, this.gatherNearestField(gameState, base.ID, gatherRates)))
				{
					return true;
				}
				if (this.sailToWork(gameState, base, this.buildAnyField(gameState, base.ID)))
				{
					return true;
				}
			}
		}
		for (const base of this.basesOverseas(gameState))
		{
			if (this.sailToWork(gameState, base, this.findSupply(gameState, base, resource, "medium", gatherRates)))
			{
				return true;
			}
		}
		return false;
	}

	/** startGathering: a dropsite foundation of that resource across the sea, by a transport. Whether the worker was given work. */
	buildOverseasDropsite(gameState: CommonGameState, resource: string): boolean
	{
		const navalManager = hqOf(gameState).navalManager;
		const foundations = gameState.getOwnFoundations().toEntityArray();
		// Okay so we haven't found any appropriate dropsite anywhere.
		// Try to help building one if any non-accessible foundation available
		const shouldBuild = this.ent.isBuilder() && foundations.some((foundation) =>
		{
			if (!foundation || getLandAccess(gameState, foundation) === this.entAccess)
			{
				return false;
			}
			const dropsiteTypes = getBuiltEntity(gameState, foundation).resourceDropsiteTypes();
			if (dropsiteTypes && dropsiteTypes.indexOf(resource) !== -1)
			{
				const foundationAccess = getLandAccess(gameState, foundation);
				if (
					navalManager.requireTransport(
						gameState,
						this.ent,
						this.entAccess,
						foundationAccess,
						foundation.position(),
					)
				)
				{
					this.buildFor(foundation);
					return true;
				}
			}
			return false;
		});
		if (shouldBuild)
		{
			return true;
		}

		return false;
	}

	/** startGathering: the faraway supplies, on its land then across the sea, unless food may not be fetched far. Whether the worker was given work. */
	gatherFaraway(gameState: CommonGameState, resource: string, gatherRates: Readonly<Record<string, number>>): boolean
	{
		// Still nothing, we look now for faraway resources, first in the accessible ones, then in the others
		// except for food when farms or corrals can be used
		const allowDistant = resource !== "food" || hqOf(gameState).allowsDistantFood(gameState);
		if (!allowDistant)
		{
			return false;
		}
		if (this.baseAccess === this.entAccess)
		{
			const supply = this.findSupply(gameState, this.base, resource, "faraway", gatherRates);
			if (supply)
			{
				this.ent.gather(supply);
				return true;
			}
		}
		for (const base of this.otherBasesOnLand(gameState))
		{
			const supply = this.findSupply(gameState, base, resource, "faraway", gatherRates);
			if (supply)
			{
				return this.gatherFor(base, supply);
			}
		}
		for (const base of this.basesOverseas(gameState))
		{
			if (this.sailToWork(gameState, base, this.findSupply(gameState, base, resource, "faraway", gatherRates)))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * if position is given, we only check if we could hunt from this position but do nothing
	 * otherwise the position of the entity is taken, and if something is found, we directly start the hunt
	 */
	startHunting(gameState: CommonGameState, position?: CommonPosition): boolean
	{
		// First look for possible treasure if any
		if (!position && gatherTreasure(gameState, this.ent))
		{
			return true;
		}

		const resources = gameState.getHuntableSupplies();
		if (!resources.hasEntities())
		{
			return false;
		}

		let nearestSupplyDist = Math.min();
		let nearestSupply: CommonEntity | undefined;

		const gatherRates = this.ent.resourceGatherRates();
		// a unit that gathers nothing (a worker elephant builds) has no game to hunt
		if (!gatherRates)
		{
			return false;
		}
		const hunt: Hunt = {
			fast: isFastMoving(this.ent),
			ranged: !!this.ent.hasClass("Ranged"),
			from: position ? position : this.ent.position(),
			foodDropsites: foodDropsitesOf(gameState),
			gatherRates,
		};
		for (const supply of resources.values())
		{
			const dist = this.preyDistance(gameState, supply, hunt, nearestSupplyDist);
			if (dist === undefined)
			{
				continue;
			}
			nearestSupplyDist = dist;
			nearestSupply = supply;
		}

		if (nearestSupply)
		{
			if (position)
			{
				return true;
			}
			this.base.AddTCGatherer(nearestSupply.id());
			this.ent.gather(nearestSupply);
			this.ent.setMetadata(PlayerID, "supply", nearestSupply.id());
			this.ent.setMetadata(PlayerID, "target-foundation", undefined);
			return true;
		}
		return false;
	}

	/** Whether our unit can gather the supply and it has enough left for one more gatherer */
	private worthOneMoreGatherer(
		gameState: CommonGameState,
		supply: CommonSupplyEntity,
		gatherRates: Readonly<Record<string, number>>,
	): boolean
	{
		const supplyType = supply.get("ResourceSupply/Type") ?? "";
		if (!gatherRates[supplyType])
		{
			return false;
		}

		if (isSupplyFull(gameState, supply))
		{
			return false;
		}
		// Check if available resource is worth one additionnal gatherer (except for farms).
		const nbGatherers = supply.resourceSupplyNumGatherers() + this.base.GetTCGatherer(supply.id());
		return !(nbGatherers > 0 && supply.resourceSupplyAmount() / (1 + nbGatherers) < 30);
	}

	/** Whether game is worth one more hunter: reachable lately, one we can hunt, not full, not nearly shared out */
	private worthHunting(
		gameState: CommonGameState,
		supply: CommonSupplyEntity,
		gatherRates: Readonly<Record<string, number>>,
	): boolean
	{
		const inaccessibleTime = supply.getMetadata(PlayerID, "inaccessibleTime");
		if (inaccessibleTime && gameState.ai.elapsedTime < inaccessibleTime)
		{
			return false;
		}
		return this.worthOneMoreGatherer(gameState, supply, gatherRates);
	}

	/** The square distance to a prey worth hunting and nearer than nearest, or undefined */
	private preyDistance(
		gameState: CommonGameState,
		supply: CommonSupplyEntity,
		hunt: Hunt,
		nearest: number,
	): number | undefined
	{
		const supplyPos = supply.position();
		if (!this.worthHunting(gameState, supply, hunt.gatherRates))
		{
			return undefined;
		}

		const canFlee = !supply.hasClass("Domestic") && supply.templateName().indexOf("resource|") === -1;
		// Only FastMoving and Ranged units should hunt fleeing animals.
		if (canFlee && !hunt.fast && !hunt.ranged)
		{
			return undefined;
		}

		const supplyAccess = getLandAccess(gameState, supply);
		if (supplyAccess !== this.entAccess)
		{
			return undefined;
		}

		// measure the distance to the resource.
		const dist = SquareVectorDistance(hunt.from, supplyPos);
		if (dist > nearest)
		{
			return undefined;
		}

		// Only FastMoving should hunt faraway.
		if (!hunt.fast && dist > 25000)
		{
			return undefined;
		}

		if (!huntableThere(gameState, supply, supplyPos, !hunt.fast && canFlee))
		{
			return undefined;
		}
		const distanceSquare = hunt.fast ? 35000 : (canFlee ? 7000 : 12000);
		if (!hasFoodDropsiteNear(gameState, hunt.foodDropsites, supplyPos, supplyAccess, distanceSquare))
		{
			return undefined;
		}
		return dist;
	}

	startFishing(gameState: CommonGameState): boolean
	{
		const resources = gameState.getFishableSupplies();
		if (!resources.hasEntities())
		{
			hqOf(gameState).navalManager.resetFishingBoats(gameState);
			this.ent.destroy();
			return false;
		}

		let nearestSupplyDist = Math.min();
		let nearestSupply: CommonEntity | undefined;

		const fisherSea = getSeaAccess(gameState, this.ent);
		const fishDropsites =
			(gameState.playerData.hasSharedDropsites ?
				gameState.getAnyDropsites("food") :
				gameState.getOwnDropsites("food")).filter(filters.byClass("Dock")).toEntityArray();

		let exhausted = true;
		const gatherRates = this.ent.resourceGatherRates();
		// a unit that gathers nothing (a worker elephant builds) has no fish to catch
		if (!gatherRates)
		{
			return false;
		}
		resources.forEach((supply) =>
		{
			// check that it is accessible
			if (hqOf(gameState).navalManager.getFishSea(gameState, supply) !== fisherSea)
			{
				return;
			}

			exhausted = false;

			if (!this.worthFishing(gameState, supply, gatherRates))
			{
				return;
			}

			// measure the distance from the resource to the nearest dropsite
			const dist = nearestDock(gameState, supply.position(), fishDropsites, fisherSea);
			if (dist > nearestSupplyDist)
			{
				return;
			}

			nearestSupplyDist = dist;
			nearestSupply = supply;
		});

		if (exhausted)
		{
			hqOf(gameState).navalManager.resetFishingBoats(gameState, fisherSea);
			this.ent.destroy();
			return false;
		}

		if (nearestSupply)
		{
			this.base.AddTCGatherer(nearestSupply.id());
			this.ent.gather(nearestSupply);
			this.ent.setMetadata(PlayerID, "supply", nearestSupply.id());
			this.ent.setMetadata(PlayerID, "target-foundation", undefined);
			return true;
		}
		if (this.ent.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_FISHER)
		{
			this.ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
		}
		return false;
	}

	/** Whether the fish is worth one more fisher: one we can catch, not full, not nearly shared out, out of enemy reach */
	private worthFishing(
		gameState: CommonGameState,
		supply: CommonSupplyEntity,
		gatherRates: Readonly<Record<string, number>>,
	): boolean
	{
		if (!this.worthOneMoreGatherer(gameState, supply, gatherRates))
		{
			return false;
		}

		// Avoid ennemy territory
		return hqOf(gameState).navalManager.canFishSafely(gameState, supply);
	}

	gatherNearestField(
		gameState: CommonGameState,
		baseID: BaseId,
		gatherRates: Readonly<Record<string, number>>,
	): CommonPlacedEntity | false
	{
		const ownFields = gameState.getOwnEntitiesByClass("Field", true).filter(filters.isBuilt()).filter(
			filters.byMetadata(PlayerID, "base", baseID),
		);
		let bestFarm;

		for (const field of ownFields.values())
		{
			// a built field: a supply
			if (!isSupply(field) || isSupplyFull(gameState, field))
			{
				continue;
			}
			const supplyType = field.get("ResourceSupply/Type") ?? "";
			if (!gatherRates[supplyType])
			{
				continue;
			}

			let rate = 1;
			const diminishing = field.getDiminishingReturns();
			if (diminishing < 1)
			{
				const num = field.resourceSupplyNumGatherers() + this.base.GetTCGatherer(field.id());
				if (num > 0)
				{
					rate = Math.pow(diminishing, num);
				}
			}
			// Add a penalty distance depending on rate
			const dist = SquareVectorDistance(field.position(), this.ent.position()) + (1 - rate) * 160000;
			if (!bestFarm || dist < bestFarm.dist)
			{
				bestFarm = { ent: field, dist: dist, rate: rate };
			}
		}
		// If other field foundations available, better build them when rate becomes too small
		if (
			!bestFarm ||
			bestFarm.rate < 0.70 &&
				gameState.getOwnFoundations().filter(filters.byClass("Field")).filter(
					filters.byMetadata(PlayerID, "base", baseID),
				).hasEntities()
		)
		{
			return false;
		}
		this.base.AddTCGatherer(bestFarm.ent.id());
		this.ent.setMetadata(PlayerID, "supply", bestFarm.ent.id());
		return bestFarm.ent;
	}

	/**
	 * WARNING with the present options of AI orders, the unit will not gather after building the farm.
	 * This is done by calling the gatherNearestField function when construction is completed.
	 */
	buildAnyField(gameState: CommonGameState, baseID: BaseId): CommonPlacedEntity | false
	{
		if (!this.ent.isBuilder())
		{
			return false;
		}
		let bestFarmEnt: CommonPlacedEntity | false = false;
		let bestFarmDist = 10000000;
		const pos = this.ent.position();
		for (const found of gameState.getOwnFoundations().values())
		{
			if (found.getMetadata(PlayerID, "base") !== baseID || !found.hasClass("Field"))
			{
				continue;
			}
			const current = found.getBuildersNb();
			const template = getBuiltEntity(gameState, found);
			if (current === undefined || current >= template.maxGatherers())
			{
				continue;
			}
			const dist = SquareVectorDistance(found.position(), pos);
			if (dist > bestFarmDist)
			{
				continue;
			}
			bestFarmEnt = found;
			bestFarmDist = dist;
		}
		return bestFarmEnt;
	}

	/**
	 * Check accessibility of the target when in approach (in RMS maps, we quite often have chicken or bushes
	 * inside obstruction of other entities). The resource will be flagged as inaccessible during 10 mn (in case
	 * it will be cleared later).
	 */
	isInaccessibleSupply(gameState: CommonGameState): boolean
	{
		const order = ordersOf(this.ent)[0];
		if (!order || !order.target)
		{
			return false;
		}
		const targetId = order.target;
		const target = gameState.getEntityById(targetId);
		if (!target)
		{
			return true;
		}

		if (!target.resourceSupplyType())
		{
			return false;
		}

		const carrying = this.ent.resourceCarrying();
		const carriedAmount = carrying && carrying.length > 0 ? carrying[0].amount : 0;
		this.noteApproach(targetId, carriedAmount);

		const carriedBefore = this.ent.getMetadata(PlayerID, "carriedBefore");
		if (carriedBefore !== carriedAmount)
		{
			this.ent.setMetadata(PlayerID, "approachingTarget", undefined);
			this.ent.setMetadata(PlayerID, "alreadyTried", undefined);
			if (target.getMetadata(PlayerID, "inaccessibleTime"))
			{
				target.setMetadata(PlayerID, "inaccessibleTime", seconds(0));
			}
			return false;
		}

		const inaccessibleTime = target.getMetadata(PlayerID, "inaccessibleTime");
		if (inaccessibleTime && gameState.ai.elapsedTime < inaccessibleTime)
		{
			return true;
		}

		const approachingTime = this.ent.getMetadata(PlayerID, "approachingTime") ?? 0;
		if (!approachingTime || gameState.ai.elapsedTime - approachingTime > 3)
		{
			return this.stuckApproaching(gameState, target, approachingTime);
		}
		return false;
	}

	/** A new target approached: its approach is followed from now, with what the unit carries */
	private noteApproach(targetId: EntityId, carriedAmount: number): void
	{
		const approachingTarget = this.ent.getMetadata(PlayerID, "approachingTarget");
		if (approachingTarget && approachingTarget === targetId)
		{
			return;
		}
		this.ent.setMetadata(PlayerID, "approachingTarget", targetId);
		this.ent.setMetadata(PlayerID, "approachingTime", undefined);
		this.ent.setMetadata(PlayerID, "approachingPos", undefined);
		this.ent.setMetadata(PlayerID, "carriedBefore", carriedAmount);
		const alreadyTried = this.ent.getMetadata(PlayerID, "alreadyTried");
		if (alreadyTried && alreadyTried !== targetId)
		{
			this.ent.setMetadata(PlayerID, "alreadyTried", undefined);
		}
	}

	/**
	 * Whether a unit unmoved for 10 s on its way to the target, a second time, finds it inaccessible (for 10 mn);
	 * the first time it tries again
	 */
	private stuckApproaching(gameState: CommonGameState, target: CommonEntity, approachingTime: number): boolean
	{
		const presentPos = this.ent.position();
		const approachingPos = this.ent.getMetadata(PlayerID, "approachingPos");
		if (!approachingPos || approachingPos[0] !== presentPos[0] || approachingPos[1] !== presentPos[1])
		{
			this.ent.setMetadata(PlayerID, "approachingTime", gameState.ai.elapsedTime);
			this.ent.setMetadata(PlayerID, "approachingPos", presentPos);
			return false;
		}
		if (!(gameState.ai.elapsedTime - approachingTime > 10))
		{
			return false;
		}
		if (this.ent.getMetadata(PlayerID, "alreadyTried"))
		{
			target.setMetadata(PlayerID, "inaccessibleTime", seconds(gameState.ai.elapsedTime + 600));
			return true;
		}
		// let's try again to reach it
		this.ent.setMetadata(PlayerID, "alreadyTried", target.id());
		this.ent.setMetadata(PlayerID, "approachingTarget", undefined);
		this.ent.gather(target);
		return false;
	}
}

/** What a hunt reads: whether the hunter is fast or ranged, where it hunts from, the food dropsites, its gather rates */
type Hunt = {
	fast: boolean;
	ranged: boolean;
	from: CommonPosition;
	foodDropsites: CommonEntityCollection;
	gatherRates: Readonly<Record<string, number>>;
};

/**
 * If we are here, an enemy structure must have targeted one of our workers
 * and UnitAI sent it fight back with allowCapture=true: it attacks, capturing only if worth it
 */
function attackRatherThanCapture(gameState: CommonGameState, ent: PlacedEntity): void
{
	const orderData = ordersOf(ent)[0];
	if (!orderData || !orderData.target || !orderData.attackType || orderData.attackType !== "Capture")
	{
		return;
	}
	const target = gameState.getEntityById(orderData.target);
	const targetOwner = target ? target.owner() : GAIA;
	if (target && targetOwner > 0 && !gameState.isPlayerAlly(targetOwner))
	{
		ent.attack(orderData.target, allowCapture(gameState, ent, target));
	}
}

/**
 * Check that we have not drifted too far when hunting: whether the prey approached is in enemy territory,
 * or outside ours and our allies' with no food dropsite near enough
 */
function preyTooFar(gameState: CommonGameState, ent: PlacedEntity): boolean
{
	const orderData = ordersOf(ent)[0];
	if (!orderData || !orderData.target)
	{
		return false;
	}
	const target = gameState.getEntityById(orderData.target);
	const targetPos = target ? target.position() : undefined;
	const targetSupplyType = target ? target.resourceSupplyType() : undefined;
	if (!target || !targetPos || !targetSupplyType || targetSupplyType.generic !== "food")
	{
		return false;
	}
	const territoryOwner = gameState.ai.geography.territoryMap.getOwner(targetPos);
	if (gameState.isPlayerEnemy(territoryOwner))
	{
		return true;
	}
	if (gameState.isPlayerAlly(territoryOwner))
	{
		return false;
	}
	const distanceSquare = isFastMoving(ent) ? 90000 : 30000;
	return !hasFoodDropsiteNear(
		gameState,
		foodDropsitesOf(gameState),
		targetPos,
		getLandAccess(gameState, target),
		distanceSquare,
	);
}

/**
 * Whether game may be hunted where it stands: not in enemy territory, nor an ally's cattle in its territory,
 * nor out of any territory for a slow hunter after game that flees (only FastMoving should hunt far from dropsite)
 */
function huntableThere(
	gameState: CommonGameState,
	supply: CommonEntity,
	supplyPos: CommonPosition,
	slowAfterFleeing: boolean,
): boolean
{
	// Avoid enemy territory.
	const territoryOwner = gameState.ai.geography.territoryMap.getOwner(supplyPos);
	if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
	{ // Player is its own ally.
		return false;
	}
	// And if in ally territory, don't hunt this ally's cattle.
	if (territoryOwner !== 0 && territoryOwner !== PlayerID && supply.owner() === territoryOwner)
	{
		return false;
	}
	return !(slowAfterFleeing && territoryOwner === 0);
}

/** Whether we may drop resources at the dropsite: placed, and ours or a mutual ally's shared one */
function isUsableDropsite(gameState: CommonGameState, dropsite: CommonEntity): dropsite is CommonPlacedEntity
{
	if (!isPlaced(dropsite))
	{
		return false;
	}
	const owner = dropsite.owner();
	// owner != PlayerID can only happen when hasSharedDropsites == true, so no need to test it again
	return owner === PlayerID || (dropsite.isSharedDropsite() && gameState.isPlayerMutualAlly(owner));
}

/** The square distance from the position to our nearest dock on the sea (1000000 at most) */
function nearestDock(
	gameState: CommonGameState,
	pos: CommonPosition,
	fishDropsites: CommonEntity[],
	fisherSea: SeaIndex | undefined,
): number
{
	let distMin = 1000000;
	for (const dropsite of fishDropsites)
	{
		if (!isUsableDropsite(gameState, dropsite) || fisherSea !== getSeaAccess(gameState, dropsite))
		{
			continue;
		}
		distMin = Math.min(distMin, SquareVectorDistance(pos, dropsite.position()));
	}
	return distMin;
}

/** Whether a dropsite (a structure, or a support unit) for the resource stands on the land */
function hasDropsiteOn(gameState: CommonGameState, land: AccessIndex, gatherType: string): boolean
{
	for (const structure of gameState.getOwnStructures().values())
	{
		if (getLandAccess(gameState, structure) !== land)
		{
			continue;
		}
		const resourceDropsiteTypes = getBuiltEntity(gameState, structure).resourceDropsiteTypes();
		if (resourceDropsiteTypes && resourceDropsiteTypes.indexOf(gatherType) !== -1)
		{
			return true;
		}
	}
	for (const unit of gameState.getOwnUnits().filter(filters.byClass("Support")).values())
	{
		if (!isPlaced(unit) || getLandAccess(gameState, unit) !== land)
		{
			continue;
		}
		const resourceDropsiteTypes = unit.resourceDropsiteTypes();
		if (resourceDropsiteTypes && resourceDropsiteTypes.indexOf(gatherType) !== -1)
		{
			return true;
		}
	}
	return false;
}

/** The food dropsites a unit of ours may use: ours, and our mutual allies' shared ones when dropsites are shared */
function foodDropsitesOf(gameState: CommonGameState): CommonEntityCollection
{
	return gameState.playerData.hasSharedDropsites ?
		gameState.getAnyDropsites("food") :
		gameState.getOwnDropsites("food");
}

/** Whether a food dropsite we may use stands on the land within the square distance of the position */
function hasFoodDropsiteNear(
	gameState: CommonGameState,
	foodDropsites: CommonEntityCollection,
	position: CommonPosition,
	access: AccessIndex | undefined,
	distSquare: number,
): boolean
{
	for (const dropsite of foodDropsites.values())
	{
		if (!isUsableDropsite(gameState, dropsite) || access !== getLandAccess(gameState, dropsite))
		{
			continue;
		}
		if (SquareVectorDistance(position, dropsite.position()) < distSquare)
		{
			return true;
		}
	}
	return false;
}

/** Whether a unit marches or fights with an attack plan: in a plan, completing it, walking or attacking */
export function marchesWithAttack(ent: CommonEntity): boolean
{
	const plan = ent.getMetadata(PlayerID, "plan");
	if (plan === undefined || plan === PLAN_RESERVE)
	{
		return false;
	}
	const subrole = ent.getMetadata(PlayerID, "subrole");
	return !!subrole &&
		(subrole === Worker.SUBROLE_COMPLETING || subrole === Worker.SUBROLE_WALKING ||
			subrole === Worker.SUBROLE_ATTACKING);
}
