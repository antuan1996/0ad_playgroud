import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { getLandAccess, isSiegeUnit, requireValue } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { counterBonuses, counteredBy } from "../adapter/templateData.ts";
import { isInState, requiredActivityIs } from "../adapter/unitState.ts";
import { allowCapture } from "../world/capture.ts";

/** What an attacker's orders are chosen from, worked out once a turn (AttackPlan.updateAttacking). */
export type AttackerContext = {
	time: GameSeconds;
	/** the plan's target and where it stands */
	target: CommonEntity;
	targetPos: CommonPosition;
	/** the enemy units enough of our attackers already aim at */
	veto: Record<string, boolean>;
	/** how many of our attackers aim at each enemy unit, less what it is worth */
	unitTargets: Record<number, number>;
	/** our units a structure hit this turn */
	attackedByStructure: Record<number, boolean>;
	enemyUnits: CommonEntityCollection;
	enemyStructures: CommonEntityCollection;
	targetClassesUnit: { attack: string[]; avoid: string[]; vetoEntities: Record<string, boolean>; };
	targetClassesSiege: { attack: string[]; avoid: string[]; vetoEntities: Record<string, boolean>; };
	unitCollection: CommonEntityCollection;
	isBlocked: boolean;
};

/** Where an attacker stands, how far it looks for its next target (squared), and its land */
type AttackerReach = { pos: CommonPosition; range: number; access: AccessIndex | undefined; };

/**
 * Whether one of the plan's units answers a blow: while completing, one bound for a ship, on the attacker's land
 * within answerRange of the unit hit; otherwise one bound for a ship still ashore on the attacker's land, or an idle one
 */
export function answersBlow(
	gameState: CommonGameState,
	ent: CommonEntity,
	completing: boolean,
	attackerLand: AccessIndex | undefined,
	near: { pos: CommonPosition | undefined; range: number; },
): boolean
{
	const pos = ent.position();
	if (completing)
	{
		return !(ent.getMetadata(PlayerID, "transport") === undefined || !pos || !near.pos ||
			getLandAccess(gameState, ent) !== attackerLand ||
			SquareVectorDistance(pos, near.pos) > near.range * near.range);
	}
	if (ent.getMetadata(PlayerID, "transport") !== undefined)
	{
		return !(!pos || getLandAccess(gameState, ent) !== attackerLand);
	}
	return !!ent.isIdle();
}

/** check for stuck siege units: the one farthest from the army is destroyed */
export function destroyFarthestSiege(units: CommonEntityCollection, pos: CommonPosition): void
{
	let farthest = 0;
	let farthestEnt;
	for (const ent of units.filter(filters.byClass("Siege")).values())
	{
		if (!isPlaced(ent))
		{
			continue;
		}
		const entPos = ent.position();
		const dist = SquareVectorDistance(entPos, pos);
		if (dist < farthest)
		{
			continue;
		}
		farthest = dist;
		farthestEnt = ent;
	}
	if (farthestEnt)
	{
		farthestEnt.destroy();
	}
}

/** The unit strikes back at the attacker if it can (capturing if worth it): whether it did */
function strike(gameState: CommonGameState, ent: CommonEntity, attacker: CommonEntity, time: GameSeconds): boolean
{
	const shouldCapture = allowCapture(gameState, ent, attacker);
	if (!ent.canAttackTarget(attacker, shouldCapture))
	{
		return false;
	}
	ent.attack(attacker.id(), shouldCapture);
	ent.setMetadata(PlayerID, "lastAttackPlanUpdateTime", time);
	return true;
}

/** Whether a unit already fights the attacker, or another unit that is neither a structure nor a support */
function busyFighting(gameState: CommonGameState, ent: CommonEntity, attacker: CommonEntity): boolean
{
	const orderData = ordersOf(ent);
	if (!orderData || !orderData.length || !orderData[0].target)
	{
		return false;
	}
	if (orderData[0].target === attacker.id())
	{
		return true;
	}
	const target = gameState.getEntityById(orderData[0].target);
	return !!target && !target.hasClasses(["Structure", "Support"]);
}

/**
 * Whether an attacker must change its target ("needs": gone, an ally's, or too many of ours on it), may
 * ("maybe": a siege engine on a unit; a land unit on a ship, on a field while a structure hits it, or a slow one
 * after a fleeing civilian), or keeps it
 */
function targetVerdict(
	gameState: CommonGameState,
	ent: CommonEntity,
	targetId: EntityId,
	unitTargets: Record<number, number>,
	attackedByStructure: Record<number, boolean>,
): "needs" | "maybe" | "keeps"
{
	const target = gameState.getEntityById(targetId);
	if (!target || gameState.isPlayerAlly(target.owner()))
	{
		return "needs";
	}
	if (unitTargets[targetId] && unitTargets[targetId] > 0)
	{
		--unitTargets[targetId];
		return "needs";
	}
	if (isSiegeUnit(ent))
	{
		return !target.hasClass("Structure") ? "maybe" : "keeps";
	}
	if (target.hasClass("Ship") && !ent.hasClass("Ship"))
	{
		return "maybe";
	}
	if (attackedByStructure[ent.id()] && target.hasClass("Field"))
	{
		return "maybe";
	}
	if (
		!ent.hasClass("FastMoving") && !ent.hasClass("Ranged") &&
		target.hasClass("Civilian") && requiredActivityIs(target, "FLEEING")
	)
	{
		return "maybe";
	}
	return "keeps";
}

/** A structure's worth as a target: its cost, a gate for wall breakers most, then defenses and conquest critical ones */
function structureValue(struct: CommonEntity, ent: CommonEntity, defensiveBonus: number, criticalBonus: number): number
{
	let val = struct.costSum();
	if (struct.hasClass("Gate") && ent.canAttackClass("Wall"))
	{
		val += 10000;
	}
	else if (defensiveBonus && struct.hasDefensiveFire())
	{
		val += defensiveBonus;
	}
	else if (struct.hasClass("ConquestCritical"))
	{
		val += criticalBonus;
	}
	return val;
}

/**
 * The enemy units in the attacker's reach on its land, but animals, fleeing civilians for a slow one, and those
 * too many of ours aim at while the target is far; each marked with its distance
 */
function enemyUnitsInReach(
	gameState: CommonGameState,
	ent: CommonEntity,
	reach: AttackerReach,
	ctx: AttackerContext,
): CommonEntity[]
{
	const { targetPos, veto, enemyUnits } = ctx;
	const nearby = !ent.hasClasses(["FastMoving", "Ranged"]);
	return enemyUnits.filter((enemy) =>
	{
		const enemyPos = enemy.position();
		if (!enemyPos || !ent.canAttackTarget(enemy, allowCapture(gameState, ent, enemy)))
		{
			return false;
		}
		if (enemy.hasClass("Animal"))
		{
			return false;
		}
		if (nearby && enemy.hasClass("Civilian") && requiredActivityIs(enemy, "FLEEING"))
		{
			return false;
		}
		const dist = SquareVectorDistance(enemyPos, reach.pos);
		if (dist > reach.range)
		{
			return false;
		}
		if (getLandAccess(gameState, enemy) !== reach.access)
		{
			return false;
		}
		// if already too much units targeting this enemy, let's continue towards our main target
		if (veto[enemy.id()] && SquareVectorDistance(targetPos, reach.pos) > 2500)
		{
			return false;
		}
		enemy.setMetadata(PlayerID, "distance", Math.sqrt(dist));
		return true;
	}).toEntityArray();
}

/** An attacker far from the target attack-moves on to it, against everything when it may be blocked by walls */
function marchOn(ent: CommonEntity, maybeUpdate: boolean, ctx: AttackerContext): void
{
	const { targetPos, veto, targetClassesUnit } = ctx;
	let targetClasses = targetClassesUnit;
	if (maybeUpdate && isInState(ent, "INDIVIDUAL.COMBAT.APPROACHING"))
	{ // we may be blocked by walls, attack everything
		if (!ent.hasClasses(["Ranged", "Ship"]))
		{
			targetClasses = { attack: ["Unit", "Structure"], avoid: ["Ship"], vetoEntities: veto };
		}
		else
		{
			targetClasses = { attack: ["Unit", "Structure"], avoid: [], vetoEntities: veto };
		}
	}
	else if (!ent.hasClasses(["Ranged", "Ship"]))
	{
		targetClasses = {
			attack: targetClassesUnit.attack,
			avoid: targetClassesUnit.avoid.concat("Ship"),
			vetoEntities: veto,
		};
	}
	ent.attackMove(targetPos[0], targetPos[1], targetClasses);
}

/** How often each enemy unit is targeted by ours, counted from -8 (siege, heroes), -5 (champions, ships) or -3 */
export function countUnitTargets(gameState: CommonGameState, units: CommonEntityCollection): Record<number, number>
{
	const unitTargets: Record<number, number> = {};
	for (const ent of units.values())
	{
		if (ent.hasClass("Ship"))
		{ // TODO What to do with ships
			continue;
		}
		const orderData = ordersOf(ent);
		if (!orderData || !orderData.length || !orderData[0].target)
		{
			continue;
		}
		const targetId = orderData[0].target;
		const target = gameState.getEntityById(targetId);
		if (!target || target.hasClass("Structure"))
		{
			continue;
		}
		if (!(targetId in unitTargets))
		{
			if (isSiegeUnit(target) || target.hasClass("Hero"))
			{
				unitTargets[targetId] = -8;
			}
			else if (target.hasClasses(["Champion", "Ship"]))
			{
				unitTargets[targetId] = -5;
			}
			else
			{
				unitTargets[targetId] = -3;
			}
		}
		++unitTargets[targetId];
	}
	return unitTargets;
}

/**
 * Our siege units attacked: we'll send some units to deal with enemies, and if this attacker is a non-ranged
 * siege unit and our unit also, attack it
 */
function defendSiege(
	gameState: CommonGameState,
	unitCollection: CommonEntityCollection,
	ourUnit: CommonPlacedEntity,
	attacker: CommonPlacedEntity,
	time: GameSeconds,
): void
{
	const collec = unitCollection.filter(filters.not(filters.byClass("Siege"))).filterNearest(ourUnit.position(), 5);
	for (const ent of collec.values())
	{
		if (isSiegeUnit(ent))
		{ // needed as mauryan elephants are not filtered out
			continue;
		}
		strike(gameState, ent, attacker, time);
	}
	if (
		isSiegeUnit(attacker) && attacker.hasClass("Melee") &&
		ourUnit.hasClass("Melee") && ourUnit.canAttackTarget(attacker, allowCapture(gameState, ourUnit, attacker))
	)
	{
		ourUnit.attack(attacker.id(), allowCapture(gameState, ourUnit, attacker));
		ourUnit.setMetadata(PlayerID, "lastAttackPlanUpdateTime", time);
	}
}

/**
 * Look first for nearby units to help us if possible; then the unit under attack: abandon its target
 * (if it was a structure or a support) and retaliate; also if our unit is attacking a range unit and the
 * attacker is a melee unit, retaliate
 */
function helpAndRetaliate(
	gameState: CommonGameState,
	unitCollection: CommonEntityCollection,
	ourUnit: CommonPlacedEntity,
	attacker: CommonPlacedEntity,
	time: GameSeconds,
): void
{
	const collec = unitCollection.filterNearest(ourUnit.position(), 2);
	for (const ent of collec.values())
	{
		const shouldCapture = allowCapture(gameState, ent, attacker);
		if (isSiegeUnit(ent) || !ent.canAttackTarget(attacker, shouldCapture))
		{
			continue;
		}
		if (busyFighting(gameState, ent, attacker))
		{
			continue;
		}
		ent.attack(attacker.id(), shouldCapture);
		ent.setMetadata(PlayerID, "lastAttackPlanUpdateTime", time);
	}
	const orderData = ordersOf(ourUnit);
	if (orderData && orderData.length && orderData[0].target)
	{
		if (orderData[0].target === attacker.id())
		{
			return;
		}
		const target = gameState.getEntityById(orderData[0].target);
		if (
			target && !target.hasClasses(["Structure", "Support"]) &&
			(!target.hasClass("Ranged") || !attacker.hasClass("Melee"))
		)
		{
			return;
		}
	}
	strike(gameState, ourUnit, attacker, time);
}

/**
 * Answers the blows of the turn on our attackers (a unit hit by a structure, or
 * by an enemy it can fight back), and returns the units a structure hit.
 */
export function answerAttackers(
	gameState: CommonGameState,
	events: EngineAIEvents,
	time: GameSeconds,
	unitCollection: CommonEntityCollection,
	isBlocked: boolean,
): Record<number, boolean>
{
	const attackedByStructure: Record<number, boolean> = {};
	for (const evt of events.Attacked)
	{
		if (!unitCollection.hasEntId(evt.target))
		{
			continue;
		}
		const attacker = gameState.getEntityById(evt.attacker);
		const ourUnit = gameState.getEntityById(evt.target);
		if (!ourUnit || !isPlaced(ourUnit) || !attacker || !isPlaced(attacker))
		{
			continue;
		}
		if (!attacker.hasClass("Unit"))
		{
			attackedByStructure[evt.target] = true;
			continue;
		}
		if (isSiegeUnit(ourUnit))
		{
			defendSiege(gameState, unitCollection, ourUnit, attacker, time);
		}
		else if (isBlocked && !ourUnit.hasClass("Ranged") && attacker.hasClass("Ranged"))
		{
			// do not react if our melee units are attacked by ranged one and we are blocked by walls
			// TODO check that the attacker is from behind the wall
			continue;
		}
		else if (isSiegeUnit(attacker))
		{ // if our unit is attacked by a siege unit, we'll send some melee units to help it.
			const collec = unitCollection.filter(filters.byClass("Melee")).filterNearest(ourUnit.position(), 5);
			for (const ent of collec.values())
			{
				strike(gameState, ent, attacker, time);
			}
		}
		else
		{
			helpAndRetaliate(gameState, unitCollection, ourUnit, attacker, time);
		}
	}
	return attackedByStructure;
}

/** What the attackers may go for this turn, and what they keep off, units and siege apart. */
export function attackerTargetClasses(
	type: string,
	target: CommonEntity,
	veto: Record<string, boolean>,
): Pick<AttackerContext, "targetClassesUnit" | "targetClassesSiege">
{
	let targetClassesUnit;
	let targetClassesSiege: { attack: string[]; avoid: string[]; vetoEntities: Record<string, boolean>; };
	if (type === "Rush")
	{
		targetClassesUnit = {
			attack: ["Unit", "Structure"],
			avoid: ["Palisade", "Wall", "Tower", "Fortress"],
			vetoEntities: veto,
		};
	}
	else
	{
		if (target.hasClass("Fortress"))
		{
			targetClassesUnit = { attack: ["Unit", "Structure"], avoid: ["Palisade", "Wall"], vetoEntities: veto };
		}
		else if (target.hasClasses(["Palisade", "Wall"]))
		{
			targetClassesUnit = { attack: ["Unit", "Structure"], avoid: ["Fortress"], vetoEntities: veto };
		}
		else
		{
			targetClassesUnit = {
				attack: ["Unit", "Structure"],
				avoid: ["Palisade", "Wall", "Fortress"],
				vetoEntities: veto,
			};
		}
	}
	if (target.hasClass("Structure"))
	{
		targetClassesSiege = { attack: ["Structure"], avoid: [], vetoEntities: veto };
	}
	else
	{
		targetClassesSiege = { attack: ["Unit", "Structure"], avoid: [], vetoEntities: veto };
	}

	// do not loose time destroying buildings which do not help enemy's defense and can be easily captured later
	if (target.hasDefensiveFire())
	{
		targetClassesUnit.avoid = targetClassesUnit.avoid.concat("House", "Storehouse", "Farmstead", "Field", "Forge");
		targetClassesSiege.avoid = targetClassesSiege.avoid.concat(
			"House",
			"Storehouse",
			"Farmstead",
			"Field",
			"Forge",
		);
	}
	return { targetClassesUnit, targetClassesSiege };
}

/**
 * Whether an attacker gets a new order this turn: undefined to leave it (busy
 * as it should be, or looked at too recently), else whether it must have one
 * (idle, its target gone or too many on it) or only may.
 */
function attackerNeedsOrder(
	gameState: CommonGameState,
	ent: CommonEntity,
	ctx: AttackerContext,
): { needsUpdate: boolean; maybeUpdate: boolean; } | undefined
{
	const { time, unitTargets, attackedByStructure } = ctx;
	// Do not reassign units which have reacted to an attack in that same turn
	if (ent.getMetadata(PlayerID, "lastAttackPlanUpdateTime") === time)
	{
		return undefined;
	}

	let targetId;
	const orderData = ordersOf(ent);
	if (orderData && orderData.length && orderData[0].target)
	{
		targetId = orderData[0].target;
	}

	// update the order if needed
	let needsUpdate = false;
	let maybeUpdate = false;
	if (ent.isIdle())
	{
		needsUpdate = true;
	}
	else if (targetId)
	{
		const verdict = targetVerdict(gameState, ent, targetId, unitTargets, attackedByStructure);
		needsUpdate = verdict === "needs";
		maybeUpdate = verdict === "maybe";
	}

	// don't update too soon if not necessary
	if (!needsUpdate)
	{
		if (!maybeUpdate)
		{
			return undefined;
		}
		const deltat = isInState(ent, "INDIVIDUAL.COMBAT.APPROACHING") ? 10 : 5;
		const lastAttackPlanUpdateTime = ent.getMetadata(PlayerID, "lastAttackPlanUpdateTime");
		if (lastAttackPlanUpdateTime && time - lastAttackPlanUpdateTime < deltat)
		{
			return undefined;
		}
	}
	ent.setMetadata(PlayerID, "lastAttackPlanUpdateTime", time);
	return { needsUpdate, maybeUpdate };
}

/** How far an attacker looks for its next target, squared. */
function attackerReach(ent: CommonEntity, isBlocked: boolean): number
{
	let range = 60;
	const attackTypes = ent.attackTypes();
	if (isBlocked)
	{
		if (attackTypes && attackTypes.indexOf("Ranged") !== -1)
		{
			range = (ent.attackRange("Ranged") || { max: 0 }).max;
		}
		else if (attackTypes && attackTypes.indexOf("Melee") !== -1)
		{
			range = (ent.attackRange("Melee") || { max: 0 }).max;
		}
		else
		{
			range = 10;
		}
	}
	else if (attackTypes && attackTypes.indexOf("Ranged") !== -1)
	{
		range = 30 + (ent.attackRange("Ranged") || { max: 0 }).max;
	}
	else if (ent.hasClass("FastMoving"))
	{
		range += 30;
	}
	range *= range;
	// Checking for gates if we're a siege unit.
	return range;
}

/** A siege engine's next target: a gate, a defensive building, else what the siege classes allow. */
function orderSiegeAttacker(
	gameState: CommonGameState,
	ent: CommonEntity,
	reach: AttackerReach,
	ctx: AttackerContext,
): void
{
	const { targetPos, veto, enemyStructures, targetClassesSiege } = ctx;
	const mStruct = enemyStructures.filter((enemy) =>
	{
		const enemyPos = enemy.position();
		if (!enemyPos || !ent.canAttackTarget(enemy, allowCapture(gameState, ent, enemy)))
		{
			return false;
		}
		if (SquareVectorDistance(enemyPos, reach.pos) > reach.range)
		{
			return false;
		}
		if (enemy.foundationProgress() === 0)
		{
			return false;
		}
		if (getLandAccess(gameState, enemy) !== reach.access)
		{
			return false;
		}
		return true;
	}).toEntityArray();
	if (mStruct.length)
	{
		mStruct.sort((structa: CommonEntity, structb: CommonEntity): number =>
			structureValue(structb, ent, 1000, 200) - structureValue(structa, ent, 1000, 200)
		);
		if (mStruct[0].hasClass("Gate"))
		{
			ent.attack(mStruct[0].id(), allowCapture(gameState, ent, mStruct[0]));
		}
		else
		{
			const rand = randIntExclusive(0, mStruct.length * 0.2);
			ent.attack(mStruct[rand].id(), allowCapture(gameState, ent, mStruct[rand]));
		}
	}
	else if (!ent.hasClass("Ranged"))
	{
		const targetClasses = {
			attack: targetClassesSiege.attack,
			avoid: targetClassesSiege.avoid.concat("Ship"),
			vetoEntities: veto,
		};
		ent.attackMove(targetPos[0], targetPos[1], targetClasses);
	}
	else
	{
		ent.attackMove(targetPos[0], targetPos[1], targetClassesSiege);
	}
}

/** The attacker goes for a structure in reach (only the target when blocked), a gate first; whether there is one */
function attackStructureInReach(
	gameState: CommonGameState,
	ent: CommonEntity,
	reach: AttackerReach,
	ctx: AttackerContext,
): boolean
{
	const { target, enemyStructures, isBlocked } = ctx;
	const mStruct = enemyStructures.filter((enemy) =>
	{
		if (isBlocked && enemy.id() !== target.id())
		{
			return false;
		}
		const enemyPos = enemy.position();
		if (!enemyPos || !ent.canAttackTarget(enemy, allowCapture(gameState, ent, enemy)))
		{
			return false;
		}
		if (SquareVectorDistance(enemyPos, reach.pos) > reach.range)
		{
			return false;
		}
		if (getLandAccess(gameState, enemy) !== reach.access)
		{
			return false;
		}
		return true;
	}).toEntityArray();
	if (!mStruct.length)
	{
		return false;
	}
	mStruct.sort((structa: CommonEntity, structb: CommonEntity): number =>
		structureValue(structb, ent, 0, 100) - structureValue(structa, ent, 0, 100)
	);
	if (mStruct[0].hasClass("Gate"))
	{
		ent.attack(mStruct[0].id(), false);
	}
	else
	{
		const rand = randIntExclusive(0, mStruct.length * 0.2);
		ent.attack(mStruct[rand].id(), allowCapture(gameState, ent, mStruct[rand]));
	}
	return true;
}

/** The attacker joins the fight of the nearest of our units fighting, if it can attack its target */
function helpNearestComrade(
	gameState: CommonGameState,
	unitCollection: CommonEntityCollection,
	ent: CommonEntity,
	entPos: CommonPosition,
): void
{
	let distmin = Math.min();
	let attacker: CommonEntity | undefined;
	unitCollection.forEach((unit) =>
	{
		if (!isPlaced(unit))
		{
			return;
		}
		const unitPos = unit.position();
		const orderData = ordersOf(unit);
		if (!requiredActivityIs(unit, "COMBAT") || !orderData || !orderData.length || !orderData[0].target)
		{
			return;
		}
		const target = gameState.getEntityById(orderData[0].target ?? -1);
		if (!target)
		{
			return;
		}
		const dist = SquareVectorDistance(unitPos, entPos);
		if (dist > distmin)
		{
			return;
		}
		distmin = dist;
		if (!ent.canAttackTarget(target, allowCapture(gameState, ent, target)))
		{
			return;
		}
		attacker = target;
	});
	if (attacker)
	{
		ent.attack(attacker.id(), allowCapture(gameState, ent, attacker));
	}
}

/**
 * The enemy units in reach, the best for the attacker first: civilians, those it counters, the nearer (their
 * "distance", when both have one), and those not vetoed. Each one's worth and distance are read once rather than
 * at every comparison: the comparison is the same, and so the order, but an army reaching its target ordered 111
 * units at 0.46 ms each in the sort alone, 51 ms of a 67 ms turn (FINDINGS §51).
 */
function sortByAttackValue(ent: CommonEntity, mUnit: CommonEntity[], veto: Record<string, boolean>): void
{
	const worth = new Map<CommonEntity, number>();
	const distance = new Map<CommonEntity, number | undefined>();
	const bonuses = counterBonuses(ent);
	for (const unit of mUnit)
	{
		let value = unit.hasClass("Support") ? 50 : 0;
		// Petra asked common-api's counters(), always false (FINDINGS §55, §59)
		if (counteredBy(bonuses, unit))
		{
			value += 100;
		}
		worth.set(unit, value);
		distance.set(unit, unit.getMetadata(PlayerID, "distance"));
	}
	// the sums in the original's order, so that a near tie falls the same way
	mUnit.sort((unitA: CommonEntity, unitB: CommonEntity): number =>
	{
		let vala = requireValue(worth.get(unitA));
		let valb = requireValue(worth.get(unitB));
		const distA = distance.get(unitA);
		const distB = distance.get(unitB);
		if (distA && distB)
		{
			vala -= distA;
			valb -= distB;
		}
		if (veto[unitA.id()])
		{
			vala -= 20000;
		}
		if (veto[unitB.id()])
		{
			valb -= 20000;
		}
		return valb - vala;
	});
}

/** Another attacker's next target: an enemy unit in reach, a structure, else help the nearest comrade. */
function orderUnitAttacker(
	gameState: CommonGameState,
	ent: CommonEntity,
	reach: AttackerReach,
	need: { needsUpdate: boolean; maybeUpdate: boolean; },
	ctx: AttackerContext,
): void
{
	const { target, targetPos, veto, unitCollection, isBlocked } = ctx;
	const entPos = reach.pos;
	const mUnit = enemyUnitsInReach(gameState, ent, reach, ctx);
	if (mUnit.length)
	{
		sortByAttackValue(ent, mUnit, veto);
		const rand = randIntExclusive(0, mUnit.length * 0.1);
		ent.attack(mUnit[rand].id(), allowCapture(gameState, ent, mUnit[rand]));
	}
	// This may prove dangerous as we may be blocked by something we
	// cannot attack. See similar behaviour at #5741.
	else if (isBlocked && ent.canAttackTarget(target, false))
	{
		ent.attack(target.id(), false);
	}
	else if (SquareVectorDistance(targetPos, entPos) > 2500)
	{
		marchOn(ent, need.maybeUpdate, ctx);
	}
	else if (!attackStructureInReach(gameState, ent, reach, ctx) && need.needsUpdate)
	{
		helpNearestComrade(gameState, unitCollection, ent, entPos); // really nothing   let's try to help our nearest unit
	}
}

/** One attacker's orders, the turn it is looked at (updateAttacking): left, or given a new target. */
export function orderAttacker(gameState: CommonGameState, ent: CommonEntity, ctx: AttackerContext): void
{
	if (!isPlaced(ent))
	{
		return;
	}
	const entPosRaw = ent.position();
	const entPos: CommonPosition = entPosRaw;
	const need = attackerNeedsOrder(gameState, ent, ctx);
	if (need === undefined)
	{
		return;
	}
	const reach: AttackerReach = {
		pos: entPos,
		range: attackerReach(ent, ctx.isBlocked),
		access: getLandAccess(gameState, ent),
	};
	if (isSiegeUnit(ent))
	{
		orderSiegeAttacker(gameState, ent, reach, ctx);
	}
	else
	{
		orderUnitAttacker(gameState, ent, reach, need, ctx);
	}
}
