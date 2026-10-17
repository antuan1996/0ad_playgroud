import * as filters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { QueuePlan } from "./queueplan.ts";
import { Worker } from "./worker.ts";

export class TrainingPlan extends QueuePlan
{
	declare maxMerge: number;
	declare trainers: CommonEntity[] | undefined;

	constructor(gameState: CommonGameState, type: string, metadata?: Record<string, unknown>,
		number: number = 1, maxMerge: number = 5)
	{
		super(gameState, type, metadata);

		// Refine the estimated cost and add pop cost
		const template = this.template;
		const trainers = this.getBestTrainers(gameState);
		const trainer = trainers ? trainers[0] : undefined;
		this.cost = new ResourcesManager(template.cost(trainer), (template.get("Cost/Population") ?? NaN));

		this.category = "unit";
		this.number = number;
		this.maxMerge = maxMerge;
	}

	canStart(gameState: CommonGameState): boolean
	{
		this.trainers = this.getBestTrainers(gameState);
		if (!this.trainers)
			return false;
		const template = this.template;
		this.cost = new ResourcesManager(template.cost(this.trainers[0]), (template.get("Cost/Population") ?? NaN));
		return true;
	}

	getBestTrainers(gameState: CommonGameState): CommonEntity[] | undefined
	{
		if (this.metadata && this.metadata.trainer)
		{
			const trainer = gameState.getEntityById(this.metadata.trainer);
			if (trainer)
				return [trainer];
		}

		let allTrainers = gameState.findTrainers(this.type);
		if (this.metadata && this.metadata.sea)
			allTrainers = allTrainers.filter(filters.byMetadata(PlayerID, "sea", this.metadata.sea));
		if (this.metadata && this.metadata.base)
			allTrainers = allTrainers.filter(filters.byMetadata(PlayerID, "base", this.metadata.base));
		if (!allTrainers || !allTrainers.hasEntities())
			return undefined;

		// Keep only trainers with smallest cost
		let costMin = Math.min();
		let trainers: CommonEntity[] = [];
		for (const ent of allTrainers.values())
		{
			const cost = this.template.costSum(ent);
			if (cost === costMin)
				trainers.push(ent);
			else if (cost < costMin)
			{
				costMin = cost;
				trainers = [ent];
			}
		}
		return trainers;
	}

	start(gameState: CommonGameState): void
	{
		const trainers = this.trainers;
		if (!trainers)
			return;

		if (this.metadata && this.metadata.trainer)
		{
			const metadata: Record<string, unknown> = {};
			for (const key in this.metadata)
				if (key !== "trainer")
					metadata[key] = this.metadata[key];
			this.metadata = metadata;
		}

		if (trainers.length > 1)
		{
			let wantedIndex: number | undefined;
			if (this.metadata && this.metadata.index)
				wantedIndex = this.metadata.index;
			const workerUnit = this.metadata && this.metadata.role &&
				this.metadata.role === Worker.ROLE_WORKER;
			const supportUnit = this.template.hasClass("Support");
			trainers.sort(function(a: CommonEntity, b: CommonEntity): number
			{
				// Prefer training buildings with short queues
				let aa = a.trainingQueueTime() ?? NaN;
				let bb = b.trainingQueueTime() ?? NaN;
				// Give priority to support units in the cc
				if (a.hasClass("Civic") && !supportUnit)
					aa += 10;
				if (b.hasClass("Civic") && !supportUnit)
					bb += 10;
				// And support units should not be too near to dangerous place
				if (supportUnit)
				{
					if (gameState.ai.HQ.isNearInvadingArmy(a.position()))
						aa += 50;
					if (gameState.ai.HQ.isNearInvadingArmy(b.position()))
						bb += 50;
				}
				// Give also priority to buildings with the right accessibility
				const aBase = a.getMetadata(PlayerID, "base");
				const bBase = b.getMetadata(PlayerID, "base");
				if (wantedIndex)
				{
					if (!aBase)
						aa += 30;
					else
					{
						const aBaseManager = gameState.ai.HQ.getBaseByID(aBase);
						if (!aBaseManager || aBaseManager.accessIndex != wantedIndex)
							aa += 30;
					}
					if (!bBase)
						bb += 30;
					else
					{
						const bBaseManager = gameState.ai.HQ.getBaseByID(bBase);
						if (!bBaseManager || bBaseManager.accessIndex != wantedIndex)
							bb += 30;
					}
				}
				// Then, if workers, small preference for bases with less workers
				if (workerUnit && aBase && bBase && aBase != bBase)
				{
					const aBaseManager = gameState.ai.HQ.getBaseByID(aBase);
					const bBaseManager = gameState.ai.HQ.getBaseByID(bBase);
					if (aBaseManager && bBaseManager)
					{
						const apop = aBaseManager.workers.length;
						const bpop = bBaseManager.workers.length;
						if (apop > bpop)
							aa++;
						else if (bpop > apop)
							bb++;
					}
				}
				return aa - bb;
			});
		}

		if (this.metadata && this.metadata.base !== undefined && this.metadata.base === 0)
			this.metadata.base = trainers[0].getMetadata(PlayerID, "base");
		trainers[0].train(gameState.getPlayerCiv(), this.type, this.number, this.metadata);

		this.onStart(gameState);
	}

	addItem(amount: number = 1): void
	{
		this.number += amount;
	}

	Serialize(): {
		category: "unit";
		type: string;
		ID: number;
		metadata: Record<string, unknown> | undefined;
		cost: { amounts: Record<string, number>; population: number };
		number: number;
		maxMerge: number;
	}
	{
		return {
			"category": "unit",
			"type": this.type,
			"ID": this.ID,
			"metadata": this.metadata,
			"cost": this.cost.Serialize(),
			"number": this.number,
			"maxMerge": this.maxMerge
		};
	}

	Deserialize(gameState: CommonGameState, data: ReturnType<TrainingPlan["Serialize"]>): void
	{
		this.category = data.category;
		this.type = data.type;
		this.ID = data.ID;
		this.metadata = data.metadata;
		this.number = data.number;
		this.maxMerge = data.maxMerge;

		this.cost = new ResourcesManager();
		this.cost.Deserialize(data.cost);
	}
}
