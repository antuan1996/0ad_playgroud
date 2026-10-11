import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { ConstructionPlan } from "./queueplanBuilding.ts";
import { ResearchPlan } from "./queueplanResearch.ts";
import { TrainingPlan } from "./queueplanTraining.ts";

/**
 * Holds a list of wanted plans to train or construct
 */
export class Queue implements PetraRuntime.QueueLike
{
	plans: PetraRuntime.PlanLike[] = [];
	paused = false;
	switched = 0;

	empty(): void
	{
		this.plans = [];
	}

	addPlan(newPlan: PetraRuntime.PlanLike | null | undefined): void
	{
		if (!newPlan)
			return;
		for (const plan of this.plans)
		{
			if (newPlan.category === "unit" && plan.type == newPlan.type && plan.number + newPlan.number <= plan.maxMerge)
			{
				plan.addItem(newPlan.number);
				return;
			}
			else if (newPlan.category === "technology" && plan.type === newPlan.type)
				return;
		}
		this.plans.push(newPlan);
	}

	check(gameState: CommonGameState): void
	{
		while (this.plans.length > 0)
		{
			if (!this.plans[0].isInvalid(gameState))
				return;
			const plan = this.plans.shift();
			if (plan.queueToReset)
				gameState.ai.queueManager.changePriority(plan.queueToReset, gameState.ai.Config.priorities[plan.queueToReset]);
		}
	}

	getNext(): PetraRuntime.PlanLike | null
	{
		if (this.plans.length > 0)
			return this.plans[0];
		return null;
	}

	startNext(gameState: CommonGameState): boolean
	{
		if (this.plans.length > 0)
		{
			this.plans.shift().start(gameState);
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
		return this.plans.some((plan: PetraRuntime.PlanLike): boolean | undefined => plan.template && plan.template.hasClass(classe));
	}

	countQueuedUnitsWithClass(classe: string): number
	{
		let count = 0;
		for (const plan of this.plans)
			if (plan.template && plan.template.hasClass(classe))
				count += plan.number;
		return count;
	}

	countQueuedUnitsWithMetadata(data: string, value: unknown): number
	{
		let count = 0;
		for (const plan of this.plans)
			if (plan.metadata[data] && plan.metadata[data] == value)
				count += plan.number;
		return count;
	}

	Serialize(): {
		plans: Array<ReturnType<ConstructionPlan["Serialize"]> | ReturnType<ResearchPlan["Serialize"]> |
			ReturnType<TrainingPlan["Serialize"]>>;
		paused: boolean;
		switched: number;
	}
	{
		const plans = [];
		for (const plan of this.plans)
			plans.push(plan.Serialize());

		return { "plans": plans, "paused": this.paused, "switched": this.switched };
	}

	Deserialize(gameState: CommonGameState, data: {
		plans: Array<ReturnType<ConstructionPlan["Serialize"]> | ReturnType<ResearchPlan["Serialize"]> |
			ReturnType<TrainingPlan["Serialize"]>>;
		paused: boolean;
		switched: number;
	}): void
	{
		this.paused = data.paused;
		this.switched = data.switched;
		this.plans = [];
		for (const dataPlan of data.plans)
		{
			let plan;
			if (dataPlan.category == "unit")
				plan = new TrainingPlan(gameState, dataPlan.type);
			else if (dataPlan.category == "building")
				plan = new ConstructionPlan(gameState, dataPlan.type);
			else if (dataPlan.category == "technology")
				plan = new ResearchPlan(gameState, dataPlan.type);
			else
			{
				aiWarn("Petra deserialization error: plan unknown " + uneval(dataPlan));
				continue;
			}
			plan.Deserialize(gameState, dataPlan);
			this.plans.push(plan);
		}
	}
}
