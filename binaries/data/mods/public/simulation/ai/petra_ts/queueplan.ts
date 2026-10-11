import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";

/**
 * Common functions and variables to all queue plans.
 */

export abstract class QueuePlan
{
	declare ID: number;
	declare category: string;
	declare cost: ResourcesManager;
	declare metadata: Record<string, unknown>;
	declare number: number;
	declare template: CommonTemplate;
	declare type: string;
	declare maxMerge?: number;
	declare queueToReset?: string;
	declare goRequirement?: TechnologyRequirements | "houseNeeded";

	constructor(gameState: CommonGameState, type: string, metadata: Record<string, unknown> | undefined)
	{
		this.type = gameState.applyCiv(type);
		this.metadata = metadata;

		this.template = gameState.getTemplate(this.type);
		if (!this.template)
			throw new Error("Tried to add the inexisting template " + this.type + " to Petra.");
		this.ID = gameState.ai.uniqueIDs.plans++;
		this.cost = new ResourcesManager(this.template.cost());
		this.number = 1;
		this.category = "";
	}

	abstract Serialize(): Record<string, unknown>;
	abstract Deserialize(gameState: CommonGameState, data: Record<string, unknown>): void;

	/** Check the content of this queue */
	isInvalid(gameState: CommonGameState): boolean
	{
		return false;
	}

	/** if true, the queue manager will begin increasing this plan's account. */
	isGo(gameState: CommonGameState): boolean
	{
		return true;
	}

	/** can we start this plan immediately? */
	canStart(gameState: CommonGameState): boolean
	{
		return false;
	}

	/** process the plan. */
	start(gameState: CommonGameState): void
	{
		// should call onStart.
	}

	getCost(): ResourcesManager
	{
		const costs = new ResourcesManager();
		costs.add(this.cost);
		if (this.number !== 1)
			costs.multiply(this.number);
		return costs;
	}

	/**
	 * On Event functions.
	 * Can be used to do some specific stuffs
	 * Need to be updated to actually do something if you want them to.
	 * this is called by "Start" if it succeeds.
	 */
	onStart(gameState: CommonGameState): void
	{
	}
}
