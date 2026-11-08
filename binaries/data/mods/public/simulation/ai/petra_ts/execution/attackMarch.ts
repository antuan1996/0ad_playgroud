/**
 * An attack plan's march (moved out of execution/attackPlan.ts): walking its path to the target and getting
 * unstuck on the way (walls, a blocked army), arriving under fire, and the units shipped overseas.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { debugShade } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { STATE_ARRIVED, STATE_TRANSPORTING, STATE_WALKING } from "./attackConstants.ts";
import { destroyFarthestSiege } from "./attackOrders.ts";
import type { AttackAim, AttackPlan } from "./attackPlan.ts";

/**
 * Where a plan's army stood, to tell when it is stuck: at the end of its
 * last turn, and five turns ago while it walks (both saved).
 */
export type MarchTrack = { lastPosition: CommonPosition; position5TurnsAgo: CommonPosition; };

/** The plan walks to its target on its land, along its path (made now if none); false without one */
export function walkTo(plan: AttackPlan, gameState: CommonGameState, aim: AttackAim): boolean
{
	if (!plan.path)
	{
		plan.getPathToTarget(gameState, aim, true);
	}
	const path = plan.path;
	if (!path || !path[0][0] || !path[0][1])
	{
		return false;
	}
	plan.overseas = 0;
	plan.startWalking(path);
	plan.unitCollection.moveToRange(path[0][0], path[0][1], 0, 15);
	return true;
}

export function UpdateTransporting(plan: AttackPlan, gameState: CommonGameState, events: EngineAIEvents): void
{
	let done = true;
	for (const ent of plan.unitCollection.values())
	{
		if (plan.Config.debug > 1 && ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			debugShade([ent.id()], [2, 2, 0]);
		}
		else if (plan.Config.debug > 1)
		{
			debugShade([ent.id()], [1, 1, 1]);
		}
		if (!done)
		{
			continue;
		}
		if (ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			done = false;
		}
	}

	if (done)
	{
		plan.changeState(STATE_TRANSPORTING, STATE_ARRIVED);
		return;
	}

	// if we are attacked while waiting the rest of the army, retaliate
	plan.answerAttacks(gameState, events);
}

/** A walking turn, on the path the plan sets off on (StartAttack) or was saved walking. */
export function UpdateWalking(
	plan: AttackPlan,
	gameState: CommonGameState,
	events: EngineAIEvents,
	path: CommonPosition[],
): boolean
{
	const pos = plan.position;
	if (!pos)
	{
		return false;
	}
	const pos5TurnsAgo = plan.march.position5TurnsAgo;
	const targetPos = plan.targetPos;
	// we're marching towards the target
	// Are we arrived at destination ?
	if (arrivedUnderFire(plan, gameState, events, pos))
	{
		plan.changeState(STATE_WALKING, STATE_ARRIVED);
		return true;
	}

	// basically haven't moved an inch: very likely stuck)
	if (
		pos5TurnsAgo && SquareVectorDistance(pos, pos5TurnsAgo) < 10 &&
		path.length > 0 && gameState.ai.playedTurn % 5 === 0
	)
	{
		destroyFarthestSiege(plan.unitCollection, pos);
	}
	if (gameState.ai.playedTurn % 5 === 0)
	{
		plan.march.position5TurnsAgo = clone(pos);
	}

	const lastPos = plan.march.lastPosition;
	if (lastPos && SquareVectorDistance(pos, lastPos) < 16 && path.length > 0)
	{
		const walls = unstick(plan, gameState, pos, path);
		if (walls !== undefined)
		{
			return walls;
		}
	}

	// check if our units are close enough from the next waypoint.
	if (targetPos && SquareVectorDistance(pos, targetPos) < 10000 || walkedPath(plan, path, pos))
	{
		debugWarn(plan.Config, 1, () => "Attack Plan " + plan.type + " " + plan.name + " has arrived to destination.");
		plan.changeState(STATE_WALKING, STATE_ARRIVED);
	}
	return true;
}

/**
 * Let's check if any of our unit has been attacked: in case yes, we'll determine if we're simply off against an
 * enemy army, a lone unit/building or if we reached the enemy base (attacked in its territory, or a lot).
 * Different plans may react differently.
 */
export function arrivedUnderFire(
	plan: AttackPlan,
	gameState: CommonGameState,
	events: EngineAIEvents,
	pos: CommonPosition,
): boolean
{
	let attackedNB = 0;
	let attackedUnitNB = 0;
	for (const evt of events.Attacked)
	{
		if (!plan.unitCollection.hasEntId(evt.target))
		{
			continue;
		}
		const attacker = gameState.getEntityById(evt.attacker);
		if (attacker && (attacker.owner() !== 0 || plan.targetPlayer === 0))
		{
			attackedNB++;
			if (attacker.hasClass("Unit"))
			{
				attackedUnitNB++;
			}
		}
	}
	return attackedNB > 1 && (attackedUnitNB > 0 || plan.hasSiegeUnits()) &&
		(gameState.ai.geography.territoryMap.getOwner(pos) === plan.targetPlayer || attackedNB > 3);
}

/**
 * We're stuck, presumably: walls just close to us end the walk (arrived, true, if we can attack them, else
 * false: we give up); without, the army is sent again to the next waypoint (undefined)
 */
export function unstick(
	plan: AttackPlan,
	gameState: CommonGameState,
	pos: CommonPosition,
	path: CommonPosition[],
): boolean | undefined
{
	if (!path[0][0] || !path[0][1])
	{
		aiWarn("Start: Problem with path " + uneval(path));
	}
	const walls = facesWalls(plan, gameState, pos);
	if (walls !== undefined)
	{
		if (walls)
		{
			plan.changeState(STATE_WALKING, STATE_ARRIVED);
		}
		return walls;
	}
	// plan.unitCollection.move(path[0][0], path[0][1]);
	plan.unitCollection.moveIndiv(path[0][0], path[0][1]);
	return undefined;
}

/**
 * Walls just close to a stuck army: true if it can attack them (it has arrived), false if not (it gives up),
 * undefined when there are none
 */
export function facesWalls(plan: AttackPlan, gameState: CommonGameState, pos: CommonPosition): boolean | undefined
{
	for (const ent of gameState.getEnemyStructures().filter(filters.byClasses(["Palisade", "Wall"])).values())
	{
		const entPos = ent.position();
		if (SquareVectorDistance(pos, entPos) > 800)
		{
			continue;
		}
		const enemyClass = ent.hasClass("Wall") ? "Wall" : "Palisade";
		// there are walls, so check if we can attack
		if (plan.unitCollection.filter(filters.byCanAttackClass(enemyClass)).hasEntities())
		{
			debugWarn(
				plan.Config,
				1,
				() => "Attack Plan " + plan.type + " " + plan.name + " has met walls and is not happy.",
			);
			return true;
		}
		// abort plan
		debugWarn(plan.Config, 1, () => "Attack Plan " + plan.type + " " + plan.name + " has met walls and gives up.");
		return false;
	}
	return undefined;
}

/** The next waypoint reached: the army moves on to the one after; whether that was the last */
export function walkedPath(plan: AttackPlan, path: CommonPosition[], pos: CommonPosition): boolean
{
	if (!path.length || !(SquareVectorDistance(pos, path[0]) < 1600))
	{
		return false;
	}
	path.shift();
	if (!path.length)
	{
		return true;
	}
	plan.unitCollection.moveToRange(path[0][0], path[0][1], 0, 15);
	return false;
}
