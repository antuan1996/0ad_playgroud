/**
 * Houses (moved out of decision/headquarters.ts; the rules themselves are decision/housing.ts): how many to queue
 * on each turn, those the next phase wants, and more when the room grows tight.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { debugWarn } from "../adapter/debug.ts";
import { requireTemplate } from "../adapter/entityExtend.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import type { Headquarters, HeadquartersQueues } from "./headquarters.ts";
import { TIGHT_SLOTS, planAnotherHouse, urgentHousePriority } from "./housing.ts";

/**
 * build more houses if needed.
 * kinda ugly, lots of special cases to both build enough houses but not tooo many…
 */
export function buildMoreHouses(hq: Headquarters, gameState: CommonGameState, queues: HeadquartersQueues): void
{
	let houseTemplateString = "structures/{civ}/apartment";
	if (
		!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)) ||
		!hq.canBuild(gameState, houseTemplateString)
	)
	{
		houseTemplateString = "structures/{civ}/house";
		if (!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)))
		{
			return;
		}
	}
	if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
	{
		return;
	}
	// isTemplateAvailable() above already verified that hq template exists.
	const houseTemplateName = gameState.applyCiv(houseTemplateString);

	const numPlanned = queues.house.length();
	if (planAnotherHouse(numPlanned, gameState.getPopulation()))
	{
		const plan = new ConstructionPlan(gameState, houseTemplateString);
		// change the starting condition according to the situation.
		plan.goRequirement = "houseNeeded";
		queues.house.addPlan(plan);
	}

	if (numPlanned > 0 && hq.phasing && gameState.getPhaseEntityRequirements(hq.phasing).length)
	{
		housesForPhase(hq, gameState, queues, houseTemplateName, numPlanned);
	}

	if (hq.requireHouses)
	{
		const houseTemplate = requireTemplate(gameState, houseTemplateName);
		if (
			!hq.phasing ||
			gameState.getPhaseEntityRequirements(hq.phasing).every((req: { class: string; count: number; }): boolean =>
				!houseTemplate.hasClass(req.class) ||
				gameState.getOwnStructures().filter(filters.byClass(req.class)).length >= req.count
			)
		)
		{
			hq.requireHouses = undefined;
		}
	}

	raiseHousesIfTight(hq, gameState, queues, houseTemplateName);
}

/**
 * The houses the next phase requires go without waiting to be needed; with no room to place one we try to
 * be less restrictive
 */
function housesForPhase(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	houseTemplateName: TemplateName,
	numPlanned: number,
): void
{
	const houseTemplate = requireTemplate(gameState, houseTemplateName);

	let needed = 0;
	for (const entityReq of gameState.getPhaseEntityRequirements(hq.phasing))
	{
		if (!houseTemplate.hasClass(entityReq.class))
		{
			continue;
		}

		const count = gameState.getOwnStructures().filter(filters.byClass(entityReq.class)).length;
		if (count < entityReq.count && hq.buildManager.isUnbuildable(gameState, houseTemplateName))
		{
			debugWarn(hq.Config, 1, () => "no room to place a house ... try to be less restrictive");
			hq.buildManager.setBuildable(houseTemplateName);
			hq.requireHouses = true;
		}
		needed = Math.max(needed, entityReq.count - count);
	}

	const houseQueue = queues.house.plans;
	for (let i = 0; i < numPlanned; ++i)
	{
		if (houseQueue[i].isGo(gameState))
		{
			--needed;
		}
		else if (needed > 0)
		{
			houseQueue[i].goRequirement = undefined;
			--needed;
		}
	}
}

/**
 * When population limit too tight: if no room to build, try to improve with technology, otherwise increase
 * temporarily the priority of houses
 */
function raiseHousesIfTight(
	hq: Headquarters,
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	house: TemplateName,
): void
{
	const HouseNb = gameState.getOwnFoundations().filter(filters.byClass("House")).length;
	const houseTemplate = requireTemplate(gameState, house);
	const popBonus = houseTemplate.getPopulationBonus();
	const freeSlots = gameState.getPopulationLimit() + HouseNb * popBonus - hq.getAccountedPopulation(gameState);
	let priority;
	if (freeSlots < TIGHT_SLOTS)
	{
		if (hq.buildManager.isUnbuildable(gameState, house))
		{
			debugWarn(hq.Config, 1, () => "no room to place a house ... try to improve with technology");
			hq.researchManager.researchPopulationBonus(gameState, queues);
		}
		else
		{
			priority = urgentHousePriority(hq.Config.priorities);
		}
	}
	else
	{
		priority = hq.Config.priorities.house;
	}

	if (priority && priority !== gameState.ai.queueManager.getPriority("house"))
	{
		gameState.ai.queueManager.changePriority("house", priority);
	}
}
