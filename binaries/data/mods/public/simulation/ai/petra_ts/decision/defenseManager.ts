/** The fields a save keeps, and the armies. */
export type SerializedDefenseManager = {
	properties: Pick<
		DefenseManager,
		"targetList" | "armyMergeSize" | "attackingUnits" | "attackingArmies" | "attackedAllies"
	>;
	armies: SerializedDefenseArmy[];
};

import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { GAIA, playerId } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { allowCapture, getLandAccess, getMaxStrength, isSiegeUnit, requireValue } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { activityOf, hasActivity, isInState, unitState } from "../adapter/unitState.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { DefenseArmy, type SerializedDefenseArmy } from "../execution/defenseArmy.ts";
import { isLent } from "../execution/unitPlan.ts";
import { Worker, marchesWithAttack } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";
import type { Geography } from "../world/geography.ts";
import type { BaseManager } from "./baseManager.ts";
import { GarrisonManager } from "./garrisonManager.ts";

type DefenseManagerEvents = Omit<EngineAIEvents, "Attacked"> & {
	Attacked: Array<{ target: EntityId; attacker: EntityId; }>;
};

/**
 * The square of the distance within which an entity threatens: 6000, or its range plus 30 for a shooter.
 * TODO the 30 is to take roughly into account the structure size in following checks. Can be improved.
 */
function threatRadius2(entity: CommonEntity, attackTypes: string[]): number
{
	// attackRange("Ranged") is defined whenever Ranged is in attackTypes
	const ranged = entity.attackRange("Ranged");
	if (attackTypes.indexOf("Ranged") !== -1 && ranged)
	{
		return (ranged.max + 30) * (ranged.max + 30);
	}
	return 6000;
}

/** Whether the target shoots arrows and the attacker is within their range */
function shootsAt(target: CommonPlacedEntity, attacker: CommonPlacedEntity): boolean
{
	const attackTypes = target.attackTypes();
	if (!attackTypes || attackTypes.indexOf("Ranged") === -1)
	{
		return false;
	}
	const dist = SquareVectorDistance(attacker.position(), target.position());
	// attackRange("Ranged") is defined whenever Ranged is in attackTypes
	const range = requireValue(target.attackRange("Ranged")).max;
	return !(dist >= range * range);
}

/** Whether a unit completes, walks or fights for an attack plan */
function marchingSubrole(ent: CommonEntity): boolean
{
	const subrole = ent.getMetadata(PlayerID, "subrole");
	return !!subrole &&
		(subrole === Worker.SUBROLE_COMPLETING || subrole === Worker.SUBROLE_WALKING ||
			subrole === Worker.SUBROLE_ATTACKING);
}

/** The nearest ally structure on the unit's land that can hold it, is not about to eject it, and fits */
function nearestHolder(
	gameState: CommonGameState,
	unit: CommonPlacedEntity,
	fits: (ent: CommonStructureEntity) => boolean,
): CommonStructureEntity | undefined
{
	let distmin = Math.min();
	let nearest;
	const unitAccess = getLandAccess(gameState, unit);
	for (const ent of gameState.getAllyStructures().values())
	{
		if (!ent.isGarrisonHolder())
		{
			continue;
		}
		if (!fits(ent))
		{
			continue;
		}
		if (!unit.hasClasses(ent.garrisonableClasses()))
		{
			continue;
		}
		if (ent.hitpoints() < ent.garrisonEjectHealth() * ent.maxHitpoints())
		{
			continue;
		}
		if (getLandAccess(gameState, ent) !== unitAccess)
		{
			continue;
		}
		const dist = SquareVectorDistance(ent.position(), unit.position());
		if (dist > distmin)
		{
			continue;
		}
		distmin = dist;
		nearest = ent;
	}
	return nearest;
}

/** The nearest unit of ours still capturing the structure orderId that can attack the attacker and is not attacked itself */
function nearestFellowCapturer(
	gameState: CommonGameState,
	capturers: Set<EntityId>,
	attacker: CommonPlacedEntity,
	orderId: EntityId,
	allAttacked: Record<number, number>,
): CommonEntity | undefined
{
	let minDist = Infinity;
	let minEnt;
	const pos = attacker.position();
	for (const entId of capturers)
	{
		if (allAttacked[entId])
		{
			continue;
		}
		const ent = gameState.getEntityById(entId);
		if (!ent || !isPlaced(ent) || !ent.canAttackTarget(attacker, allowCapture(gameState, ent, attacker)))
		{
			continue;
		}
		// Check that the unit is still attacking the structure (since the last played turn).
		if (!hasActivity(ent, "COMBAT"))
		{
			continue;
		}
		const entOrderData = ordersOf(ent);
		if (!entOrderData || !entOrderData.length || !entOrderData[0].target || entOrderData[0].target !== orderId)
		{
			continue;
		}
		const dist = SquareVectorDistance(pos, ent.position());
		if (minEnt && dist > minDist)
		{
			continue;
		}
		minDist = dist;
		minEnt = ent;
	}
	return minEnt;
}

/** A structure we cannot defend is destroyed once it is being captured (between 50% and 70% left to us) */
function destroyBeforeCapture(target: CommonEntity): void
{
	const capture = target.capturePoints();
	if (!capture)
	{
		return;
	}
	const captureRatio = capture[PlayerID] / capture.reduce((a: number, b: number): number => a + b);
	if (captureRatio > 0.50 && captureRatio < 0.70)
	{
		target.destroy();
	}
}

/** A fishing boat moves out of its attacker's range */
function fleeFrom(target: CommonPlacedEntity, attacker: CommonPlacedEntity): void
{
	const pos = attacker.position();
	const attackerRange = attacker.attackRange("Ranged");
	const range = attackerRange ? attackerRange.max + 15 : 25;
	if (range * range > SquareVectorDistance(pos, target.position()))
	{
		target.moveToRange(pos[0], pos[1], range, range + 5);
	}
}

/**
 * Whether a capturing army gives up when target is attacked: one of the units trying to capture a structure
 * (so that the unit can defend itself), or our own structure it regains capture points of with no enemy's left.
 */
function abortsCapture(gameState: CommonGameState, army: DefenseArmy, target: CommonEntity): boolean
{
	if (army.ownEntities.indexOf(target.id()) !== -1)
	{
		return true;
	}
	if (army.foeEntities[0] !== target.id() || target.owner() !== PlayerID)
	{
		return false;
	}
	// else we may be trying to regain some capture point from one of our structure.
	const capture = target.capturePoints();
	if (!capture)
	{
		return true;
	}
	for (let jIndex = 0; jIndex < capture.length; ++jIndex)
	{
		const j = playerId(jIndex);
		if (gameState.isPlayerEnemy(playerId(j)) && capture[j] !== 0)
		{
			return false;
		}
	}
	return true;
}

/** An army needing defenders: its land and the strength it lacks */
type ArmyNeed = { army: DefenseArmy; access: AccessIndex | undefined; need: number; };

/** Whether a unit of ours may defend: a fighter on the map, free, neither shipped, critical nor marching with an attack */
function mayDefend(gameState: CommonGameState, ent: CommonEntity): boolean
{
	if (!isPlaced(ent))
	{
		return false;
	}
	if (isLent(ent.getMetadata(PlayerID, "plan")))
	{
		return false;
	}
	if (ent.hasClass("Support") || ent.attackTypes() === undefined)
	{
		return false;
	}
	if (ent.hasClasses(["StoneThrower", "Support", "FishingBoat"]))
	{
		return false;
	}
	if (ent.getMetadata(PlayerID, "transport") !== undefined || ent.getMetadata(PlayerID, "transporter") !== undefined)
	{
		return false;
	}
	if (gameState.ai.HQ.victoryManager.criticalEnts.has(ent.id()))
	{
		return false;
	}
	return !marchesWithAttack(ent);
}

/** The nearest army needing defenders (on that land, if given) of which the unit can attack a foe */
function nearestArmyNeeding(
	gameState: CommonGameState,
	ent: CommonPlacedEntity,
	armiesNeeding: ArmyNeed[],
	access: AccessIndex | undefined,
): { aMin: number | undefined; distMin: number; }
{
	let aMin;
	let distMin = Infinity;
	for (let a = 0; a < armiesNeeding.length; ++a)
	{
		if (access && armiesNeeding[a].access !== access)
		{
			continue;
		}

		// Do not assign defender if it cannot attack at least part of the attacking army.
		if (
			!armiesNeeding[a].army.foeEntities.some((eEnt: EntityId): boolean =>
			{
				const eEntID = gameState.getEntityById(eEnt);
				if (!eEntID)
				{
					return false;
				}
				return ent.canAttackTarget(eEntID, allowCapture(gameState, ent, eEntID));
			})
		)
		{
			continue;
		}

		const dist = SquareVectorDistance(ent.position(), armiesNeeding[a].army.foePosition);
		if (aMin !== undefined && dist > distMin)
		{
			continue;
		}
		aMin = a;
		distMin = dist;
	}
	return { aMin, distMin };
}

/** Whether an animal fights one of our or our allies' entities */
function attacksAlly(gameState: CommonGameState, ent: CommonEntity): boolean
{
	if (!hasActivity(ent, "COMBAT"))
	{
		return false;
	}
	const orders = ordersOf(ent);
	if (!orders || !orders.length || !orders[0].target)
	{
		return false;
	}
	const target = gameState.getEntityById(orders[0].target);
	return !!target && gameState.isPlayerAlly(target.owner());
}

/**
 * Whether an attacked soldier keeps on with its task: fighting the attacker or a unit, or repairing a
 * defensive building; one capturing a structure calls the nearest fellow capturer to help.
 */
function keepsTask(
	gameState: CommonGameState,
	target: CommonPlacedEntity,
	attacker: CommonPlacedEntity,
	task: { ent: CommonEntity; id: EntityId; },
	allAttacked: Record<number, number>,
): boolean
{
	const currentTarget = task.ent;
	const orderId = task.id;
	const unitAIStateOrder = activityOf(unitState(target));
	if (
		unitAIStateOrder === "COMBAT" &&
		(currentTarget.id() === attacker.id() || !currentTarget.hasClasses(["Structure", "Support"]))
	)
	{
		return true;
	}
	if (unitAIStateOrder === "REPAIR" && currentTarget.hasDefensiveFire())
	{
		return true;
	}
	const capturableTarget = gameState.ai.HQ.capturableTargets.get(orderId);
	if (unitAIStateOrder === "COMBAT" && !isSiegeUnit(currentTarget) && capturableTarget)
	{
		// Take the nearest unit also attacking this structure to help us.
		capturableTarget.ents.delete(target.id());
		const minEnt = nearestFellowCapturer(gameState, capturableTarget.ents, attacker, orderId, allAttacked);
		if (minEnt)
		{
			capturableTarget.ents.delete(minEnt.id());
			minEnt.attack(attacker.id(), allowCapture(gameState, minEnt, attacker));
		}
	}
	return false;
}

/** Garrison an attacked siege ranged unit inside the nearest fortress. */
export function garrisonSiegeUnit(gameState: CommonGameState, unit: CommonPlacedEntity): boolean
{
	const garrisonManager = gameState.ai.HQ.garrisonManager;
	const nearest = nearestHolder(
		gameState,
		unit,
		(ent) => garrisonManager.numberOfGarrisonedSlots(ent) < ent.garrisonMax(),
	);
	if (nearest)
	{
		garrisonManager.garrison(gameState, unit, nearest, GarrisonManager.TYPE_PROTECTION);
	}
	return nearest !== undefined;
}

/** One of our soldiers was attacked by a unit: retaliate, or keep on with its task, calling a capturer to help */
function retaliate(
	gameState: CommonGameState,
	target: CommonPlacedEntity,
	attacker: CommonPlacedEntity,
	allAttacked: Record<number, number>,
): void
{
	// Consider whether we should retaliate or continue our task.
	if (target.hasClass("Support") || target.attackTypes() === undefined)
	{
		return;
	}
	const orderData = ordersOf(target);
	const orderId = orderData.length ? orderData[0].target : undefined;
	const currentTarget = orderId ? gameState.getEntityById(orderId) : undefined;
	if (
		currentTarget && orderId !== undefined &&
		keepsTask(gameState, target, attacker, { ent: currentTarget, id: orderId }, allAttacked)
	)
	{
		return;
	}
	const shouldCapture = allowCapture(gameState, target, attacker);
	if (target.canAttackTarget(attacker, shouldCapture))
	{
		target.attack(attacker.id(), shouldCapture);
	}
}

export class DefenseManager
{
	Config: Config;
	armies: DefenseArmy[];
	armyMergeSize: number;
	attackedAllies: Record<number, number>;
	attackingArmies: Record<number, Record<number, number>>;
	attackingUnits: Record<number, Record<number, number> | undefined>;
	targetList: EntityId[];
	/** The headquarters' map of the world: the territory map is the turn's own */
	geography: Geography;

	constructor(Config: Config, geography: Geography)
	{
		this.geography = geography;
		// Array of "army" Objects.
		this.armies = [];
		this.Config = Config;
		this.targetList = [];
		this.armyMergeSize = this.Config.Defense.armyMergeSize;
		// Stats on how many enemies are currently attacking our allies
		// this.attackingArmies[enemy][ally] = number of enemy armies inside allied territory
		// this.attackingUnits[enemy][ally] = number of enemy units not in armies inside allied territory
		// this.attackedAllies[ally] = number of enemies attacking the ally
		this.attackingArmies = {};
		this.attackingUnits = {};
		this.attackedAllies = {};
	}

	update(gameState: CommonGameState, events: DefenseManagerEvents): void
	{
		Engine.ProfileStart("Defense Manager");

		Engine.ProfileStart("defense checkEvents");
		this.checkEvents(gameState, events);
		Engine.ProfileStop();

		// Check if our potential targets are still valid.
		for (let i = 0; i < this.targetList.length; ++i)
		{
			const target = gameState.getEntityById(this.targetList[i]);
			if (!target || !isPlaced(target) || !gameState.isPlayerEnemy(target.owner()))
			{
				this.targetList.splice(i--, 1);
			}
		}

		// Count the number of enemies attacking our allies in the previous turn.
		// We'll be more cooperative if several enemies are attacking him simultaneously.
		this.attackedAllies = {};
		const attackingArmies = clone(this.attackingArmies);
		for (const enemy in this.attackingUnits)
		{
			if (!this.attackingUnits[enemy])
			{
				continue;
			}
			for (const ally in this.attackingUnits[enemy])
			{
				if (this.attackingUnits[enemy][ally] < 8)
				{
					continue;
				}
				if (attackingArmies[enemy] === undefined)
				{
					attackingArmies[enemy] = {};
				}
				if (attackingArmies[enemy][ally] === undefined)
				{
					attackingArmies[enemy][ally] = 0;
				}
				attackingArmies[enemy][ally] += 1;
			}
		}
		for (const enemy in attackingArmies)
		{
			for (const ally in attackingArmies[enemy])
			{
				if (this.attackedAllies[ally] === undefined)
				{
					this.attackedAllies[ally] = 0;
				}
				this.attackedAllies[ally] += 1;
			}
		}
		Engine.ProfileStart("defense checkEnemyArmies");
		this.checkEnemyArmies(gameState);
		Engine.ProfileStop();
		Engine.ProfileStart("defense checkEnemyUnits");
		this.checkEnemyUnits(gameState);
		Engine.ProfileStop();
		Engine.ProfileStart("defense assignDefenders");
		this.assignDefenders(gameState);
		Engine.ProfileStop();

		Engine.ProfileStop();
	}

	makeIntoArmy(gameState: CommonGameState, entityID: EntityId, type: string = "default"): void
	{
		if (type === "default")
		{
			for (const army of this.armies)
			{
				if (army.getType() === type && army.addFoe(gameState, entityID))
				{
					return;
				}
			}
		}

		this.armies.push(new DefenseArmy(gameState, [entityID], type));
	}

	getArmy(partOfArmy: ArmyId): DefenseArmy | undefined
	{
		return this.armies.find((army: DefenseArmy): boolean => army.ID === partOfArmy);
	}

	isDangerous(gameState: CommonGameState, entity: CommonEntity): boolean
	{
		if (!isPlaced(entity))
		{
			return false;
		}

		const territoryOwner = this.geography.territoryMap.getOwner(entity.position());
		if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
		{
			return false;
		}
		// Check if the entity is trying to build a new base near our buildings,
		// and if yes, add this base in our target list.
		if (
			isInState(entity, "INDIVIDUAL.REPAIR.REPAIRING") && this.buildsBaseNearUs(gameState, entity, territoryOwner)
		)
		{
			return true;
		}

		const attackTypes = entity.attackTypes();
		if (attackTypes === undefined || entity.hasClass("Support"))
		{
			return false;
		}
		const dist2Min = threatRadius2(entity, attackTypes);
		if (
			this.nearTargetList(gameState, entity, dist2Min) || this.nearAllyCivCentre(gameState, entity, dist2Min) ||
			this.nearOwnBuilding(gameState, entity, dist2Min)
		)
		{
			return true;
		}

		return gameState.isPlayerMutualAlly(territoryOwner) &&
			this.threatensAlly(gameState, entity, territoryOwner, dist2Min);
	}

	/**
	 * Whether a repairing entity builds an enemy structure in our territory or an enemy civic centre near our
	 * buildings: that foundation joins our targets.
	 */
	private buildsBaseNearUs(gameState: CommonGameState, entity: CommonPlacedEntity, territoryOwner: PlayerId): boolean
	{
		const targetId = ordersOf(entity)[0].target;
		if (targetId === undefined)
		{
			return false;
		}
		if (this.targetList.indexOf(targetId) !== -1)
		{
			return true;
		}
		const target = gameState.getEntityById(targetId);
		if (!target)
		{
			return false;
		}
		const isTargetEnemy = gameState.isPlayerEnemy(target.owner());
		if (isTargetEnemy && territoryOwner === PlayerID)
		{
			if (target.hasClass("Structure"))
			{
				this.targetList.push(targetId);
			}
			return true;
		}
		if (!isTargetEnemy || !target.hasClass("CivCentre"))
		{
			return false;
		}
		const myBuildings = gameState.getOwnStructures();
		for (const building of myBuildings.values())
		{
			if (building.foundationProgress() === 0)
			{
				continue;
			}
			if (SquareVectorDistance(building.position(), entity.position()) > 30000)
			{
				continue;
			}
			this.targetList.push(targetId);
			return true;
		}
		return false;
	}

	/** Whether the entity is within dist2Min of one of our buildings, not on a blinking tile or defendable */
	private nearOwnBuilding(gameState: CommonGameState, entity: CommonPlacedEntity, dist2Min: number): boolean
	{
		for (const building of gameState.getOwnStructures().values())
		{
			if (
				building.foundationProgress() === 0 ||
				SquareVectorDistance(building.position(), entity.position()) > dist2Min
			)
			{
				continue;
			}
			if (!this.geography.territoryMap.isBlinking(building.position()) || gameState.ai.HQ.isDefendable(building))
			{
				return true;
			}
		}
		return false;
	}

	/** Whether the entity is within dist2Min of an enemy base we target */
	private nearTargetList(gameState: CommonGameState, entity: CommonPlacedEntity, dist2Min: number): boolean
	{
		for (const targetId of this.targetList)
		{
			const target = gameState.getEntityById(targetId);
			// The enemy base is either destroyed or built.
			if (!target || !isPlaced(target))
			{
				continue;
			}
			if (SquareVectorDistance(target.position(), entity.position()) < dist2Min)
			{
				return true;
			}
		}
		return false;
	}

	/** Whether the entity is within dist2Min of a civic centre of an ally we cooperate with enough */
	private nearAllyCivCentre(gameState: CommonGameState, entity: CommonPlacedEntity, dist2Min: number): boolean
	{
		const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
		for (const cc of ccEnts.values())
		{
			if (!isPlaced(cc) || !gameState.isEntityExclusiveAlly(cc) || cc.foundationProgress() === 0)
			{
				continue;
			}
			const cooperation = this.GetCooperationLevel(cc.owner());
			if (cooperation < 0.3 || cooperation < 0.6 && !!cc.foundationProgress())
			{
				continue;
			}
			if (SquareVectorDistance(cc.position(), entity.position()) < dist2Min)
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * In a mutual ally's territory: whether the entity is near a building of that ally attacked by more than
	 * 2 enemies (we help it not only for cc but also for structures); if not, it counts as attacking the ally.
	 */
	private threatensAlly(
		gameState: CommonGameState,
		entity: CommonPlacedEntity,
		territoryOwner: PlayerId,
		dist2Min: number,
	): boolean
	{
		if (
			territoryOwner !== PlayerID && this.attackedAllies[territoryOwner] &&
			this.attackedAllies[territoryOwner] > 1 &&
			this.GetCooperationLevel(territoryOwner) > 0.7
		)
		{
			for (const building of gameState.getAllyStructures(territoryOwner).values())
			{
				if (
					building.foundationProgress() === 0 ||
					SquareVectorDistance(building.position(), entity.position()) > dist2Min
				)
				{
					continue;
				}
				if (!this.geography.territoryMap.isBlinking(building.position()))
				{
					return true;
				}
			}
		}

		// Update the number of enemies attacking this ally.
		const enemy = entity.owner();
		if (this.attackingUnits[enemy] === undefined)
		{
			this.attackingUnits[enemy] = {};
		}
		if (this.attackingUnits[enemy][territoryOwner] === undefined)
		{
			this.attackingUnits[enemy][territoryOwner] = 0;
		}
		this.attackingUnits[enemy][territoryOwner] += 1;
		return false;
	}

	checkEnemyUnits(gameState: CommonGameState): void
	{
		const nbPlayers = gameState.sharedScript.playersData.length;
		const i = playerId(gameState.ai.playedTurn % nbPlayers);
		this.attackingUnits[i] = undefined;

		if (i === PlayerID)
		{
			if (!this.armies.length)
			{
				this.recoverCapturePoints(gameState);
			}
			return;
		}
		else if (!gameState.isPlayerEnemy(i))
		{
			return;
		}

		for (const ent of gameState.getEnemyUnits(i).values())
		{
			if (ent.getMetadata(PlayerID, "PartOfArmy") !== undefined)
			{
				continue;
			}

			// Keep animals attacking us or our allies.
			if (ent.hasClass("Animal") && !attacksAlly(gameState, ent))
			{
				continue;
			}

			// TODO what to do for ships ?
			if (ent.hasClasses(["Ship", "Trader"]))
			{
				continue;
			}

			// Check if unit is dangerous "a priori".
			if (this.isDangerous(gameState, ent))
			{
				this.makeIntoArmy(gameState, ent.id());
			}
		}

		if (i === 0 && this.armies.length <= 1 && gameState.ai.HQ.basesManager.hasActiveBase())
		{
			this.captureGaiaStructures(gameState);
		}
	}

	/**
	 * Look for possible gaia buildings inside our territory (may happen when enemy resign or after structure decay)
	 * and attack it only if useful (and capturable) or dangereous.
	 */
	private captureGaiaStructures(gameState: CommonGameState): void
	{
		for (const ent of gameState.getEnemyStructures(GAIA).values())
		{
			if (ent.getMetadata(PlayerID, "PartOfArmy") !== undefined)
			{
				continue;
			}
			if (!ent.capturePoints() && !ent.hasDefensiveFire())
			{
				continue;
			}
			const owner = this.geography.territoryMap.getOwner(ent.position());
			if (owner === PlayerID)
			{
				this.makeIntoArmy(gameState, ent.id(), "capturing");
			}
		}
	}

	/** Check if we can recover capture points from any of our notdecaying structures. */
	private recoverCapturePoints(gameState: CommonGameState): void
	{
		for (const ent of gameState.getOwnStructures().values())
		{
			if (ent.decaying())
			{
				continue;
			}
			const capture = ent.capturePoints();
			if (capture === undefined)
			{
				continue;
			}
			let lost = 0;
			for (let j = 0; j < capture.length; ++j)
			{
				if (gameState.isPlayerEnemy(playerId(j)))
				{
					lost += capture[j];
				}
			}
			if (lost < Math.ceil(0.25 * capture[PlayerID]))
			{
				continue;
			}
			this.makeIntoArmy(gameState, ent.id(), "capturing");
			break;
		}
	}

	checkEnemyArmies(gameState: CommonGameState): void
	{
		for (let i = 0; i < this.armies.length; ++i)
		{
			const army = this.armies[i];
			// This returns a list of IDs: the units that broke away from the army for being too far.
			const breakaways = army.update(gameState);
			// Assume dangerosity.
			for (const breaker of breakaways)
			{
				this.makeIntoArmy(gameState, breaker);
			}

			if (army.getState() === 0)
			{
				if (army.getType() === "default")
				{
					this.switchToAttack(gameState, army);
				}
				army.clear(gameState);
				this.armies.splice(i--, 1);
			}
		}
		this.mergeArmies(gameState);

		if (gameState.ai.playedTurn % 5 !== 0)
		{
			return;
		}
		// Check if any army is no more dangerous (possibly because it has defeated us and destroyed our base).
		this.attackingArmies = {};
		for (let i = 0; i < this.armies.length; ++i)
		{
			const army = this.armies[i];
			army.recalculatePosition(gameState);
			const owner = this.geography.territoryMap.getOwner(army.foePosition);
			if (!gameState.isPlayerEnemy(owner))
			{
				if (gameState.isPlayerMutualAlly(owner))
				{
					this.countArmyAttackingAlly(gameState, army, owner);
				}
				continue;
			}
			// Enemy army back in its territory.
			else if (owner !== 0)
			{
				army.clear(gameState);
				this.armies.splice(i--, 1);
				continue;
			}

			// Army in neutral territory.
			if (this.stillDangerous(gameState, army))
			{
				continue;
			}

			if (army.getType() === "default")
			{
				this.switchToAttack(gameState, army);
			}
			army.clear(gameState);
			this.armies.splice(i--, 1);
		}
	}

	/** Check if we can't merge a default army with another near it. */
	private mergeArmies(gameState: CommonGameState): void
	{
		for (let i = 0; i < this.armies.length - 1; ++i)
		{
			const army = this.armies[i];
			if (army.getType() !== "default")
			{
				continue;
			}
			for (let j = i + 1; j < this.armies.length; ++j)
			{
				const otherArmy = this.armies[j];
				if (
					otherArmy.getType() !== "default" ||
					SquareVectorDistance(army.foePosition, otherArmy.foePosition) > this.armyMergeSize
				)
				{
					continue;
				}
				// No need to clear here.
				army.merge(gameState, otherArmy);
				this.armies.splice(j--, 1);
			}
		}
	}

	/** Update the number of enemies attacking this ally: the army counts once, for its first foe's owner. */
	private countArmyAttackingAlly(gameState: CommonGameState, army: DefenseArmy, owner: PlayerId): void
	{
		for (const id of army.foeEntities)
		{
			const ent = gameState.getEntityById(id);
			if (!ent)
			{
				continue;
			}
			const enemy = ent.owner();
			if (this.attackingArmies[enemy] === undefined)
			{
				this.attackingArmies[enemy] = {};
			}
			if (this.attackingArmies[enemy][owner] === undefined)
			{
				this.attackingArmies[enemy][owner] = 0;
			}
			this.attackingArmies[enemy][owner] += 1;
			return;
		}
	}

	/**
	 * Whether an army in neutral territory is still near one of our or our allies' civic centres, or our docks
	 * (because of oversea bases).
	 * TODO check smaller distance with all our buildings instead of only ccs with big distance.
	 */
	private stillDangerous(gameState: CommonGameState, army: DefenseArmy): boolean
	{
		const bases = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
		for (const base of bases.values())
		{
			if (!isPlaced(base) || !gameState.isEntityAlly(base))
			{
				continue;
			}
			const cooperation = this.GetCooperationLevel(base.owner());
			if (cooperation < 0.3 && !gameState.isEntityOwn(base))
			{
				continue;
			}
			if (SquareVectorDistance(base.position(), army.foePosition) > 40000)
			{
				continue;
			}
			debugWarn(this.Config, 1, () => "army in neutral territory, but still near one of our CC");
			return true;
		}
		for (const dock of gameState.getOwnStructures().filter(filters.byClass("Dock")).values())
		{
			if (!(SquareVectorDistance(dock.position(), army.foePosition) > 10000))
			{
				return true;
			}
		}
		return false;
	}

	assignDefenders(gameState: CommonGameState): void
	{
		if (!this.armies.length)
		{
			return;
		}

		const armiesNeeding = this.armiesNeedingDefenders(gameState);
		if (!armiesNeeding.length)
		{
			return;
		}

		// Let's get our potential units.
		const potentialDefenders: Array<EntityId | undefined> = [];
		gameState.getOwnUnits().forEach(function(ent: CommonEntity): void
		{
			if (mayDefend(gameState, ent))
			{
				potentialDefenders.push(ent.id());
			}
		});

		// First pass only assign defenders with the right access.
		// Second pass assign all defenders.
		// TODO could sort them by distance.
		for (let ipass = 0; ipass < 2; ++ipass)
		{
			if (this.assignDefendersPass(gameState, potentialDefenders, armiesNeeding, ipass === 0))
			{
				return;
			}
		}

		// If shortage of defenders, produce infantry garrisoned in nearest civil center.
		const armiesPos = [];
		for (let a = 0; a < armiesNeeding.length; ++a)
		{
			armiesPos.push(armiesNeeding[a].army.foePosition);
		}
		gameState.ai.HQ.trainEmergencyUnits(gameState, armiesPos);
	}

	/** The armies that need defenders, with their land and the strength they lack */
	private armiesNeedingDefenders(gameState: CommonGameState): ArmyNeed[]
	{
		const armiesNeeding: ArmyNeed[] = [];
		// Let's add defenders.
		for (const army of this.armies)
		{
			const needsDef = army.needsDefenders(gameState);
			if (needsDef === false)
			{
				continue;
			}

			let armyAccess;
			for (const entId of army.foeEntities)
			{
				const ent = gameState.getEntityById(entId);
				if (!ent || !isPlaced(ent))
				{
					continue;
				}
				armyAccess = getLandAccess(gameState, ent);
				break;
			}
			if (!armyAccess)
			{
				aiWarn(" Petra error: attacking army " + army.ID + " without access");
			}
			army.recalculatePosition(gameState);
			armiesNeeding.push({ army: army, access: armyAccess, need: needsDef });
		}
		return armiesNeeding;
	}

	/**
	 * Each potential defender joins the nearest army needing it (on its own land if sameLand), some troops kept
	 * in backup; returns true once no army needs more.
	 */
	private assignDefendersPass(
		gameState: CommonGameState,
		potentialDefenders: Array<EntityId | undefined>,
		armiesNeeding: ArmyNeed[],
		sameLand: boolean,
	): boolean
	{
		let backup = 0;
		for (let i = 0; i < potentialDefenders.length; ++i)
		{
			const defId = potentialDefenders[i];
			if (defId === undefined)
			{
				continue;
			}
			const ent = gameState.getEntityById(defId);
			if (!ent || !isPlaced(ent))
			{
				continue;
			}
			const access = sameLand ? getLandAccess(gameState, ent) : undefined;
			const { aMin, distMin } = nearestArmyNeeding(gameState, ent, armiesNeeding, access);

			// If outside our territory (helping an ally or attacking a cc foundation)
			// or if in another access, keep some troops in backup.
			if (
				backup < 12 &&
				(aMin === undefined ||
					distMin > 40000 &&
						this.geography.territoryMap.getOwner(armiesNeeding[aMin].army.foePosition) !== PlayerID)
			)
			{
				++backup;
				potentialDefenders[i] = undefined;
				continue;
			}
			else if (aMin === undefined)
			{
				continue;
			}

			armiesNeeding[aMin].need -= getMaxStrength(ent, this.Config.debug, this.Config.DamageTypeImportance);
			armiesNeeding[aMin].army.addOwn(gameState, defId);
			armiesNeeding[aMin].army.assignUnit(gameState, defId);
			potentialDefenders[i] = undefined;

			if (armiesNeeding[aMin].need <= 0)
			{
				armiesNeeding.splice(aMin, 1);
			}
			if (!armiesNeeding.length)
			{
				return true;
			}
		}
		return false;
	}

	abortArmy(gameState: CommonGameState, army: DefenseArmy): void
	{
		army.clear(gameState);
		for (let i = 0; i < this.armies.length; ++i)
		{
			if (this.armies[i].ID !== army.ID)
			{
				continue;
			}
			this.armies.splice(i, 1);
			break;
		}
	}

	/** checkEvents: our units and buildings attacked. */
	onAttacked(gameState: CommonGameState, events: DefenseManagerEvents, allAttacked: Record<number, number>): void
	{
		for (const evt of events.Attacked)
		{
			const target = gameState.getEntityById(evt.target);
			if (!target || !isPlaced(target))
			{
				continue;
			}

			const attacker = gameState.getEntityById(evt.attacker);
			if (attacker && gameState.isEntityOwn(attacker))
			{
				this.garrisonToShoot(gameState, attacker, target);
			}

			if (!gameState.isEntityOwn(target))
			{
				continue;
			}

			// If attacked by one of our allies (he must trying to recover capture points), do not react.
			if (attacker && gameState.isEntityAlly(attacker))
			{
				continue;
			}

			this.onOwnAttacked(gameState, target, attacker, allAttacked);
		}
	}

	/**
	 * If enemies are in range of one of our defensive structures, garrison it for arrow multiplier
	 * (enemy non-defensive structure are not considered to stay in sync with garrisonManager).
	 */
	private garrisonToShoot(gameState: CommonGameState, attacker: CommonEntity, target: CommonPlacedEntity): void
	{
		if (
			!gameState.isEntityEnemy(target) || attacker.hasClass("Ship") ||
			target.hasClass("Structure") && !target.attackRange("Ranged")
		)
		{
			return;
		}
		if (
			isPlaced(attacker) && attacker.isGarrisonHolder() && attacker.getArrowMultiplier() &&
			(target.owner() !== 0 || !target.hasClass("Unit") || hasActivity(target, "COMBAT"))
		)
		{
			this.garrisonUnitsInside(gameState, attacker, { attacker: target });
		}
	}

	/** One of our entities attacked by an enemy (or by something gone) */
	private onOwnAttacked(
		gameState: CommonGameState,
		target: CommonPlacedEntity,
		attacker: CommonEntity | undefined,
		allAttacked: Record<number, number>,
	): void
	{
		if (attacker && isPlaced(attacker) && target.hasClass("FishingBoat"))
		{
			if (target.isIdle() || hasActivity(target, "GATHER"))
			{
				fleeFrom(target, attacker);
			}
			return;
		}

		// TODO integrate other ships later, need to be sure it is accessible.
		if (target.hasClass("Ship"))
		{
			return;
		}

		// If a building on a blinking tile is attacked, check if it can be defended.
		// Same thing for a building in an isolated base (not connected to a base with anchor).
		if (target.hasClass("Structure") && this.isIndefensible(gameState, target))
		{
			destroyBeforeCapture(target);
			return;
		}

		// If inside a started attack plan, let the plan deal with this unit.
		const plan = target.getMetadata(PlayerID, "plan");
		if (plan !== undefined && plan >= 0)
		{
			const attack = gameState.ai.HQ.attackManager.getPlan(plan);
			if (attack && attack.state !== AttackPlan.STATE_UNEXECUTED)
			{
				return;
			}
		}

		this.defendAgainst(gameState, target, attacker, plan, allAttacked);
	}

	/** One of our entities attacked out of any started attack: the attacker is signalled, the target reacts */
	private defendAgainst(
		gameState: CommonGameState,
		target: CommonPlacedEntity,
		attacker: CommonEntity | undefined,
		plan: UnitPlan | undefined,
		allAttacked: Record<number, number>,
	): void
	{
		// Signal this attacker to our defense manager, except if we are in enemy territory.
		// TODO treat ship attack.
		if (
			attacker && isPlaced(attacker) && attacker.getMetadata(PlayerID, "PartOfArmy") === undefined &&
			!attacker.hasClasses(["Structure", "Ship"])
		)
		{
			const territoryOwner = this.geography.territoryMap.getOwner(attacker.position());
			if (territoryOwner === 0 || gameState.isPlayerAlly(territoryOwner))
			{
				this.makeIntoArmy(gameState, attacker.id());
			}
		}

		const partOfArmy = target.getMetadata(PlayerID, "PartOfArmy");
		if (partOfArmy !== undefined)
		{
			this.onArmyUnitAttacked(gameState, target, partOfArmy);
			return;
		}

		if (this.shelter(gameState, target, plan))
		{
			return;
		}

		if (!attacker || !isPlaced(attacker))
		{
			return;
		}

		if (target.isGarrisonHolder() && target.getArrowMultiplier())
		{
			this.garrisonUnitsInside(gameState, target, { attacker: attacker });
		}

		if (target.hasClass("Unit") && attacker.hasClass("Unit"))
		{
			retaliate(gameState, target, attacker, allAttacked);
		}
	}

	/** Whether a structure cannot be defended: on a blinking tile, or in a base not connected to a base with anchor */
	private isIndefensible(gameState: CommonGameState, target: CommonPlacedEntity): boolean
	{
		const baseId = target.getMetadata(PlayerID, "base");
		const base = baseId === undefined ? undefined : gameState.ai.HQ.basesManager.getBaseByID(baseId);
		return this.geography.territoryMap.isBlinking(target.position()) && !gameState.ai.HQ.isDefendable(target) ||
			!base || gameState.ai.HQ.basesManager.baseManagers.every((b: BaseManager): boolean =>
				!b.anchor || b.accessIndex !== base.accessIndex
			);
	}

	/**
	 * Try to garrison any attacked support unit if low health, and any attacked stone thrower;
	 * returns whether it was tried.
	 */
	private shelter(gameState: CommonGameState, target: CommonPlacedEntity, plan: UnitPlan | undefined): boolean
	{
		if (target.getMetadata(PlayerID, "transport") || isLent(plan))
		{
			return false;
		}
		if (target.hasClass("Support") && target.healthLevel() < this.Config.garrisonHealthLevel.medium)
		{
			this.garrisonAttackedUnit(gameState, target);
			return true;
		}
		if (target.hasClass("StoneThrower"))
		{
			garrisonSiegeUnit(gameState, target);
			return true;
		}
		return false;
	}

	/** One of our units in a defense army was attacked: a capturing army may give up its capture */
	onArmyUnitAttacked(gameState: CommonGameState, target: CommonEntity, partOfArmy: ArmyId): void
	{
		const army = this.getArmy(partOfArmy);
		if (army && army.getType() === "capturing" && abortsCapture(gameState, army, target))
		{
			this.abortArmy(gameState, army);
		}
	}

	/**
	 * If our defense structures are attacked, garrison soldiers inside when possible
	 * and if a support unit is attacked and has less than 55% health, garrison it inside the nearest healing structure
	 * and if a ranged siege unit (not used for defense) is attacked, garrison it in the nearest fortress.
	 * If our hero is attacked with regicide victory condition, the victoryManager will handle it.
	 */
	checkEvents(gameState: CommonGameState, events: DefenseManagerEvents): void
	{
		// Must be called every turn for all armies.
		for (const army of this.armies)
		{
			army.checkEvents(gameState, events);
		}

		// Capture events.
		for (const evt of events.OwnershipChanged)
		{
			if (gameState.isPlayerMutualAlly(evt.from) && evt.to > 0)
			{
				const ent = gameState.getEntityById(evt.entity);
				// One of our cc has been captured.
				if (ent && ent.hasClass("CivCentre"))
				{
					gameState.ai.HQ.attackManager.switchDefenseToAttack(gameState, ent, { range: 150 });
				}
			}
		}

		const allAttacked: Record<number, number> = {};
		for (const evt of events.Attacked)
		{
			allAttacked[evt.target] = evt.attacker;
		}

		this.onAttacked(gameState, events, allAttacked);
	}

	garrisonUnitsInside(
		gameState: CommonGameState,
		target: CommonPlacedEntity,
		data: { min?: number; type?: string; attacker?: CommonPlacedEntity; },
	): boolean
	{
		if (target.hitpoints() < target.garrisonEjectHealth() * target.maxHitpoints())
		{
			return false;
		}
		const minGarrison = data.min || target.garrisonMax();
		if (gameState.ai.HQ.garrisonManager.numberOfGarrisonedSlots(target) >= minGarrison)
		{
			return false;
		}
		if (data.attacker && !shootsAt(target, data.attacker))
		{
			return false;
		}
		const garrisonManager = gameState.ai.HQ.garrisonManager;
		const typeGarrison = data.type || GarrisonManager.TYPE_PROTECTION;
		let allowMelee = gameState.ai.HQ.garrisonManager.allowMelee(target);
		if (allowMelee === undefined)
		{
			// Should be kept in sync with garrisonManager to avoid garrisoning-ungarrisoning some units.
			if (data.attacker)
			{
				allowMelee = data.attacker.hasClass("Structure") ?
					!!data.attacker.attackRange("Ranged") :
					!isSiegeUnit(data.attacker);
			}
			else
			{
				allowMelee = true;
			}
		}
		const holder = {
			access: getLandAccess(gameState, target),
			arrowClasses: target.getGarrisonArrowClasses(),
			decay: typeGarrison === GarrisonManager.TYPE_DECAY,
			allowMelee,
		};
		const units = gameState.getOwnUnits().filter((ent) => this.mayGarrisonIn(gameState, ent, holder)).filterNearest(
			target.position(),
		);

		// No more than the holder holds: asked for more (a captured sentry tower
		// holds 3, and its decay needs 4 to stop), the loop took every soldier in
		// reach out of his attack plan on every turn, the tower refusing them, and
		// the attack manager made and dropped plan after plan (FINDINGS §50)
		const wanted = Math.min(minGarrison, target.garrisonMax());
		let ret = false;
		for (const ent of units.values())
		{
			if (garrisonManager.numberOfGarrisonedSlots(target) >= wanted)
			{
				break;
			}
			this.withdrawToGarrison(gameState, ent);
			garrisonManager.garrison(gameState, ent, target, typeGarrison);
			ret = true;
		}
		return ret;
	}

	/**
	 * Whether a unit of ours may garrison in a holder to add its arrows: on the holder's land, not melee unless
	 * allowed (or for a decaying structure), not shipped, lent only to an army, and not marching with an attack
	 * unless the holder decays (usually because we've just captured it in enemy territory).
	 */
	private mayGarrisonIn(
		gameState: CommonGameState,
		ent: CommonEntity,
		holder: { access: AccessIndex; arrowClasses: string[] | undefined; decay: boolean; allowMelee: boolean; },
	): boolean
	{
		const entAttackTypes = ent.attackTypes();
		if (!isPlaced(ent))
		{
			return false;
		}
		if (!ent.hasClasses(holder.arrowClasses))
		{
			return false;
		}
		if (!holder.decay && !holder.allowMelee && entAttackTypes && entAttackTypes.indexOf("Melee") !== -1)
		{
			return false;
		}
		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			return false;
		}
		const partOfArmy = ent.getMetadata(PlayerID, "PartOfArmy");
		const army = partOfArmy ? this.getArmy(partOfArmy) : undefined;
		const plan = ent.getMetadata(PlayerID, "plan");
		if (!army && isLent(plan))
		{
			return false;
		}
		if (plan !== undefined && plan >= 0 && !holder.decay && marchingSubrole(ent))
		{
			return false;
		}
		return getLandAccess(gameState, ent) === holder.access;
	}

	/** A unit going to garrison leaves its attack plan and its defense army */
	private withdrawToGarrison(gameState: CommonGameState, ent: CommonEntity): void
	{
		const plan = ent.getMetadata(PlayerID, "plan");
		if (plan !== undefined && plan >= 0)
		{
			const attackPlan = gameState.ai.HQ.attackManager.getPlan(plan);
			if (attackPlan)
			{
				attackPlan.removeUnit(ent, true);
			}
		}
		const partOfArmy = ent.getMetadata(PlayerID, "PartOfArmy");
		const army = partOfArmy ? this.getArmy(partOfArmy) : undefined;
		if (army)
		{
			army.removeOwn(gameState, ent.id());
		}
	}

	/**
	 * Garrison a hurt unit inside a player-owned or allied structure.
	 * If emergency is true, the unit will be garrisoned in the closest possible structure.
	 * Otherwise, it will garrison in the closest healing structure.
	 */
	garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency: boolean = false): boolean
	{
		const garrisonManager = gameState.ai.HQ.garrisonManager;
		const nearest = nearestHolder(
			gameState,
			unit,
			(ent) =>
				(emergency || !!ent.buffHeal()) &&
				(garrisonManager.numberOfGarrisonedSlots(ent) < ent.garrisonMax() ||
					emergency && ent.garrisoned().length > 0),
		);
		if (!nearest)
		{
			return false;
		}

		if (!emergency)
		{
			garrisonManager.garrison(gameState, unit, nearest, GarrisonManager.TYPE_PROTECTION);
			return true;
		}
		if (garrisonManager.numberOfGarrisonedSlots(nearest) >= nearest.garrisonMax())
		{ // make room for this ent
			nearest.unload(nearest.garrisoned()[0]);
		}

		garrisonManager.garrison(
			gameState,
			unit,
			nearest,
			nearest.buffHeal() ? GarrisonManager.TYPE_PROTECTION : GarrisonManager.TYPE_EMERGENCY,
		);
		return true;
	}

	/**
	 * Be more inclined to help an ally attacked by several enemies.
	 */
	GetCooperationLevel(ally: PlayerId): number
	{
		let cooperation = this.Config.personality.cooperative;
		if (this.attackedAllies[ally] && this.attackedAllies[ally] > 1)
		{
			cooperation += 0.2 * (this.attackedAllies[ally] - 1);
		}
		return cooperation;
	}

	/**
	 * Switch a defense army into an attack if needed.
	 */
	switchToAttack(gameState: CommonGameState, army: DefenseArmy): void
	{
		if (!army)
		{
			return;
		}
		for (const targetId of this.targetList)
		{
			const target = gameState.getEntityById(targetId);
			if (!target || !isPlaced(target) || !gameState.isPlayerEnemy(target.owner()))
			{
				continue;
			}
			const targetAccess = getLandAccess(gameState, target);
			const targetPos = target.position();
			for (const entId of army.ownEntities)
			{
				const ent = gameState.getEntityById(entId);
				if (!ent || !isPlaced(ent) || getLandAccess(gameState, ent) !== targetAccess)
				{
					continue;
				}
				if (SquareVectorDistance(targetPos, ent.position()) > 14400)
				{
					continue;
				}
				gameState.ai.HQ.attackManager.switchDefenseToAttack(gameState, target, {
					armyID: army.ID,
					uniqueTarget: true,
				});
				return;
			}
		}
	}

	Serialize(): SerializedDefenseManager
	{
		const properties = {
			targetList: this.targetList,
			armyMergeSize: this.armyMergeSize,
			attackingUnits: this.attackingUnits,
			attackingArmies: this.attackingArmies,
			attackedAllies: this.attackedAllies,
		};

		return { properties: properties, armies: this.armies.map((army) => army.Serialize()) };
	}

	/** A saved defense manager with its armies */
	static restore(
		Config: Config,
		gameState: CommonGameState,
		geography: Geography,
		data: SerializedDefenseManager,
	): DefenseManager
	{
		const manager = new DefenseManager(Config, geography);
		manager.resume(gameState, data);
		return manager;
	}

	private resume(gameState: CommonGameState, data: SerializedDefenseManager): void
	{
		const properties = data.properties;
		this.targetList = properties.targetList;
		this.armyMergeSize = properties.armyMergeSize;
		this.attackingUnits = properties.attackingUnits;
		this.attackingArmies = properties.attackingArmies;
		this.attackedAllies = properties.attackedAllies;

		this.armies = [];
		for (const dataArmy of data.armies)
		{
			this.armies.push(DefenseArmy.restore(gameState, dataArmy));
		}
	}
}
