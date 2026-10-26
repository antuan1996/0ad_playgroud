import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { type PlanMetadata, QueuePlan } from "./queueplan.ts";
import { hqOf } from "./hq.ts";

export class ResearchPlan extends QueuePlan<CommonTechnology>
{
	declare category: "technology";
	declare queueToReset: PetraRuntime.ConfiguredQueueName | undefined;
	declare researchers: CommonEntity[] | undefined;
	declare rush: boolean;

	constructor(gameState: CommonGameState, type: TechName, rush: boolean = false)
	{
		super(gameState, type, gameState.getTemplate(type), {});

		// Refine the estimated cost
		const researchers = this.getBestResearchers(gameState, true);
		if (researchers)
			this.cost = new ResourcesManager(this.template.cost(researchers[0]));

		this.category = "technology";
		this.rush = rush;
	}

	canStart(gameState: CommonGameState): boolean
	{
		this.researchers = this.getBestResearchers(gameState);
		if (!this.researchers)
			return false;
		this.cost = new ResourcesManager(this.template.cost(this.researchers[0]));
		return true;
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

	start(gameState: CommonGameState): void
	{
		// Prefer researcher with shortest queues (no need to serialize this.researchers
		// as the functions canStart and start are always called on the same turn)
		const researchers = this.researchers;
		if (!researchers)
			return;
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

	Deserialize(gameState: CommonGameState, data: ReturnType<ResearchPlan["Serialize"]>): void
	{
		this.category = data.category;
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
