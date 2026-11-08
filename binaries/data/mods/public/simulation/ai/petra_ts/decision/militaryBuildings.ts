/**
 * The military buildings (moved out of decision/headquarters.ts): towers and fortresses, the trainers (barracks,
 * stables, ...), one more while those there are busy, and the city phase's advanced buildings.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { requireTemplate } from "../adapter/entityExtend.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import type { Headquarters, HeadquartersQueues } from "./headquarters.ts";

/** Deals with building fortresses and towers along our border with enemies. */
export function buildDefenses(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (queues.defenseBuilding.hasQueuedUnits())
	{
		return;
	}
	// A saving town builds no defense, but for a tower on a shore the enemy's
	// ships pass (FINDINGS §38): an island's town saves its wood, and sat on
	// thousands of stone while their transports and warships sailed by.
	const saving = hq.saveResources && !hq.canBarter;
	if (saving && !hq.shipTraffic)
	{
		return;
	}
	const shoreOnly = saving || hq.towersByTrafficOnly(gameState);

	if (
		!hq.saveResources && reachingCityPhase(hq, gameState) &&
		hq.canBuild(gameState, "structures/{civ}/fortress") && queueFortress(hq, gameState, queues)
	)
	{
		return;
	}

	if (
		hq.Config.Military.numSentryTowers && hq.currentPhase < 2 &&
		hq.canBuild(gameState, "structures/{civ}/sentry_tower")
	)
	{
		queueSentryTower(hq, gameState, queues, shoreOnly);
		return;
	}

	if (hq.currentPhase < 2 || !hq.canBuild(gameState, "structures/{civ}/defense_tower"))
	{
		return;
	}
	queueDefenseTower(hq, gameState, queues, shoreOnly);
}

/** Whether we are in the city phase, or researching it */
function reachingCityPhase(hq: Headquarters, gameState: CommonGameState): boolean
{
	const phaseName3 = gameState.getPhaseName(3);
	return hq.currentPhase > 2 || phaseName3 !== undefined && gameState.isResearching(phaseName3);
}

/** A fortress, the first raised in priority, once the last is old enough and we have bases and men for it; whether one was queued */
function queueFortress(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): boolean
{
	const numFortresses = gameState.getOwnEntitiesByClass("Fortress", true).length;
	if (
		(!numFortresses ||
			gameState.ai.elapsedTime > (1 + 0.10 * numFortresses) * hq.fortressLapseTime + hq.fortressStartTime) &&
		numFortresses < hq.basesManager.numActiveBases() + 1 + hq.extraFortresses &&
		numFortresses < Math.floor(gameState.getPopulation() / 25) &&
		gameState.getOwnFoundationsByClass("Fortress").length < 2
	)
	{
		hq.fortressStartTime = gameState.ai.elapsedTime;
		if (!numFortresses)
		{
			gameState.ai.queueManager.changePriority("defenseBuilding", 2 * hq.Config.priorities.defenseBuilding);
		}
		const plan = new ConstructionPlan(gameState, "structures/{civ}/fortress");
		plan.queueToReset = "defenseBuilding";
		queues.defenseBuilding.addPlan(plan);
		return true;
	}
	return false;
}

/** A sentry tower in the village phase, up to the configured number, spaced in time (all towers and wall towers counted) */
function queueSentryTower(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	shoreOnly: boolean | undefined,
): void
{
	const numTowers = gameState.getOwnEntitiesByClass("Tower", true).length +
		gameState.getOwnEntitiesByClass("WallTower", true).length;
	const towerLapseTime = hq.saveResources ? (1 + 0.5 * numTowers) * hq.towerLapseTime : hq.towerLapseTime;
	if (numTowers < hq.Config.Military.numSentryTowers && gameState.ai.elapsedTime > towerLapseTime + hq.fortStartTime)
	{
		if (shoreOnly && !hq.hasShoreTowerSpot(gameState, "structures/{civ}/sentry_tower"))
		{
			return;
		}
		hq.fortStartTime = gameState.ai.elapsedTime;
		queues.defenseBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/sentry_tower"));
	}
}

/** A stone tower, spaced in time, up to a number by our bases and men (lowered in priority past it) */
function queueDefenseTower(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	shoreOnly: boolean | undefined,
): void
{
	const numTowers = gameState.getOwnEntitiesByClass("StoneTower", true).length;
	const towerLapseTime = hq.saveResources ? (1 + numTowers) * hq.towerLapseTime : hq.towerLapseTime;
	if (
		(!numTowers || gameState.ai.elapsedTime > (1 + 0.1 * numTowers) * towerLapseTime + hq.towerStartTime) &&
		numTowers < 2 * hq.basesManager.numActiveBases() + 3 + hq.extraTowers &&
		numTowers < Math.floor(gameState.getPopulation() / 8) &&
		gameState.getOwnFoundationsByClass("Tower").length < 3
	)
	{
		if (shoreOnly && !hq.hasShoreTowerSpot(gameState, "structures/{civ}/defense_tower"))
		{
			return;
		}
		hq.towerStartTime = gameState.ai.elapsedTime;
		if (numTowers > 2 * hq.basesManager.numActiveBases() + 3)
		{
			gameState.ai.queueManager.changePriority(
				"defenseBuilding",
				Math.round(0.7 * hq.Config.priorities.defenseBuilding),
			);
		}
		const plan = new ConstructionPlan(gameState, "structures/{civ}/defense_tower");
		plan.queueToReset = "defenseBuilding";
		queues.defenseBuilding.addPlan(plan);
	}
}

/**
 * Deals with constructing military buildings (e.g. barracks, stable).
 * They are mostly defined by Config.js. This is unreliable since changes could be done easily.
 */
export function constructTrainingBuildings(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
): void
{
	if (hq.saveResources && !hq.canBarter || queues.militaryBuilding.hasQueuedUnits())
	{
		return;
	}

	// A saving town builds no more military buildings, and so on islands, where
	// every town saves, no arsenal and no siege engine came, and the attacks
	// met defended towns without siege (FINDINGS §37). With a market it can
	// barter for one: its arsenal.
	if (
		hq.saveResources && hq.canBarter && hq.currentPhase >= 3 &&
		queueMissing(hq, gameState, queues, "Arsenal", "arsenal")
	)
	{
		return;
	}

	const numBarracks = gameState.getOwnEntitiesByClass("Barracks", true).length;
	if (hq.saveResources && numBarracks !== 0)
	{
		return;
	}

	if (queueTrainerIfNeeded(hq, gameState, queues, numBarracks))
	{
		return;
	}

	if (!hq.saveResources && hq.currentPhase >= 3)
	{
		queueCityMilitary(hq, gameState, queues);
	}
}

/** In the city phase: an elephant stable, an arsenal, then the advanced buildings with the population */
function queueCityMilitary(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (
		queueMissing(hq, gameState, queues, "ElephantStable", "elephant_stable") ||
		queueMissing(hq, gameState, queues, "Arsenal", "arsenal")
	)
	{
		return;
	}

	if (hq.getAccountedPopulation(gameState) < 80 || !hq.bAdvanced.length)
	{
		return;
	}
	queueAdvancedBuilding(hq, gameState, queues);
}

/** A military building we can build and have none of; whether it was queued */
function queueMissing(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	className: string,
	name: string,
): boolean
{
	const template = "structures/{civ}/" + name;
	if (!hq.canBuild(gameState, template) || gameState.getOwnEntitiesByClass(className, true).hasEntities())
	{
		return false;
	}
	queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, template, { militaryBase: true }));
	return true;
}

/**
 * With the population for barracks (or while phasing to the town phase short of village buildings), a trainer;
 * whether one was queued. (canBuild marks what cannot be built: asked each time, as Petra did)
 */
function queueTrainerIfNeeded(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	numBarracks: number,
): boolean
{
	const trainers: TrainerTemplates = {
		barracks: hq.canBuild(gameState, "structures/{civ}/barracks") ? "structures/{civ}/barracks" : undefined,
		range: hq.canBuild(gameState, "structures/{civ}/range") ? "structures/{civ}/range" : undefined,
		stable: hq.canBuild(gameState, "structures/{civ}/stable") ? "structures/{civ}/stable" : undefined,
	};
	return (hq.getAccountedPopulation(gameState) > hq.Config.Military.popForBarracks1 ||
		hq.phasing === 2 && gameState.getOwnStructures().filter(filters.byClass("Village")).length < 5) &&
		queueTrainer(hq, gameState, queues, numBarracks, trainers);
}

/**
 * The barracks, ranges and stables: the first ones (raised in priority), a second and a third with the
 * population, then one more while those we have are busy; whether one was queued
 */
function queueTrainer(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	numBarracks: number,
	trainers: TrainerTemplates,
): boolean
{
	const stableTemplate = trainers.stable;
	const numRanges = gameState.getOwnEntitiesByClass("Range", true).length;
	const numStables = gameState.getOwnEntitiesByClass("Stable", true).length;
	const military = (template: string): boolean =>
	{
		queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, template, { militaryBase: true }));
		return true;
	};

	if (queueFirstTrainer(hq, gameState, queues, numBarracks + numRanges, trainers))
	{
		return true;
	}
	if (numStables === 0 && stableTemplate)
	{
		return military(stableTemplate);
	}
	return queueMoreTrainers(hq, gameState, { numBarracks, numRanges, numStables }, trainers, military);
}

/** The first barracks (or range), raised in priority; whether it was queued */
function queueFirstTrainer(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	numFootTrainers: number,
	trainers: TrainerTemplates,
): boolean
{
	if (numFootTrainers === 0)
	{
		const template = trainers.barracks || trainers.range;
		if (template)
		{
			gameState.ai.queueManager.changePriority("militaryBuilding", 2 * hq.Config.priorities.militaryBuilding);
			const plan = new ConstructionPlan(gameState, template, { militaryBase: true });
			plan.queueToReset = "militaryBuilding";
			queues.militaryBuilding.addPlan(plan);
			return true;
		}
	}
	return false;
}

/** A second and a third barracks, range or stable with the population, then one more while those are busy */
function queueMoreTrainers(
	hq: Headquarters,
	gameState: CommonGameState,
	counts: { numBarracks: number; numRanges: number; numStables: number; },
	trainers: TrainerTemplates,
	military: (template: string) => boolean,
): boolean
{
	const next = nextTrainer(hq, gameState, counts, trainers);
	if (next)
	{
		return military(next);
	}

	// One more while those we have are nearly always training and the
	// stock lies unbooked: the town cannot spend what it gathers (FINDINGS §29)
	const template = trainers.barracks || trainers.range;
	if (template && oneMoreTrainerPays(hq, gameState, template))
	{
		return military(template);
	}
	return false;
}

/** The second barracks/range and stable, and a third if needed, with the population */
function nextTrainer(
	hq: Headquarters,
	gameState: CommonGameState,
	counts: { numBarracks: number; numRanges: number; numStables: number; },
	trainers: TrainerTemplates,
): string | undefined
{
	const { numBarracks, numRanges, numStables } = counts;
	const barracksTemplate = trainers.barracks;
	const rangeTemplate = trainers.range;
	const stableTemplate = trainers.stable;
	const popForBarracks2 = hq.Config.Military.popForBarracks2;
	if (numBarracks + numRanges === 1 && hq.getAccountedPopulation(gameState) > popForBarracks2)
	{
		const template = numBarracks === 0 ? (barracksTemplate || rangeTemplate) : (rangeTemplate || barracksTemplate);
		if (template)
		{
			return template;
		}
	}
	if (numStables === 1 && stableTemplate && hq.getAccountedPopulation(gameState) > popForBarracks2)
	{
		return stableTemplate;
	}
	if (numBarracks + numRanges + numStables === 2 && hq.getAccountedPopulation(gameState) > popForBarracks2 + 30)
	{
		return barracksTemplate || stableTemplate || rangeTemplate;
	}
	return undefined;
}

/** Whether our trainers are busy and twice the trainer's cost lies unbooked */
function oneMoreTrainerPays(hq: Headquarters, gameState: CommonGameState, template: string): boolean
{
	if (
		!(hq.productionLoad.trainers >= 1 && hq.productionLoad.trainers < MAX_MILITARY_TRAINERS &&
			hq.productionLoad.busy >= BUSY_TRAINERS)
	)
	{
		return false;
	}
	const cost = gameState.getTemplate(gameState.applyCiv(template))?.costSum() ?? Infinity;
	const unbooked = gameState.ai.queueManager.getAvailableResources(gameState);
	let free = 0;
	for (const res of Resources.GetCodes())
	{
		free += Math.max(0, unbooked[res]);
	}
	return free >= 2 * cost;
}

/** Build advanced military buildings: the first, then the others with the population */
function queueAdvancedBuilding(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	let nAdvanced = 0;
	for (const advanced of hq.bAdvanced)
	{
		nAdvanced += gameState.countEntitiesAndQueuedByType(advanced, true);
	}

	if (nAdvanced && !(nAdvanced < hq.bAdvanced.length && hq.getAccountedPopulation(gameState) > 110))
	{
		return;
	}
	for (const advanced of hq.bAdvanced)
	{
		if (gameState.countEntitiesAndQueuedByType(advanced, true) > 0 || !hq.canBuild(gameState, advanced))
		{
			continue;
		}
		// canBuild() above already verified that the template exists.
		const template = requireTemplate(gameState, advanced);
		const civ = gameState.getPlayerCiv();
		if (template.hasDefensiveFire() || template.trainableEntities(civ))
		{
			queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, advanced, { militaryBase: true }));
		}
		// not a military building, but still use hq queue
		else
		{
			queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, advanced));
		}
		return;
	}
}

/** The share of the time our infantry trainers train above which another one is built (FINDINGS §29). */
const BUSY_TRAINERS = 0.85;

/** The most infantry trainers that rule builds up to. */
const MAX_MILITARY_TRAINERS = 5;

/** The barracks, range and stable templates we can build */
type TrainerTemplates = { barracks: string | undefined; range: string | undefined; stable: string | undefined; };
