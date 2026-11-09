/**
 * The way to the next phase (moved out of decision/headquarters.ts): when the town and city phases are wanted,
 * the buildings each requires queued first, and the phase's state noted on each turn.
 */
import { debugWarn } from "../adapter/debug.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import type { Builders } from "../world/builders.ts";
import type { HeadquartersQueues, TownState } from "./headquarters.ts";

/** What the phasing asks of the headquarters: its state, and the structures it has of a class */
type PhasingHQ = TownState & {
	readonly buildManager: { readonly builders: Pick<Builders, "findStructureWithClass">; };
};

/** Ensure that all requirements are met when phasing up*/
export function checkPhaseRequirements(hq: PhasingHQ, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (gameState.getNumberOfPhases() === hq.currentPhase)
	{
		return;
	}

	const requirements = gameState.getPhaseEntityRequirements(hq.currentPhase + 1);
	for (const entityReq of requirements)
	{
		// Village requirements are met elsewhere by constructing more houses
		if (entityReq.class === "Village" || entityReq.class === "NotField")
		{
			continue;
		}
		if (gameState.getOwnEntitiesByClass(entityReq.class, true).length >= entityReq.count)
		{
			continue;
		}
		const phasePlan = entityReq.class === "Town" ?
			townPhasePlan(hq, gameState, queues) :
			phasePlanWithClass(hq, gameState, queues, entityReq.class);
		if (phasePlan)
		{
			queuePhasePlan(gameState, queues, phasePlan);
			return;
		}
	}
}

/** A market, else a temple, else a forge for the town phase, unless an economic or military building is queued */
function townPhasePlan(hq: PhasingHQ, gameState: CommonGameState, queues: HeadquartersQueues): PhasePlan | undefined
{
	if (queues.economicBuilding.hasQueuedUnits() || queues.militaryBuilding.hasQueuedUnits())
	{
		return undefined;
	}
	const options: Array<[string, string, PetraRuntime.ConfiguredQueueName]> = [
		["Market", "structures/{civ}/market", "economicBuilding"],
		["Temple", "structures/{civ}/temple", "economicBuilding"],
		["Forge", "structures/{civ}/forge", "militaryBuilding"],
	];
	for (const [className, templateName, queue] of options)
	{
		if (!gameState.getOwnEntitiesByClass(className, true).hasEntities() && hq.canBuild(gameState, templateName))
		{
			return { plan: new ConstructionPlan(gameState, templateName, { phaseUp: true }), queue };
		}
	}
	return undefined;
}

/**
 * A structure of a class the phase requires, not dealt with inside vanilla game: for the time being on the
 * economic queue, except if wonder; none while that queue has one
 */
function phasePlanWithClass(
	hq: PhasingHQ,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	className: string,
): PhasePlan | undefined
{
	const queue = className === "Wonder" ? "wonder" : "economicBuilding";
	if (queues[queue].hasQueuedUnits())
	{
		return undefined;
	}
	const structure = hq.buildManager.builders.findStructureWithClass(gameState, [className]);
	if (structure && hq.canBuild(gameState, structure))
	{
		return { plan: new ConstructionPlan(gameState, structure, { phaseUp: true }), queue };
	}
	return undefined;
}

/** A phase reached (TODO find a better way to update) */
export function notePhase(hq: PhasingHQ, gameState: CommonGameState): void
{
	if (hq.currentPhase === gameState.currentPhase())
	{
		return;
	}
	debugWarn(
		hq.Config,
		0,
		() =>
			" civ " + gameState.getPlayerCiv() + " has phasedUp from " + hq.currentPhase +
			" to " + gameState.currentPhase() + " at time " + gameState.ai.elapsedTime +
			" phasing " + hq.phasing,
	);
	hq.currentPhase = gameState.currentPhase();

	// In principle, hq.phasing should be already reset to 0 when starting the research
	// but hq does not work in case of an autoResearch tech
	if (hq.phasing)
	{
		hq.phasing = 0;
	}
}

/** A plan for the next phase goes first in its queue, raised meanwhile (the major techs' for a wonder) */
function queuePhasePlan(gameState: CommonGameState, queues: HeadquartersQueues, phasePlan: PhasePlan): void
{
	const { plan, queue } = phasePlan;
	if (queue === "wonder")
	{
		gameState.ai.queueManager.changePriority("majorTech", 400);
		plan.queueToReset = "majorTech";
	}
	else
	{
		gameState.ai.queueManager.changePriority(queue, 1000);
		plan.queueToReset = queue;
	}
	queues[queue].addPlan(plan);
}

/** A plan for the next phase and its queue */
type PhasePlan = { plan: ConstructionPlan; queue: PetraRuntime.ConfiguredQueueName; };
