/**
 * An attack plan's targets (moved out of execution/attackPlan.ts): the one it goes for and the land it lies on,
 * the candidates, a unit target followed, a new target when the old one is gone, and another attack helped.
 */
import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { INVALID_PLAYER } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getHolder, getLandAccess } from "../adapter/entityExtend.ts";
import { TYPE_DEFAULT, TYPE_RAID, TYPE_RUSH, plansIn } from "./attackConstants.ts";
import type { AttackPlan } from "./attackPlan.ts";
import { defaultTargetFinder, raidTargetFinder } from "./attackTargets.ts";

/** The target player (chosen if none) and its nearest target, or another player's when it has none */
export function findTarget(plan: AttackPlan, gameState: CommonGameState): boolean
{
	if (plan.targetPlayer === undefined)
	{
		plan.targetPlayer = gameState.ai.town.attacks.getEnemyPlayer(gameState, plan);
		if (plan.targetPlayer === undefined)
		{
			return false;
		}
	}

	plan.target = plan.getNearestTarget(gameState, plan.rallyPoint);
	if (plan.target)
	{
		return true;
	}
	if (plan.uniqueTargetId)
	{
		return false;
	}

	// may-be all our previous enemey target (if not recomputed here) have been destroyed ?
	plan.targetPlayer = gameState.ai.town.attacks.getEnemyPlayer(gameState, plan);
	if (plan.targetPlayer !== undefined)
	{
		plan.target = plan.getNearestTarget(gameState, plan.rallyPoint);
	}
	return !!plan.target;
}

/**
 * The plan gathers at a base on another land than its target's: the enemy buildings on that land go first
 * (the whole plan clears it before it sails, FINDINGS §34), else it sails; false when the target cannot be reached
 */
export function rallyOverseas(
	plan: AttackPlan,
	gameState: CommonGameState,
	rallyDiff: CommonPosition,
	targetIndex: AccessIndex,
): boolean
{
	const rallyIndex = gameState.ai.accessibility.getAccessValue(rallyDiff);
	plan.rallyPoint = rallyDiff;
	const local = targetOnLand(plan, gameState, rallyIndex);
	const localPos = local?.position();
	if (local && localPos)
	{
		plan.target = local;
		plan.targetPos = localPos;
		plan.targetPlayer = local.owner();
		plan.overseas = 0;
		return true;
	}
	const sea = gameState.ai.town.getSeaBetweenIndices(gameState, rallyIndex, targetIndex);
	if (!sea)
	{
		aiWarn(
			"Petra: " + plan.type + " " + plan.name + " has an inaccessible target" +
				" with indices " + rallyIndex + " " + targetIndex + " from " + plan.target?.templateName(),
		);
		return false;
	}
	plan.overseas = sea;
	gameState.ai.town.transports.setMinimalTransportShips(gameState, plan.overseas, plan.neededShips);
	return true;
}

/**
 * The plan's nearest target on a land, among the enemies with buildings
 * there (by the plan's own target search, kept to that land), the owner of
 * the building nearest to the rally point first; undefined for a plan with
 * a unique target, or when none is found (the target player then unchanged).
 */
export function targetOnLand(plan: AttackPlan, gameState: CommonGameState, land: AccessIndex): CommonEntity | undefined
{
	if (plan.uniqueTargetId)
	{
		return undefined;
	}
	const buildings = (gameState.ai.enemyLands.byLand(gameState).get(land) ?? []).filter((enemy) =>
		enemy.hasClass("Structure")
	);
	if (!buildings.length)
	{
		return undefined;
	}
	const distance = (enemy: CommonPlacedEntity): number => SquareVectorDistance(enemy.position(), plan.rallyPoint);
	const owners = new Set([...buildings].sort((a, b) => distance(a) - distance(b)).map((enemy) => enemy.owner()));
	const targetPlayer = plan.targetPlayer;
	for (const owner of owners)
	{
		plan.targetPlayer = owner;
		const target = plan.getNearestTarget(gameState, plan.rallyPoint, land);
		if (target)
		{
			return target;
		}
	}
	plan.targetPlayer = targetPlayer;
	return undefined;
}

/** The land of the plan's target, if it has one. */
export function targetLand(plan: AttackPlan, gameState: CommonGameState): AccessIndex | undefined
{
	const target = plan.target;
	return target && getLandAccess(gameState, target);
}

/** The targets the plan chooses from: its unique target, a raid's, a rush's (or the defended ones) or the default ones */
export function targetCandidates(
	plan: AttackPlan,
	gameState: CommonGameState,
	targetPlayer: PlayerId,
	land: AccessIndex | false,
): CommonEntityCollection
{
	if (plan.uniqueTargetId)
	{
		const targets = new EntityCollection(gameState.sharedScript);
		const ent = gameState.getEntityById(plan.uniqueTargetId);
		if (ent)
		{
			targets.addEnt(ent);
		}
		return targets;
	}
	if (plan.type === TYPE_RAID)
	{
		return raidTargetFinder(gameState);
	}
	if (plan.type !== TYPE_RUSH && plan.type !== TYPE_DEFAULT)
	{
		return defaultTargetFinder(gameState, targetPlayer, land);
	}
	const targets = plan.rushTargetFinder(gameState, targetPlayer, land);
	// with no undefended building, an attack takes on the defended ones; Petra
	// waited for siege engines, and on islands its armies, finding nothing,
	// were aborted and remade every few seconds for good (FINDINGS §35)
	if (!targets.hasEntities() && (plan.type === TYPE_DEFAULT || plan.hasSiegeUnits() || plan.forced))
	{
		return defaultTargetFinder(gameState, targetPlayer, land);
	}
	return targets;
}

/** A unit target's position; one gone into an enemy's building gives way to that holder */
export function followUnitTarget(plan: AttackPlan, gameState: CommonGameState, target: CommonEntity): void
{
	plan.targetPos = target.position();
	if (plan.targetPos)
	{
		return;
	}
	const holder = getHolder(gameState, target);
	if (holder && gameState.isPlayerEnemy(holder.owner()))
	{
		plan.target = holder;
		plan.targetPos = holder.position();
	}
	else
	{
		plan.target = undefined;
	}
}

/**
 * A new target, the nearest on the army's land; else one of our other attacks' there, which we help; else
 * another enemy's. Whether one was found.
 */
export function switchTarget(plan: AttackPlan, gameState: CommonGameState, pos: CommonPosition): boolean
{
	const accessIndex = plan.getAttackAccess(gameState);
	plan.target = plan.getNearestTarget(gameState, pos, accessIndex);
	if (!plan.target)
	{
		if (plan.uniqueTargetId)
		{
			return false;
		}

		// Check if we could help any current attack
		if (helpOtherAttack(plan, gameState, accessIndex))
		{
			return true;
		}

		// If not, let's look for another enemy
		plan.targetPlayer = gameState.ai.town.attacks.getEnemyPlayer(gameState, plan);
		if (plan.targetPlayer !== undefined)
		{
			plan.target = plan.getNearestTarget(gameState, pos, accessIndex);
		}
		if (!plan.target)
		{
			debugWarn(plan.Config, 1, () => "No new target found. Remaining units " + plan.unitCollection.length);
			return false;
		}
		debugWarn(plan.Config, 1, () => "We will help one of our other attacks");
	}
	plan.targetPos = plan.target.position();
	return true;
}

/** The target of another of our attacks on that land, still an enemy's: whether we take it */
export function helpOtherAttack(
	plan: AttackPlan,
	gameState: CommonGameState,
	accessIndex: AccessIndex | undefined,
): boolean
{
	const attackManager = gameState.ai.town.attacks;
	for (const attack of plansIn(attackManager.startedAttacks))
	{
		if (attack.name === plan.name)
		{
			continue;
		}
		if (
			!attack.target || !gameState.getEntityById(attack.target.id()) ||
			!gameState.isPlayerEnemy(attack.target.owner())
		)
		{
			continue;
		}
		if (accessIndex !== getLandAccess(gameState, attack.target))
		{
			continue;
		}
		if (attack.target.owner() === 0 && attack.targetPlayer !== 0)
		{ // looks like it has resigned
			continue;
		}
		if (!gameState.isPlayerEnemy(attack.targetPlayer ?? INVALID_PLAYER))
		{
			continue;
		}
		const target = attack.target;
		plan.target = target;
		plan.targetPlayer = attack.targetPlayer;
		plan.targetPos = target.position();
		return true;
	}
	return false;
}
