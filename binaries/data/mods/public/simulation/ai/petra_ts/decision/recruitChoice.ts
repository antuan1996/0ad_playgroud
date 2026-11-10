/**
 * The recruit choice (HQ.recruits): of the units our buildings can train in the classes asked, the one the
 * requirements weigh best for its cost, a unit costing a resource we hold and still gather little of weighed
 * down. The workforce training asks it its workers and soldiers, the attack plans (through the town) their
 * troops. It reads the headquarters' bases through RecruitHQ.
 */
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { getMaxStrength } from "../adapter/entityExtend.ts";
import type { Config } from "../world/config.ts";
import type { BasesManager } from "./basesManager.ts";
import type { TrainableRequirement } from "./workforce.ts";

/** What the recruit choice asks of the headquarters: the resources still gatherable round its bases */
type RecruitHQ = { readonly basesManager: Pick<BasesManager, "getTotalResourceLevel">; };

/** A unit template's value by the parameters (before its cost); an unknown parameter is warned about (once a comparison) */
function unitValue(template: CommonTemplate, parameters: TrainableRequirement[], config: Config, warn: boolean): number
{
	let value = 0.1;
	for (const param of parameters)
	{
		if (param[0] === "strength")
		{
			value += getMaxStrength(template, config.debug, config.DamageTypeImportance) * param[1];
		}
		else if (param[0] === "siegeStrength")
		{
			value += getMaxStrength(template, config.debug, config.DamageTypeImportance, "Structure") * param[1];
		}
		else if (param[0] === "speed")
		{
			value += template.walkSpeed() * param[1];
		}
		else if (param[0] === "costsResource")
		{
			// requires a third parameter which is the resource
			if (template.cost()[param[2] ?? ""])
			{
				value *= param[1];
			}
		}
		else if (param[0] === "canGather")
		{
			// checking against wood, could be anything else really.
			if (template.resourceGatherRates()?.["wood.tree"])
			{
				value *= param[1];
			}
		}
		else if (warn)
		{
			aiWarn(" trainMoreUnits avec non prevu " + uneval(param));
		}
	}
	return value;
}

export class RecruitChoice
{
	private readonly hq: RecruitHQ;

	constructor(hq: RecruitHQ)
	{
		this.hq = hq;
	}

	/** picks the best template based on parameters and classes */
	findBestTrainableUnit(
		gameState: CommonGameState,
		classes: Array<string | string[]>,
		requirements: TrainableRequirement[],
		gatherersOnly = false,
	): TemplateName | undefined
	{
		let units;
		if (classes.indexOf("Hero") !== -1)
		{
			units = gameState.findTrainableUnits(classes, []);
		}
		// We do not want siege tower as AI does not know how to use it nor hero when not explicitely specified.
		else
		{
			units = gameState.findTrainableUnits(classes, ["Hero", "SiegeTower"]);
		}
		if (gatherersOnly)
		{
			units = units.filter(([, template]) => template.resourceGatherRates() !== undefined);
		}

		if (!units.length)
		{
			return undefined;
		}

		const parameters = this.unitParameters(gameState, requirements);
		const config = gameState.ai.Config;
		units.sort((a: [string, CommonTemplate], b: [string, CommonTemplate]): number =>
		{
			const aCost = 1 + a[1].costSum();
			const bCost = 1 + b[1].costSum();
			return -unitValue(a[1], parameters, config, true) / aCost +
				unitValue(b[1], parameters, config, false) / bCost;
		});
		return units[0][0];
	}

	/** The requirements, with a lower value for units costing a resource we hold and have left little of */
	private unitParameters(gameState: CommonGameState, requirements: TrainableRequirement[]): TrainableRequirement[]
	{
		const parameters = requirements.slice();
		const remainingResources = this.hq.basesManager.getTotalResourceLevel(gameState); // resources (estimation) still gatherable in our territory
		const availableResources = gameState.ai.queueManager.getAvailableResources(gameState); // available (gathered) resources
		for (const type in remainingResources)
		{
			if (availableResources[type] > 800)
			{
				continue;
			}
			if (remainingResources[type] > 800)
			{
				continue;
			}
			const costsResource = remainingResources[type] > 400 ? 0.6 : 0.2;
			let toAdd = true;
			for (const param of parameters)
			{
				if (param[0] !== "costsResource" || param[2] !== type)
				{
					continue;
				}
				param[1] = Math.min(param[1], costsResource);
				toAdd = false;
				break;
			}
			if (toAdd)
			{
				parameters.push(["costsResource", costsResource, type]);
			}
		}
		return parameters;
	}
}
