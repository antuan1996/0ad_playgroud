import { ResourcesManager } from "simulation/ai/common-api/resources.js";

/** Land access index -> whether a dock may be built on that landmass. */
export interface PlanLandSet {
	[landAccess: number]: boolean;
}

/**
 * A plan's metadata: what it hands on to the entities it trains or builds
 * (typed as theirs), and what only the plan reads.
 */
export interface PlanMetadata extends Partial<PetraEntityMetadata> {
	expectedGain?: number;
	favoredBase?: BaseId;
	index?: number;
	land?: PlanLandSet;
	militaryBase?: boolean;
	oversea?: boolean;
	phaseUp?: boolean;
	proximity?: CommonPosition;
	resource?: string;
	support?: boolean;
	trainer?: EntityId;
	type?: string;
	[key: string]: unknown;
}

/** What a plan makes: a unit or a structure (an entity template), or a technology. */
export type PlanTemplate = CommonTemplate | CommonTechnology;
/** The name a plan's template goes by: a technology's, or an entity template's. */
export type PlanName<T extends PlanTemplate> = T extends CommonTechnology ? TechName : TemplateName;

/** What every plan's save holds; each kind of plan adds its own fields. */
export type SerializedQueuePlan<T extends PlanTemplate> = {
	category: string;
	type: PlanName<T>;
	ID: number;
	metadata: PlanMetadata | undefined;
	cost: { amounts: Record<string, number>; population: number };
	number: number;
};

/**
 * Common functions and variables to all queue plans.
 */

export abstract class QueuePlan<T extends PlanTemplate = PlanTemplate>
{
	ID: number;
	category: string;
	cost: ResourcesManager;
	metadata: PlanMetadata | undefined;
	number: number;
	template: T;
	type: PlanName<T>;
	declare queueToReset?: PetraRuntime.ConfiguredQueueName;
	declare goRequirement?: TechnologyRequirements | "houseNeeded";

	/** `template` is what the game's lookup of `type` returned */
	constructor(gameState: CommonGameState, type: PlanName<T>, template: T | null, metadata?: PlanMetadata)
	{
		this.type = type;
		this.metadata = metadata;

		if (!template)
			throw new Error("Tried to add the inexisting template " + this.type + " to Petra.");
		this.template = template;
		this.ID = gameState.ai.uniqueIDs.plans++;
		this.cost = new ResourcesManager(this.template.cost());
		this.number = 1;
		this.category = "";
	}

	/** what a save keeps of the plan: these fields, and each kind's own */
	abstract Serialize(): SerializedQueuePlan<T>;
	abstract Deserialize(gameState: CommonGameState, data: ReturnType<this["Serialize"]>): void;

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
	broad: PetraRuntime.ConcretePlan,
	narrowed: P,
): broad is P
{
	return broad.type === narrowed.type;
}
