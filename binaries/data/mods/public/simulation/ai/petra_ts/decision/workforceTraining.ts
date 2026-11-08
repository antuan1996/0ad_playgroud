/**
 * The workforce's training (moved out of decision/headquarters.ts; the rules themselves are decision/workforce.ts):
 * how many workers to queue each turn, support units or citizen soldiers and which, and when the land has run dry
 * of work for more.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { NO_BASE } from "../adapter/brands.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { Worker } from "../execution/worker.ts";
import type { Headquarters, HeadquartersQueues, HeadquartersTrainableRequirement } from "./headquarters.ts";
import { batchSize, soldierRequirements, supportAlpha, supportShare, trainingStopped } from "./workforce.ts";

/** This code trains citizen workers, trying to keep close to a ratio of worker/soldiers */
export function trainMoreWorkers(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	// default template
	const requirementsDef: HeadquartersTrainableRequirement[] = [["costsResource", 1, "food"]];
	const classesDef = ["Support+Worker"];
	const templateDef = hq.findBestTrainableUnit(gameState, classesDef, requirementsDef);

	const { numberOfWorkers, numberOfSupports, numberInTraining } = countWorkers(gameState);

	// Anticipate the optimal batch size when hq queue will start
	// and adapt the batch size of the first and second queued workers to the present population
	// to ease a possible recovery if our population was drastically reduced by an attack
	// (need to go up to second queued as it is accounted in queueManager)
	const size = batchSize(numberOfWorkers);
	capFirstBatches(queues.villager, size);
	capFirstBatches(queues.citizenSoldier, size);

	const numberOfQueuedSupports = queues.villager.countQueuedUnits();
	const numberOfQueuedSoldiers = queues.citizenSoldier.countQueuedUnits();
	const numberTotal = numberOfWorkers + numberOfQueuedSupports + numberOfQueuedSoldiers;

	// with the land run dry and many hands idle, no more of them, and those queued let go (FINDINGS §40)
	const stalled = workforceStalled(hq, gameState);
	if (stalled)
	{
		queues.villager.empty();
		queues.citizenSoldier.empty();
	}
	// getPhaseName(2) is optional: preserve original semantics (isResearching(undefined) === false)
	const phaseName2 = gameState.getPhaseName(2);
	if (
		trainingStopped({
			workers: numberOfWorkers,
			queuedSupports: numberOfQueuedSupports,
			queuedSoldiers: numberOfQueuedSoldiers,
			inTraining: numberInTraining,
			target: hq.targetNumWorkers,
			popPhase2: hq.Config.Economy.popPhase2,
			waitingForTown: hq.currentPhase === 1 && (phaseName2 === undefined || !gameState.isResearching(phaseName2)),
			saving: !!hq.saveResources,
			stalled,
		})
	)
	{
		return;
	}

	// soldiers or support units (decision/workforce.ts)
	const alpha = supportAlpha(
		hq.attackManager.rushNumber < hq.attackManager.maxRushes ||
			hq.attackManager.upcomingAttacks[AttackPlan.TYPE_RUSH].length > 0,
		gameState.isCeasefireActive() ? gameState.ceasefireTimeRemaining : undefined,
	);
	const supportNum = supportShare(
		numberTotal,
		hq.supportRatio,
		hq.targetNumWorkers,
		alpha,
		!!gameState.isTemplateAvailable(gameState.applyCiv("structures/{civ}/field")),
	);

	const template = !templateDef || numberOfSupports + numberOfQueuedSupports > supportNum ?
		citizenSoldierTemplate(hq, gameState, numberTotal) :
		undefined;

	queueWorkerTraining(gameState, queues, templateDef, template, size);
}

/** A citizen soldier to train: at least 33% ranged and 33% melee; only units that gather (a mercenary, Athens' archers, is a citizen soldier by its classes) */
function citizenSoldierTemplate(
	hq: Headquarters,
	gameState: CommonGameState,
	numberTotal: number,
): TemplateName | undefined
{
	const requirements = soldierRequirements(numberTotal);
	const classes = [["CitizenSoldier", "Infantry"]];
	const pickedClass = pickRandom(["Ranged", "Melee", "Infantry"]);
	if (pickedClass !== undefined)
	{
		classes[0].push(pickedClass);
	}
	return hq.findBestTrainableUnit(gameState, classes, requirements, true);
}

/**
 * Whether the land has run dry (landRunDry) with more than a fifth of the
 * workers, and at least STALLED_IDLE, standing idle: in a 4-player
 * Dodecanese match a town went on training soldiers and women from 163 to
 * 264 population while 200 stood idle, nothing left to gather on its
 * islands, and the food they took was what its ships and attacks lacked
 * (FINDINGS §40).
 */
export function workforceStalled(hq: Headquarters, gameState: CommonGameState): boolean
{
	const workers = gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true);
	const idle = workers.filter(filters.byMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE)).length;
	return idle >= STALLED_IDLE && idle > workers.length / 5 && hq.landRunDry(gameState);
}

/** The first two batches queued no bigger than size */
function capFirstBatches(queue: { plans: Array<{ number: number; }>; }, size: number): void
{
	if (!queue.plans[0])
	{
		return;
	}
	queue.plans[0].number = Math.min(queue.plans[0].number, size);
	if (queue.plans[1])
	{
		queue.plans[1].number = Math.min(queue.plans[1].number, size);
	}
}

/** Counting the workers that aren't part of a plan, those in training included: all, the support ones, and all units in training */
function countWorkers(
	gameState: CommonGameState,
): { numberOfWorkers: number; numberOfSupports: number; numberInTraining: number; }
{
	let numberOfWorkers = 0; // all workers
	let numberOfSupports = 0; // only support workers (i.e. non fighting)
	gameState.getOwnUnits().forEach((ent) =>
	{
		if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER && ent.getMetadata(PlayerID, "plan") === undefined)
		{
			++numberOfWorkers;
			if (ent.hasClass("Support"))
			{
				++numberOfSupports;
			}
		}
	});
	let numberInTraining = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent: CommonEntity): void
	{
		const trainingQueue = ent.trainingQueue();
		if (!trainingQueue)
		{
			return;
		}
		for (const item of trainingQueue)
		{
			numberInTraining += item.count;
			if (
				item.metadata && item.metadata.role && item.metadata.role === Worker.ROLE_WORKER &&
				item.metadata.plan === undefined
			)
			{
				numberOfWorkers += item.count;
				if (item.metadata.support)
				{
					numberOfSupports += item.count;
				}
			}
		}
	});
	return { numberOfWorkers, numberOfSupports, numberInTraining };
}

/** Queue a support worker, or the citizen soldier found to train instead. */
function queueWorkerTraining(
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	templateDef: TemplateName | undefined,
	template: TemplateName | undefined,
	size: number,
): void
{
	// If the template variable is empty, the default unit (Support unit) will be used
	// base "0" means automatic choice of base
	if (!template && templateDef)
	{
		queues.villager.addPlan(
			new TrainingPlan(
				gameState,
				templateDef,
				{ role: Worker.ROLE_WORKER, base: NO_BASE, support: true },
				size,
				size,
			),
		);
	}
	else if (template)
	{
		queues.citizenSoldier.addPlan(
			new TrainingPlan(gameState, template, { role: Worker.ROLE_WORKER, base: NO_BASE }, size, size),
		);
	}
}

/** Idle workers from which a dry town stops training more (workforceStalled). */
export const STALLED_IDLE = 10;
