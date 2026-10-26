import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { ConstructionPlan } from "./queueplanBuilding.ts";
import { ResearchPlan } from "./queueplanResearch.ts";
import { TrainingPlan } from "./queueplanTraining.ts";
import { samePlanType } from "./queueplan.ts";

export type PlanSerialize = ReturnType<ConstructionPlan["Serialize"]> | ReturnType<ResearchPlan["Serialize"]> | ReturnType<TrainingPlan["Serialize"]>;

/**
 * Holds a list of wanted plans to train or construct
 */
export class Queue
{
	/** Plan list in submission order; the head (index 0) is the next plan to start. */
	plans: PetraRuntime.ConcretePlan[] = [];
	/** Set by queueManager priority changes to suspend the queue's processing. */
	paused = false;
	/** Number of times the queue was force-switched (exit conditions), saved along with the plans. */
	switched = 0;

	/** Drops all plans without starting them. */
	empty(): void
	{
		this.plans = [];
	}

	/**
	 * Appends a plan, or merges it into an identical unit-plan head-group when
	 * the merged count stays within the plan's `maxMerge`; technology
	 * duplicates are silently swallowed. A null/undefined plan is ignored.
	 */
	addPlan(newPlan: PetraRuntime.ConcretePlan | null | undefined): void
	{
		if (!newPlan)
			return;
		for (const plan of this.plans)
		{
			if (newPlan.category === "unit" && samePlanType(plan, newPlan) &&
				plan.number + newPlan.number <= plan.maxMerge)
			{
				plan.addItem(newPlan.number);
				return;
			}
			else if (newPlan.category === "technology" && samePlanType(plan, newPlan))
				return;
		}
		this.plans.push(newPlan);
	}

	/** Pops plans from the head while they fail their own invalidity check (e.g. targets gone). */
	check(gameState: CommonGameState): void
	{
		while (this.plans.length > 0)
		{
			const plan = this.plans[0];
			if (!plan.isInvalid(gameState))
				return;
			this.plans.shift();
			if (plan.queueToReset)
				gameState.ai.queueManager.changePriority(plan.queueToReset, gameState.ai.Config.priorities[plan.queueToReset]);
		}
	}

	/** The plan at the head of the queue, or null when empty. */
	getNext(): PetraRuntime.PlanLike | undefined
	{
		return this.plans.length > 0 ? this.plans[0] : undefined;
	}

	/** Starts (shifts) the head plan; false when the queue is empty. */
	startNext(gameState: CommonGameState): boolean
	{
		if (this.plans.length > 0)
		{
			const plan = this.plans.shift();
			if (plan)
				plan.start(gameState);
			return true;
		}
		return false;
	}

	/**
	 * returns the maximal account we'll accept for this queue.
	 * Currently all the cost of the first element and fraction of that of the second
	 */
	maxAccountWanted(gameState: CommonGameState, fraction: number): ResourcesManager
	{
		const cost = new ResourcesManager();
		if (this.plans.length > 0 && this.plans[0].isGo(gameState))
			cost.add(this.plans[0].getCost());
		if (this.plans.length > 1 && this.plans[1].isGo(gameState) && fraction > 0)
		{
			const costs = this.plans[1].getCost();
			costs.multiply(fraction);
			cost.add(costs);
		}
		return cost;
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	queueCost(): ResourcesManager
	{
		const cost = new ResourcesManager();
		for (const plan of this.plans)
			cost.add(plan.getCost());
		return cost;
	}

	length(): number
	{
		return this.plans.length;
	}

	hasQueuedUnits(): boolean
	{
		return this.plans.length > 0;
	}

	countQueuedUnits(): number
	{
		let count = 0;
		for (const plan of this.plans)
			count += plan.number;
		return count;
	}

	hasQueuedUnitsWithClass(classe: string): boolean
	{
		return this.plans.some(plan => plan.category !== "technology" && plan.template.hasClass(classe));
	}

	countQueuedUnitsWithClass(classe: string): number
	{
		let count = 0;
		for (const plan of this.plans)
			if (plan.category !== "technology" && plan.template.hasClass(classe))
				count += plan.number;
		return count;
	}

	countQueuedUnitsWithMetadata(data: string, value: unknown): number
	{
		let count = 0;
		for (const plan of this.plans)
		{
			const metadata = plan.metadata;
			if (metadata && metadata[data] && metadata[data] == value)
				count += plan.number;
		}
		return count;
	}

	Serialize(): {
		plans: Array<PlanSerialize>;
		paused: boolean;
		switched: number;
	}
	{
		const plans: PlanSerialize[] = [];
		for (const plan of this.plans)
			plans.push(plan.Serialize());

		return { "plans": plans, "paused": this.paused, "switched": this.switched };
	}

	Deserialize(gameState: CommonGameState, data: {
		plans: Array<PlanSerialize>;
		paused: boolean;
		switched: number;
	}): void
	{
		this.paused = data.paused;
		this.switched = data.switched;
		this.plans = [];
		for (const dataPlan of data.plans)
		{
			if (dataPlan.category == "unit")
			{
				const plan = new TrainingPlan(gameState, dataPlan.type);
				plan.Deserialize(gameState, dataPlan);
				this.plans.push(plan);
			}
			else if (dataPlan.category == "building")
			{
				const plan = new ConstructionPlan(gameState, dataPlan.type);
				plan.Deserialize(gameState, dataPlan);
				this.plans.push(plan);
			}
			else if (dataPlan.category == "technology")
			{
				const plan = new ResearchPlan(gameState, dataPlan.type);
				plan.Deserialize(gameState, dataPlan);
				this.plans.push(plan);
			}
			else
				aiWarn("Petra deserialization error: plan unknown " + uneval(dataPlan));
		}
	}
}
