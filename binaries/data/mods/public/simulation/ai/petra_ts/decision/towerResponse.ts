/**
 * Our units under a shooting enemy structure (a tower, a fortress, a civic centre with arrows): they storm it when
 * they can take it and keep most of their strength (decision/towerFight.ts), else they get out of its reach. Asked
 * by the defense for each such structure that hit our units this turn; Petra let workers, idle soldiers and ships
 * stand under its arrows.
 *
 * Who may answer: our units within reach of it, not in a started attack (their plan fights), a defense army, a
 * transport, nor protected by the victory conditions. Those that storm are the soldiers, citizen soldiers and
 * warships among them that can attack it and reach it: on the land beside it, or the sea beside it for a ship. The
 * others, and all of them when the storm does not pay, step out of its reach if idle or hurt (below FLEE_HEALTH): a
 * gatherer whole keeps on, a weak tower shooting across a strait would else chase the workers off at every arrow.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { worldPos } from "../adapter/brands.ts";
import { getAttackBonus, getLandAccess, getSeaAccess } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced, isStructure } from "../adapter/placed.ts";
import { combatStats } from "../adapter/templateData.ts";
import { allowCapture, antiCaptureOf } from "../world/capture.ts";
import { fightSide } from "./fightEstimate.ts";
import { assessTower, type TowerCapture, type TowerFight, type TowerGroup } from "./towerFight.ts";

/** Metres beyond its reach within which our units count for a storm of the structure */
const STORM_REACH = 40;

/** Below this health a busy unit that does not storm leaves its task to get out of reach; above it, only an idle one */
const FLEE_HEALTH = 0.5;

/** Moves a unit out of the attacker's reach (its ranged reach and 15 m, else 25 m), if it is within it */
export function fleeFrom(target: CommonPlacedEntity, attacker: CommonPlacedEntity): void
{
	const pos = attacker.position();
	const attackerRange = attacker.attackRange("Ranged");
	const range = attackerRange ? attackerRange.max + 15 : 25;
	if (range * range > SquareVectorDistance(pos, target.position()))
	{
		target.moveToRange(pos[0], pos[1], range, range + 5);
	}
}

/** Whether a structure of the enemy shoots: a ranged attack, its own arrows or a garrison's */
export function shootsArrows(structure: CommonPlacedEntity): boolean
{
	return structure.hasClass("Structure") === true && structure.attackRange("Ranged") !== undefined &&
		arrowsOf(structure) > 0;
}

/** The arrows a structure shoots: its default ones, and one a garrisoned unit */
function arrowsOf(structure: CommonPlacedEntity): number
{
	return +(structure.getDefaultArrow() || 0) + (structure.isGarrisonHolder() ? structure.garrisoned().length : 0);
}

/** The spot `margin` metres beyond the structure's footprint, on the side of `from` (`from` itself if nearer) */
function approachOf(structure: CommonPlacedEntity, from: CommonPosition, margin: number): CommonPosition
{
	const pos = structure.position();
	const dist = Math.sqrt(SquareVectorDistance(pos, from));
	const radius = (isStructure(structure) ? structure.footprintRadius() : 0) + margin;
	if (dist <= radius)
	{
		return from;
	}
	return worldPos(pos[0] + (from[0] - pos[0]) * radius / dist, pos[1] + (from[1] - pos[1]) * radius / dist);
}

/**
 * Whether a unit of ours can strike the structure where it stands: a land unit from the spot by its footprint on its
 * side, if on its land; a ship from its sea, somewhere between the shore by the footprint and its own reach.
 */
function canReach(gameState: CommonGameState, ent: CommonPlacedEntity, structure: CommonPlacedEntity): boolean
{
	const accessibility = gameState.ai.accessibility;
	if (!ent.hasClass("Ship"))
	{
		return accessibility.getAccessValue(approachOf(structure, ent.position(), 4)) === getLandAccess(gameState, ent);
	}
	const sea = getSeaAccess(gameState, ent);
	const reach = Math.max(ent.attackRange("Ranged")?.max ?? ent.attackRange("Melee")?.max ?? 0, 2);
	return [2, reach / 2, reach].some((margin) =>
		accessibility.getAccessValue(approachOf(structure, ent.position(), margin), true) === sea
	);
}

/** Whether a unit of ours can strike the structure: armed (no support), able to attack it, and in reach of it */
function canStorm(gameState: CommonGameState, ent: CommonPlacedEntity, structure: CommonPlacedEntity): boolean
{
	return isArmed(ent) && ent.canAttackTarget(structure, true) && canReach(gameState, ent, structure);
}

/**
 * Our capture of the structure, by those of the stormers that can capture it (undefined when none can), as the engine
 * counts it (simulation/helpers/Attack.js)
 */
function captureOf(
	gameState: CommonGameState,
	stormers: readonly CommonPlacedEntity[],
	structure: CommonPlacedEntity,
): TowerCapture | undefined
{
	const points = structure.capturePoints()?.[structure.owner()];
	if (!structure.isCapturable() || !points)
	{
		return undefined;
	}
	let rate = 0;
	for (const ent of stormers)
	{
		if (ent.canCapture(structure))
		{
			const repeat = (ent.attackTimes("Capture")?.repeat ?? 1000) / 1000;
			rate += (ent.captureStrength() ?? 0) * getAttackBonus(ent, structure, "Capture") / repeat;
		}
	}
	// as the engine's capture effect: less by its resistance, more the more it is damaged
	rate *= Math.pow(0.9, structure.resistanceStrengths()?.Capture ?? 0) / (0.1 + 0.9 * structure.healthLevel());
	return rate > 0 ? { rate, regen: antiCaptureOf(gameState, structure), points } : undefined;
}

/** Whether the unit is already striking the structure */
function striking(ent: CommonEntity, structure: CommonEntity): boolean
{
	const orders = ordersOf(ent);
	return orders.length > 0 && orders[0].target === structure.id();
}

/** Whether a unit fights: armed, and no support unit */
function isArmed(ent: CommonEntity): boolean
{
	return !ent.hasClass("Support") && ent.attackTypes() !== undefined;
}

/** The placed entities of a collection within `reach` of `pos` that `keep` keeps */
function placedWithin(
	entities: CommonEntityCollection,
	pos: CommonPosition,
	reach: number,
	keep: (ent: CommonPlacedEntity) => boolean,
): CommonPlacedEntity[]
{
	const found: CommonPlacedEntity[] = [];
	for (const ent of entities.values())
	{
		if (isPlaced(ent) && SquareVectorDistance(ent.position(), pos) < reach * reach && keep(ent))
		{
			found.push(ent);
		}
	}
	return found;
}

/**
 * Our units answer a shooting enemy structure that hit some of them: `free` tells those that may (see the module's
 * head). They storm it or flee it; what was weighed is returned.
 */
export function answerTower(
	gameState: CommonGameState,
	structure: CommonPlacedEntity,
	free: (ent: CommonPlacedEntity) => boolean,
): TowerFight
{
	const pos = structure.position();
	const reach = (structure.attackRange("Ranged")?.max ?? 0) + STORM_REACH;
	const near = placedWithin(gameState.getOwnUnits(), pos, reach, free);
	const stormers = near.filter((ent) => canStorm(gameState, ent, structure));
	const guards = placedWithin(gameState.getEnemyUnits(), pos, reach, (ent) => isArmed(ent));
	const tower: TowerGroup = {
		stats: combatStats(structure),
		count: arrowsOf(structure),
		hpFraction: structure.healthLevel(),
	};
	const fight = assessTower(fightSide(stormers), tower, fightSide(guards), captureOf(gameState, stormers, structure));
	if (fight.verdict === "storm")
	{
		// each is booked on the capture of it first, so that each order weighs their joint strength
		for (const ent of stormers)
		{
			allowCapture(gameState, ent, structure);
		}
		for (const ent of stormers)
		{
			if (!striking(ent, structure))
			{
				ent.attack(structure.id(), allowCapture(gameState, ent, structure));
			}
		}
	}
	for (const ent of near)
	{
		if ((fight.verdict === "flee" || !stormers.includes(ent)) && (ent.isIdle() || ent.healthLevel() < FLEE_HEALTH))
		{
			fleeFrom(ent, structure);
		}
	}
	return fight;
}
