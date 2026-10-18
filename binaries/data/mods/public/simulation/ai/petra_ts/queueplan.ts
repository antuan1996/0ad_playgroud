import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";

/** Land access index -> whether a dock may be built on that landmass. */
export interface PlanLandSet {
	[landAccess: number]: boolean;
}

export interface PlanMetadata {
	base?: number;
	access?: number;
	expectedGain?: number;
	favoredBase?: number;
	index?: number;
	land?: PlanLandSet;
	militaryBase?: boolean;
	oversea?: boolean;
	phaseUp?: boolean;
	proximity?: CommonPosition;
	resource?: string;
	role?: string;
	sea?: number;
	support?: boolean;
	trainer?: number;
	type?: string;
	[key: string]: unknown;
}

/**
 * Common functions and variables to all queue plans.
 */

export abstract class QueuePlan
{
	declare ID: number;
	declare category: string;
	declare cost: ResourcesManager;
	declare metadata: PlanMetadata | undefined;
	declare number: number;
	declare template: CommonTemplate;
	declare type: string;
	declare queueToReset?: string;
	declare goRequirement?: TechnologyRequirements | "houseNeeded";

	constructor(gameState: CommonGameState, type: string, metadata?: PlanMetadata)
	{
		this.type = gameState.applyCiv(type);
		this.metadata = metadata;

		const template = gameState.getTemplate(this.type);
		if (!template)
			throw new Error("Tried to add the inexisting template " + this.type + " to Petra.");
		this.template = template;
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

/**
 * An already queued plan is considered "the same" as an incoming plan
 * when their type matches. When this is true, both plans are narrowed
 * to the same concrete QueuePlan subclass.
 */
export function samePlanType<P extends PetraRuntime.ConcretePlan>(
	queued: PetraRuntime.ConcretePlan,
	incoming: P,
): queued is P
{
	return queued.type === incoming.type;
}
