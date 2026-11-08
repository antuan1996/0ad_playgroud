/**
 * An attack plan's preparation (moved out of execution/attackPlan.ts): drafting and training its army while it
 * waits, setting off (its target, its path, its units gathered at the rally point), and the completing step's wait
 * for its last units.
 */
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { NO_BASE, playerId, seconds } from "../adapter/brands.ts";
import { postCommand } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, requireTemplate, returnResources } from "../adapter/entityExtend.ts";
import {
	PREPARATION_FAILED,
	PREPARATION_KEEP_GOING,
	PREPARATION_START,
	SIEGE_NOT_TESTED,
	SIEGE_NO_TRAINER,
	STATE_COMPLETING,
	STATE_UNEXECUTED,
	TYPE_RAID,
	TYPE_RUSH,
} from "./attackConstants.ts";
import { leaveDisputedLands } from "./attackDraft.ts";
import type { AttackBuildOrder, AttackPlan, AttackPreparation } from "./attackPlan.ts";
import { targetLand } from "./attackTargeting.ts";
import { type PlanMetadata } from "./queueplan.ts";
import { TrainingPlan } from "./queueplanTraining.ts";
import { PLAN_RESERVE } from "./unitPlan.ts";
import { Worker } from "./worker.ts";

/**
 * A completing plan starts once its units are done with their transport and their forced orders (or its time is
 * up); undefined when its target is gone: it is unexecuted again
 */
export function completingStep(plan: AttackPlan, gameState: CommonGameState): number | undefined
{
	// if our target was destroyed, go back to "unexecuted" state
	if (plan.targetPlayer === undefined || !plan.target || !gameState.getEntityById(plan.target.id()))
	{
		plan.changeState(STATE_COMPLETING, STATE_UNEXECUTED);
		plan.target = undefined;
		return undefined;
	}
	// check that all units have finished with their transport if needed
	if (plan.waitingForTransport())
	{
		return PREPARATION_KEEP_GOING;
	}
	// bloqued units which cannot finish their order should not stop the attack
	if (gameState.ai.elapsedTime < plan.maxCompletingTime && plan.hasForceOrder())
	{
		return PREPARATION_KEEP_GOING;
	}
	return PREPARATION_START;
}

/** The plan drafts its units and keeps them off disputed lands; false while it waits for its ships */
export function prepareArmy(plan: AttackPlan, gameState: CommonGameState): boolean
{
	if (plan.type !== TYPE_RAID || !plan.forced)
	{ // Forced Raids have special purposes (as relic capture)
		plan.assignUnits(gameState);
	}

	// if we need a transport, wait for some transport ships, the units
	// drafted first: they keep at their work until the plan sets off, and
	// Petra, waiting before it drafted, left 147 idle citizen soldiers out of
	// an attack waiting for its ships on a dry island (FINDINGS §40); the
	// ship queue is raised meanwhile (NavalManager.shipPriority)
	if (plan.overseas && !gameState.ai.naval.fleet(plan.overseas)?.transports.length)
	{
		return false;
	}
	if (plan.type !== TYPE_RAID && gameState.ai.attacks.getAttackInPreparation(TYPE_RAID) !== undefined)
	{
		plan.reassignFastUnit(gameState); // reassign some fast units (if any) to fasten raid preparations
	}
	// while it prepares, the plan holds no soldier beside enemies away from its rally point
	leaveDisputedLands(plan, gameState, gameState.ai.accessibility.getAccessValue(plan.rallyPoint));

	// Fasten the end game.
	if (gameState.ai.playedTurn % 5 === 0 && plan.hasSiegeUnits())
	{
		fastenEndGame(plan, gameState);
	}
	return true;
}

/** The plan's training while it prepares: a result to return, or undefined when it must start */
export function trainingStep(plan: AttackPlan, gameState: CommonGameState, prep: AttackPreparation): number | undefined
{
	// special case: if we've reached max pop, and we can start the plan, start it;
	// so too at our population limit with no room for a house: it cannot grow
	// (FINDINGS §40: a huge attack of 136 waited for good on a full island)
	if (gameState.getPopulationMax() - gameState.getPopulation() < 5 || cannotGrow(gameState))
	{
		let lengthMin = 16;
		if (gameState.getPopulationMax() < 300)
		{
			lengthMin -= Math.floor(8 * (300 - gameState.getPopulationMax()) / 300);
		}
		if (plan.canStart() || plan.unitCollection.length > lengthMin)
		{
			emptyQueues(prep);
			return undefined;
		}
		// Short of men at the cap: wait, gathering the reserve as below it. The
		// original aborted the plan so that its units would serve other plans,
		// but the next plan the attack manager made took them back at once
		// (FINDINGS §16: 120 plans in 200 games, 80 in one).
		return PREPARATION_KEEP_GOING;
	}
	if (plan.mustStart())
	{
		if (gameState.countOwnQueuedEntitiesWithMetadata("plan", +plan.name) > 0)
		{
			// keep on while the units finish being trained, then we'll start
			emptyQueues(prep);
			return PREPARATION_KEEP_GOING;
		}
		return undefined;
	}
	if (plan.canBuildUnits)
	{
		// We still have time left to recruit units and do stuffs.
		if (
			prep.siegeState === SIEGE_NOT_TESTED ||
			prep.siegeState === SIEGE_NO_TRAINER && gameState.ai.playedTurn % 5 === 0
		)
		{
			plan.addSiegeUnits(gameState);
		}
		plan.trainMoreUnits(gameState, prep);
		// may happen if we have no more training facilities and build orders are canceled
		if (!prep.buildOrders.length)
		{
			return PREPARATION_FAILED; // will abort the plan
		}
	}
	return PREPARATION_KEEP_GOING;
}

/** The plan sets off: completing, with its target and path, its units gathering, its queues reset */
export function setOff(plan: AttackPlan, gameState: CommonGameState): number
{
	plan.changeState(STATE_UNEXECUTED, STATE_COMPLETING);

	// Raids have their predefined target
	if (!plan.target && !plan.chooseTarget(gameState))
	{
		return PREPARATION_FAILED;
	}
	leaveDisputedLands(plan, gameState, targetLand(plan, gameState));
	const aim = plan.aim();
	if (!plan.overseas && aim)
	{
		plan.getPathToTarget(gameState, aim);
	}

	if (plan.type === TYPE_RAID)
	{
		plan.maxCompletingTime = seconds(plan.forced ? 0 : gameState.ai.elapsedTime + 20);
	}
	else
	{
		if (plan.type === TYPE_RUSH || plan.forced)
		{
			plan.maxCompletingTime = seconds(gameState.ai.elapsedTime + 40);
		}
		else
		{
			plan.maxCompletingTime = seconds(gameState.ai.elapsedTime + 60);
		}
		// warn our allies so that they can help if possible
		if (!plan.requested && plan.targetPlayer !== undefined)
		{
			postCommand({ type: "attack-request", source: PlayerID, player: plan.targetPlayer });
		}
	}

	gatherAtRallyPoint(plan, gameState);

	// reset all queued units
	plan.removeQueues(gameState);
	return PREPARATION_KEEP_GOING;
}

/** A plan with siege far bigger than the enemies' armies starts at once */
export function fastenEndGame(plan: AttackPlan, gameState: CommonGameState): void
{
	let totEnemies = 0;
	let hasEnemies = false;
	for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (!gameState.isPlayerEnemy(i) || gameState.ai.attacks.defeated[i])
		{
			continue;
		}
		hasEnemies = true;
		totEnemies += gameState.getEnemyUnits(i).length;
	}
	if (hasEnemies && plan.unitCollection.length > 20 + 2 * totEnemies)
	{
		plan.forceStart();
	}
}

/** The plan sets off: its units leave bombing, return what they carry and go to the rally point, by ship if need be */
export function gatherAtRallyPoint(plan: AttackPlan, gameState: CommonGameState): void
{
	// Remove those units which were in a temporary bombing attack
	for (const unitIds of gameState.ai.attacks.bombingAttacks.values())
	{
		for (const entId of unitIds.values())
		{
			const ent = gameState.getEntityById(entId);
			if (!ent || ent.getMetadata(PlayerID, "plan") !== plan.name)
			{
				continue;
			}
			unitIds.delete(entId);
			ent.stopMoving();
		}
	}

	const rallyPoint = plan.rallyPoint;
	const rallyIndex = gameState.ai.accessibility.getAccessValue(rallyPoint);
	for (const ent of plan.unitCollection.values())
	{
		// For the time being, if occupied in a transport, remove the unit from plan plan   TODO improve that
		if (
			ent.getMetadata(PlayerID, "transport") !== undefined ||
			ent.getMetadata(PlayerID, "transporter") !== undefined
		)
		{
			ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
			continue;
		}
		ent.setMetadata(PlayerID, "role", Worker.ROLE_ATTACK);
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_COMPLETING);
		const carrying = ent.resourceCarrying();
		let queued = false;
		if (carrying && carrying.length)
		{
			queued = returnResources(gameState, ent);
		}
		const index = getLandAccess(gameState, ent);
		if (index === undefined)
		{
			continue;
		}
		if (index === rallyIndex)
		{
			ent.moveToRange(rallyPoint[0], rallyPoint[1], 0, 15, queued);
		}
		else
		{
			gameState.ai.naval.requireTransport(gameState, ent, index, rallyIndex, rallyPoint);
		}
	}
}

/** The units of a build order in training and in the plan's three queues */
export function queuedFor(
	plan: AttackPlan,
	gameState: CommonGameState,
	prep: AttackPreparation,
	name: string,
): { inTraining: number; queue1: number; queue2: number; queue3: number; total: number; }
{
	const special = "Plan_" + plan.name + "_" + name;
	const inTraining = gameState.countOwnQueuedEntitiesWithMetadata("special", special);
	const queue1 = prep.queue.countQueuedUnitsWithMetadata("special", special);
	const queue2 = prep.queueChamp.countQueuedUnitsWithMetadata("special", special);
	const queue3 = prep.queueSiege.countQueuedUnitsWithMetadata("special", special);
	let total = inTraining;
	total += queue1;
	total += queue2;
	total += queue3;
	return { inTraining, queue1, queue2, queue3, total };
}

export function debugBuildOrders(plan: AttackPlan, gameState: CommonGameState, prep: AttackPreparation): void
{
	aiWarn("====================================");
	aiWarn("======== build order for plan " + plan.name);
	for (const order of prep.buildOrders)
	{
		const { inTraining, queue1, queue2, queue3 } = queuedFor(plan, gameState, prep, order[4]);
		aiWarn(
			" >>> " + order[4] + " done " + order[2].length + " training " + inTraining +
				" queue " + queue1 + " champ " + queue2 + " siege " + queue3 + " >> need " + order[3].targetSize,
		);
	}
	aiWarn("====================================");
}

/**
 * A batch of the build order's best trainable unit in its queue (siege and heroes in the siege queue, champions
 * in the champions'), unless 6 wait there; with no trainable template the build order is removed, effectively
 * removing the unit from the plan (HACK, TODO replace)
 */
export function queueBuildOrder(
	plan: AttackPlan,
	gameState: CommonGameState,
	prep: AttackPreparation,
	firstOrder: AttackBuildOrder,
): void
{
	// find the actual queue we want
	let queue = prep.queue;
	if (firstOrder[4] === "Siege")
	{
		queue = prep.queueSiege;
	}
	else if (firstOrder[3].classes.indexOf("Hero") !== -1)
	{
		queue = prep.queueSiege;
	}
	else if (firstOrder[3].classes.indexOf("Champion") !== -1)
	{
		queue = prep.queueChamp;
	}

	if (queue.length() > 5)
	{
		return;
	}
	const interests = firstOrder[3].interests;
	const template = interests === undefined ?
		undefined :
		gameState.ai.town.findBestTrainableUnit(gameState, firstOrder[1], interests);
	if (template === undefined)
	{
		debugWarn(plan.Config, 1, () => "attack no template found " + firstOrder[1]);
		delete plan.unitStat[firstOrder[4]]; // deleting the associated unitstat.
		prep.buildOrders.splice(0, 1);
		return;
	}
	debugWarn(plan.Config, 2, () => "attack template " + template + " added for plan " + plan.name);
	const max = firstOrder[3].batchSize;
	const specialData = "Plan_" + plan.name + "_" + firstOrder[4];
	// trained on the rally point's land where it can be (queueplanTraining's trainer choice)
	const data: PlanMetadata = {
		plan: plan.name,
		special: specialData,
		base: NO_BASE,
		index: gameState.ai.accessibility.getAccessValue(plan.rallyPoint),
	};
	// findBestTrainableUnit names only templates that exist
	const templateObj = requireTemplate(gameState, template);
	// a mercenary is a citizen soldier that cannot gather: an attacker only
	data.role = templateObj.hasClass("CitizenSoldier") && templateObj.resourceGatherRates() !== undefined ?
		Worker.ROLE_WORKER :
		Worker.ROLE_ATTACK;
	const trainingPlan = new TrainingPlan(gameState, template, data, max, max);
	if (trainingPlan.template)
	{
		queue.addPlan(trainingPlan);
	}
	else
	{
		debugWarn(
			plan.Config,
			1,
			() =>
				"training plan canceled because no template for " + template +
				"   build1 " + uneval(firstOrder[1]) +
				" build3 " + uneval(firstOrder[3].interests),
		);
	}
}

/** At our population limit, with no room left for a house (the house template marked unbuildable). */
export function cannotGrow(gameState: CommonGameState): boolean
{
	if (gameState.getPopulationLimit() - gameState.getPopulation() >= 5)
	{
		return false;
	}
	const buildManager = gameState.ai.build;
	return ["structures/{civ}/house", "structures/{civ}/apartment"].some((house) =>
	{
		const name = gameState.applyCiv(house);
		return gameState.isTemplateAvailable(name) && buildManager.isUnbuildable(gameState, name);
	});
}

/** Empties a preparing plan's three queues. */
export function emptyQueues(prep: AttackPreparation): void
{
	prep.queue.empty();
	prep.queueChamp.empty();
	prep.queueSiege.empty();
}
