/**
 * An attack plan at its target and as it ends (moved out of execution/attackPlan.ts): the fight begun, units
 * inside our buildings let go, the target lost or renamed, and where an army withdraws to.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { basesOf } from "../world/bases.ts";
import { STATE_ARRIVED, STATE_ATTACKING, TYPE_RAID, TYPE_RUSH, WITHDRAW_RANGE } from "./attackConstants.ts";
import type { AttackPlan } from "./attackPlan.ts";
import { Worker } from "./worker.ts";

/** Arrived: let's proceed on with whatever happens now; a rush tries to find a better target */
export function startAttacking(plan: AttackPlan, gameState: CommonGameState, position: CommonPosition): void
{
	plan.changeState(STATE_ARRIVED, STATE_ATTACKING);
	plan.startingAttack = true;
	plan.unitCollection.forEach((ent) =>
	{
		ent.stopMoving();
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_ATTACKING);
	});
	if (plan.type !== TYPE_RUSH)
	{
		return;
	}
	const newtarget = plan.getNearestTarget(gameState, position);
	if (newtarget)
	{
		plan.target = newtarget;
		plan.targetPos = plan.target.position();
	}
}

/**
 * A unit inside one of our buildings on land, not on its way by sea, is
 * out of the attack (trained where the rally point garrisons, then kept
 * there by the garrison manager): let it go, or a plan of only such
 * units waits for good and holds up the next attack.
 */
export function releaseGarrisoned(plan: AttackPlan, gameState: CommonGameState): void
{
	for (const ent of plan.unitCollection.values())
	{
		if (isPlaced(ent) || ent.getMetadata(PlayerID, "transport") !== undefined)
		{
			continue;
		}
		const holderId = ent.garrisonHolderID();
		const holder = holderId === undefined ? undefined : gameState.getEntityById(holderId);
		if (holder && !holder.hasClass("Ship"))
		{
			plan.removeUnit(ent, true);
		}
	}
}

/**
 * Where a started attack withdraws: its rally point if on the army's land, or a nearer base of ours there (in
 * case plan attack has captured one); and how far from it the units may stop: an anchor's position is the
 * centre of its building, so the ring must reach out past the footprint or nobody can get there
 */
export function withdrawPoint(
	plan: AttackPlan,
	gameState: CommonGameState,
	pos: CommonPosition,
): { rallyPoint: CommonPosition | undefined; withdrawRange: number; }
{
	let rallyPoint;
	let withdrawRange = WITHDRAW_RANGE;
	const access = plan.getAttackAccess(gameState);
	let dist = Math.min();
	if (plan.rallyPoint && gameState.ai.accessibility.getAccessValue(plan.rallyPoint) === access)
	{
		rallyPoint = plan.rallyPoint;
		dist = SquareVectorDistance(pos, rallyPoint);
	}
	for (const base of basesOf(gameState))
	{
		const anchor = base.anchor;
		const anchorPos = anchor ? anchor.position() : undefined;
		if (!anchor || !anchorPos)
		{
			continue;
		}
		if (getLandAccess(gameState, anchor) !== access)
		{
			continue;
		}
		const newdist = SquareVectorDistance(pos, anchorPos);
		if (newdist > dist)
		{
			continue;
		}
		dist = newdist;
		rallyPoint = anchorPos;
		withdrawRange = anchor.obstructionRadius().max + WITHDRAW_RANGE;
	}
	return { rallyPoint, withdrawRange };
}

/** The target captured by an ally is no more ours; a defeated target player gives way to another */
export function onTargetLost(plan: AttackPlan, gameState: CommonGameState, events: EngineAIEvents): void
{
	for (const evt of events.OwnershipChanged)
	{ // capture event
		if (plan.target && plan.target.id() === evt.entity && gameState.isPlayerAlly(evt.to))
		{
			plan.target = undefined;
		}
	}

	for (const evt of events.PlayerDefeated)
	{
		if (plan.targetPlayer !== evt.playerId)
		{
			continue;
		}
		plan.targetPlayer = gameState.ai.town.attacks.getEnemyPlayer(gameState, plan);
		plan.target = undefined;
	}
}

/** The target renamed (promoted, upgraded): followed, but by a raid not yet started */
export function onTargetRenamed(plan: AttackPlan, gameState: CommonGameState, newentity: EntityId): void
{
	if (plan.type === TYPE_RAID && !plan.isStarted())
	{
		plan.target = undefined;
	}
	else
	{
		plan.target = gameState.getEntityById(newentity);
	}
	if (plan.target)
	{
		plan.targetPos = plan.target.position();
	}
}

/** An enemy built on a land where we have a base: the plan gathers there, the last such base, without sailing */
export function rallyAtBaseOn(plan: AttackPlan, gameState: CommonGameState, access: AccessIndex): void
{
	for (const base of basesOf(gameState))
	{
		const anchorPos = base.anchor ? base.anchor.position() : undefined;
		if (!anchorPos)
		{
			continue;
		}
		if (base.accessIndex !== access)
		{
			continue;
		}
		plan.overseas = 0;
		plan.rallyPoint = anchorPos;
	}
}
