import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { type PlanMetadata, type PlanStart, QueuePlan } from "./queueplan.ts";
import { hqOf } from "./hq.ts";

export class ResearchPlan extends QueuePlan<CommonTechnology, "technology">
{
	rush: boolean;

	constructor(gameState: CommonGameState, type: TechName, rush: boolean = false)
	{
		super(gameState, type, gameState.getTemplate(type), "technology", {});

		// Refine the estimated cost
		const researchers = this.getBestResearchers(gameState, true);
		if (researchers)
			this.cost = new ResourcesManager(this.template.cost(researchers[0]));

		this.rush = rush;
	}

	canStart(gameState: CommonGameState): PlanStart | undefined
	{
		const researchers = this.getBestResearchers(gameState);
		if (!researchers)
			return undefined;
		this.cost = new ResourcesManager(this.template.cost(researchers[0]));
		return () => this.start(gameState, researchers);
	}

	getBestResearchers(gameState: CommonGameState, noRequirementCheck: boolean = false): CommonEntity[] | undefined
	{
		const allResearchers = gameState.findResearchers(this.type, noRequirementCheck);
		if (!allResearchers || !allResearchers.hasEntities())
			return undefined;

		// Keep only researchers with smallest cost
		let costMin = Math.min();
		let researchers: CommonEntity[] = [];
		for (const ent of allResearchers.values())
		{
			const cost = this.template.costSum(ent);
			if (cost === costMin)
				researchers.push(ent);
			else if (cost < costMin)
			{
				costMin = cost;
				researchers = [ent];
			}
		}
		return researchers;
	}

	isInvalid(gameState: CommonGameState): boolean
	{
		return gameState.isResearched(this.type) || gameState.isResearching(this.type);
	}

	/** Researches the technology at the building with the shortest queue among those canStart found. */
	private start(gameState: CommonGameState, researchers: CommonEntity[]): void
	{
		researchers.sort((a: CommonEntity, b: CommonEntity): number => (a.trainingQueueTime() ?? NaN) - (b.trainingQueueTime() ?? NaN));
		// Drop anything in the queue if we rush it.
		if (this.rush)
			researchers[0]?.stopAllProduction(0.45);
		researchers[0]?.research(this.type);
		this.onStart(gameState);
	}

	onStart(gameState: CommonGameState): void
	{
		if (this.queueToReset)
			gameState.ai.queueManager.changePriority(this.queueToReset, gameState.ai.Config.priorities[this.queueToReset]);

		for (let i = gameState.getNumberOfPhases(); i > 0; --i)
		{
			if (this.type !== gameState.getPhaseName(i))
				continue;
			hqOf(gameState).phaseResearched(gameState, i);
			break;
		}
	}

	Serialize(): {
		category: "technology";
		type: TechName;
		ID: number;
		metadata: PlanMetadata | undefined;
		cost: { amounts: Record<string, number>; population: number };
		number: number;
		rush: boolean;
		queueToReset: PetraRuntime.ConfiguredQueueName | undefined;
	}
	{
		return {
			"category": "technology",
			"type": this.type,
			"ID": this.ID,
			"metadata": this.metadata,
			"cost": this.cost.Serialize(),
			"number": this.number,
			"rush": this.rush,
			"queueToReset": this.queueToReset || undefined
		};
	}

	/** A saved plan: its id, metadata and cost from the save */
	static restore(gameState: CommonGameState, data: ReturnType<ResearchPlan["Serialize"]>): ResearchPlan
	{
		const plan = new ResearchPlan(gameState, data.type);
		plan.resume(data);
		return plan;
	}

	private resume(data: ReturnType<ResearchPlan["Serialize"]>): void
	{
		this.type = data.type;
		this.ID = data.ID;
		this.metadata = data.metadata;
		this.number = data.number;
		this.rush = data.rush;
		this.queueToReset = data.queueToReset;

		this.cost = new ResourcesManager();
		this.cost.Deserialize(data.cost);
	}
}
