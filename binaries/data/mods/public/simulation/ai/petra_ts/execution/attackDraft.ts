/**
 * An attack plan's draft (moved out of execution/attackPlan.ts): which of our units join it, the raiders' own, the
 * workers drafted in a pinch, and the soldiers beside enemies on another land, who fight them first.
 */
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { dumpEntity, getLandAccess } from "../adapter/entityExtend.ts";
import { TYPE_RUSH } from "./attackConstants.ts";
import type { AttackPlan } from "./attackPlan.ts";
import { Worker } from "./worker.ts";

/**
 * Some citizen soldiers from the workers: if Rush, all kind of workers, keeping only a minimum number of
 * defenders; otherwise only some idle workers if too much of them. Whether one was drafted.
 */
export function draftWorkers(
	plan: AttackPlan,
	gameState: CommonGameState,
	available: (ent: CommonEntity) => boolean,
): boolean
{
	let added = false;
	let num = 0;
	const numbase: Record<number, number> = {};
	let keep = plan.type !== TYPE_RUSH ?
		6 + 4 * gameState.getNumPlayerEnemies() + 8 * plan.Config.personality.defensive :
		8;
	keep = Math.round(plan.Config.popScaling * keep);
	for (const ent of gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).values())
	{
		if (!ent.hasClass("CitizenSoldier") || !available(ent))
		{
			continue;
		}
		const baseID = ent.getMetadata(PlayerID, "base");
		if (baseID)
		{
			numbase[baseID] = numbase[baseID] ? ++numbase[baseID] : 1;
		}
		else
		{
			aiWarn("Petra problem ent without base ");
			dumpEntity(ent);
			continue;
		}
		if (num++ < keep || numbase[baseID] < 5)
		{
			continue;
		}
		if (plan.type !== TYPE_RUSH && ent.getMetadata(PlayerID, "subrole") !== Worker.SUBROLE_IDLE)
		{
			continue;
		}
		added = enlist(plan, ent);
	}
	return added;
}

/** The unit joins the plan: true */
export function enlist(plan: AttackPlan, ent: CommonEntity): boolean
{
	ent.setMetadata(PlayerID, "plan", plan.name);
	plan.unitCollection.updateEnt(ent);
	return true;
}

/** All units available but those affected to allied defense join the plan; whether one did */
export function enlistAll(
	plan: AttackPlan,
	gameState: CommonGameState,
	available: (ent: CommonEntity) => boolean,
): boolean
{
	let added = false;
	for (const ent of gameState.getOwnUnits().values())
	{
		if (!ent.getMetadata(PlayerID, "allied") && available(ent))
		{
			added = enlist(plan, ent);
		}
	}
	return added;
}

/** Raids are quick attacks: all FastMoving soldiers join, except some for hunting; whether one did */
export function enlistRaiders(
	plan: AttackPlan,
	gameState: CommonGameState,
	available: (ent: CommonEntity) => boolean,
): boolean
{
	let added = false;
	let num = 0;
	for (const ent of gameState.getOwnUnits().values())
	{
		if (!ent.hasClass("FastMoving") || !available(ent))
		{
			continue;
		}
		if (num++ < 2)
		{
			continue;
		}
		added = enlist(plan, ent);
	}
	return added;
}

/**
 * Those of the plan's soldiers who stand beside enemies, on another land
 * than `keptLand` (the rally point's while the plan prepares, the target's
 * once it sets off), stay there to fight them, however few
 * (AttackDesk.splitLocalFights), rather than be shipped away from them
 * (FINDINGS §34). Run while it prepares, so that the plan counts and trains
 * without them.
 */
export function leaveDisputedLands(
	plan: AttackPlan,
	gameState: CommonGameState,
	keptLand: AccessIndex | undefined,
): void
{
	gameState.ai.town.attacks.splitLocalFights(gameState, plan, keptLand);
}

/**
 * Before a plan drafts, our soldiers on another land than its rally point's
 * with enemies on it (soldiers in no plan, those between plans, citizen
 * soldiers at work; not the units the victory conditions protect) go to fight
 * them, joining the attack fighting there or starting one: a soldier beside
 * enemy buildings or units destroys them before it is drafted.
 */
export function fightBeforeDraft(plan: AttackPlan, gameState: CommonGameState, rallyLand: AccessIndex): void
{
	const fighters: CommonEntity[] = [];
	for (const ent of gameState.getOwnUnits().values())
	{
		if (
			!ent.hasClasses(["!Unit", "Ship", "Support"]) && ent.attackTypes() !== undefined &&
			!ent.getMetadata(PlayerID, "allied") && !gameState.ai.town.victory.isCritical(ent.id()) &&
			plan.isAvailableUnit(gameState, ent) && besideEnemies(gameState, ent, rallyLand)
		)
		{
			fighters.push(ent);
		}
	}
	if (fighters.length)
	{
		gameState.ai.town.attacks.fightBesideEnemies(gameState, fighters, rallyLand);
	}
}

/**
 * Whether a unit stands on another land than the rally point's with enemies
 * on it: it fights them (fightBeforeDraft) rather than be drafted, or shipped
 * to the rally point, while they are there (FINDINGS §34).
 */
export function besideEnemies(gameState: CommonGameState, ent: CommonEntity, rallyLand: AccessIndex): boolean
{
	const land = ent.position() ? getLandAccess(gameState, ent) : undefined;
	// 1 marks an impassable cell (a hunter at a cliff's edge), no land: no island of its own
	return land !== undefined && land > 1 && land !== rallyLand && gameState.ai.enemyLands.byLand(gameState).has(land);
}
