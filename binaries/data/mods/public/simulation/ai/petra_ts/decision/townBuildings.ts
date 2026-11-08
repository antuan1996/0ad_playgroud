/**
 * The town's other buildings (moved out of decision/headquarters.ts): temple, markets, farmstead, wonder, corral
 * and forge, each when the town wants it and can pay for it.
 */
import { requireTemplate } from "../adapter/entityExtend.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import type { Headquarters, HeadquartersQueues } from "./headquarters.ts";

export function buildTemple(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	// at least one market (which have the same queue) should be build before any temple
	if (
		queues.economicBuilding.hasQueuedUnits() ||
		gameState.getOwnEntitiesByClass("Temple", true).hasEntities() ||
		!gameState.getOwnEntitiesByClass("Market", true).hasEntities()
	)
	{
		return;
	}
	// Try to build a temple earlier if in regicide to recruit healer guards
	if (hq.currentPhase < 3 && !gameState.getVictoryConditions().has("regicide"))
	{
		return;
	}

	let templateName = "structures/{civ}/temple";
	if (hq.canBuild(gameState, "structures/{civ}/temple_vesta"))
	{
		templateName = "structures/{civ}/temple_vesta";
	}
	else if (!hq.canBuild(gameState, templateName))
	{
		return;
	}
	queues.economicBuilding.addPlan(new ConstructionPlan(gameState, templateName));
}

export function buildMarket(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (
		gameState.getOwnEntitiesByClass("Market", true).hasEntities() ||
		!hq.canBuild(gameState, "structures/{civ}/market")
	)
	{
		return;
	}

	if (queues.economicBuilding.hasQueuedUnitsWithClass("Market"))
	{
		if (!queues.economicBuilding.paused)
		{
			fundMarket(gameState, queues);
		}
		return;
	}

	gameState.ai.queueManager.changePriority("economicBuilding", 3 * hq.Config.priorities.economicBuilding);
	const plan = new ConstructionPlan(gameState, "structures/{civ}/market");
	plan.queueToReset = "economicBuilding";
	queues.economicBuilding.addPlan(plan);
}

/**
 * A saving town (little wood on its land from the start, FINDINGS §37)
 * whose land has no wood left within reach queues its market at once, in
 * the village phase too: queued, the market holds its wood at the top
 * priority until the town phase lets it be built, and then barters the
 * town's food, stone and metal for wood. Petra queued it only in the town
 * phase, when the wood was gone: 24 of 38 drawn island games had it waiting
 * for good with 50-277 of its 300 wood. The town phase it waits for goes
 * first: while the phase is queued, the market's queue sits just below it
 * (holding the wood at the top, it starved the phase on islands with
 * under 800 wood left, and the town stayed in the village phase).
 */
export function buildEarlyMarket(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (
		!hq.economy.saveResources && !hq.geography.navalMap ||
		gameState.getOwnEntitiesByClass("Market", true).hasEntities()
	)
	{
		return;
	}
	const queueManager = gameState.ai.queueManager;
	if (queues.economicBuilding.hasQueuedUnitsWithClass("Market"))
	{
		const priority = queues.majorTech.hasQueuedUnits() ?
			Math.max(1, queueManager.getPriority("majorTech") - 1) :
			3 * hq.Config.priorities.economicBuilding;
		if (queueManager.getPriority("economicBuilding") !== priority)
		{
			queueManager.changePriority("economicBuilding", priority);
		}
		return;
	}
	const market = gameState.applyCiv("structures/{civ}/market");
	if (!gameState.isTemplateAvailable(market) || hq.buildManager.isUnbuildable(gameState, market))
	{
		return;
	}
	if (!hq.landRunDry(gameState))
	{
		return;
	}
	queueManager.changePriority("economicBuilding", 3 * hq.Config.priorities.economicBuilding);
	const plan = new ConstructionPlan(gameState, "structures/{civ}/market");
	plan.queueToReset = "economicBuilding";
	queues.economicBuilding.addPlan(plan);
}

/** Build a farmstead */
export function buildFarmstead(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	// Only build one farmstead for the time being ("DropsiteFood" does not refer to CCs)
	if (gameState.getOwnEntitiesByClass("Farmstead", true).hasEntities())
	{
		return;
	}
	// Wait to have at least one dropsite and house before the farmstead
	if (!gameState.getOwnEntitiesByClass("Storehouse", true).hasEntities())
	{
		return;
	}
	if (!gameState.getOwnEntitiesByClass("House", true).hasEntities())
	{
		return;
	}
	if (queues.economicBuilding.hasQueuedUnitsWithClass("DropsiteFood"))
	{
		return;
	}
	if (!hq.canBuild(gameState, "structures/{civ}/farmstead"))
	{
		return;
	}

	queues.economicBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/farmstead"));
}

/**
 * Try to build a wonder when required
 * force = true when called from the victoryManager in case of Wonder victory condition.
 */
export function buildWonder(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	force: boolean = false,
): void
{
	if (
		queues.wonder && queues.wonder.hasQueuedUnits() ||
		gameState.getOwnEntitiesByClass("Wonder", true).hasEntities() ||
		!hq.canBuild(gameState, "structures/{civ}/wonder")
	)
	{
		return;
	}

	if (!force)
	{
		// canBuild() above already verified that the template exists.
		const template = requireTemplate(gameState, gameState.applyCiv("structures/{civ}/wonder"));
		// Check that we have enough resources to start thinking to build a wonder
		const cost = template.cost();
		const resources = gameState.getResources();
		let highLevel = 0;
		let lowLevel = 0;
		for (const res in cost)
		{
			if (resources[res] && resources[res] > 0.7 * cost[res])
			{
				++highLevel;
			}
			else if (!resources[res] || resources[res] < 0.3 * cost[res])
			{
				++lowLevel;
			}
		}
		if (highLevel === 0 || lowLevel > 1)
		{
			return;
		}
	}

	queues.wonder.addPlan(new ConstructionPlan(gameState, "structures/{civ}/wonder"));
}

/** Build a corral, and train animals there */
export function manageCorral(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (queues.corral.hasQueuedUnits())
	{
		return;
	}

	const nCorral = gameState.getOwnEntitiesByClass("Corral", true).length;
	if (
		!nCorral ||
		!gameState.isTemplateAvailable(gameState.applyCiv("structures/{civ}/field")) &&
			nCorral < hq.currentPhase && gameState.getPopulation() > 30 * nCorral
	)
	{
		if (hq.canBuild(gameState, "structures/{civ}/corral"))
		{
			queues.corral.addPlan(new ConstructionPlan(gameState, "structures/{civ}/corral"));
			return;
		}
		if (!nCorral)
		{
			return;
		}
	}

	// And train some animals
	const civ = gameState.getPlayerCiv();
	for (const corral of gameState.getOwnEntitiesByClass("Corral", true).values())
	{
		if (corral.foundationProgress() !== undefined)
		{
			continue;
		}
		const trainable = corralAnimal(gameState, corral, civ, nCorral);
		if (trainable === undefined)
		{
			continue;
		}
		queues.corral.addPlan(new TrainingPlan(gameState, trainable, { trainer: corral.id() }));
		return;
	}
}

export function buildForge(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	if (
		hq.getAccountedPopulation(gameState) < hq.Config.Military.popForForge ||
		queues.militaryBuilding.hasQueuedUnits() || gameState.getOwnEntitiesByClass("Forge", true).length
	)
	{
		return;
	}
	// Build a Market before the Forge.
	if (!gameState.getOwnEntitiesByClass("Market", true).hasEntities())
	{
		return;
	}

	if (hq.canBuild(gameState, "structures/{civ}/forge"))
	{
		queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/forge"));
	}
}

/** The first huntable animal a corral may train of which we have (or train) no more than one per corral */
function corralAnimal(
	gameState: CommonGameState,
	corral: CommonEntity,
	civ: string,
	nCorral: number,
): TemplateName | undefined
{
	for (const trainable of (corral.trainableEntities(civ) ?? []))
	{
		if (gameState.isTemplateDisabled(trainable))
		{
			continue;
		}
		const template = gameState.getTemplate(trainable);
		if (!template || !template.isHuntable())
		{
			continue;
		}
		let count = gameState.countEntitiesByType(trainable, true);
		const corralTrainingQueue = corral.trainingQueue();
		if (corralTrainingQueue)
		{
			for (const item of corralTrainingQueue)
			{
				count += item.count;
			}
		}
		if (count > nCorral)
		{
			continue;
		}
		return trainable;
	}
	return undefined;
}

/** Put available resources in the queued market */
function fundMarket(gameState: CommonGameState, queues: HeadquartersQueues): void
{
	gameState.ai.queueManager.fund(gameState, queues.economicBuilding.plans[0].getCost(), "economicBuilding");
}
