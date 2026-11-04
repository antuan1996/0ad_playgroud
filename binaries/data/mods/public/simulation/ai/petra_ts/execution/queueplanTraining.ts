import * as filters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { type PlanMetadata, type PlanStart, QueuePlan } from "./queueplan.ts";
import { Worker } from "./worker.ts";
import { hqOf } from "./hq.ts";
import { isPlaced } from "../adapter/placed.ts";

/** Buildings that may train a plan's units: never empty. */
type Trainers = [CommonPlacedEntity, ...CommonPlacedEntity[]];

function atLeastOne<E>(list: E[]): [E, ...E[]] | undefined
{
	const [first, ...rest] = list;
	return first === undefined ? undefined : [first, ...rest];
}

export class TrainingPlan extends QueuePlan<CommonTemplate, "unit">
{
	maxMerge: number;

	constructor(gameState: CommonGameState, type: string, metadata?: PlanMetadata,
		number: number = 1, maxMerge: number = 5)
	{
		const name = gameState.applyCiv(type);
		super(gameState, name, gameState.getTemplate(name), "unit", metadata);

		// Refine the estimated cost and add pop cost
		const template = this.template;
		const trainers = this.getBestTrainers(gameState);
		this.cost = new ResourcesManager(template.cost(trainers?.[0]), Number(template.get("Cost/Population")));

		this.number = number;
		this.maxMerge = maxMerge;
	}

	canStart(gameState: CommonGameState): PlanStart | undefined
	{
		const trainers = this.getBestTrainers(gameState);
		if (!trainers)
			return undefined;
		const template = this.template;
		this.cost = new ResourcesManager(template.cost(trainers[0]), Number(template.get("Cost/Population")));
		return () => this.start(gameState, trainers);
	}

	/** The cheapest buildings that may train the units, at least one; undefined when none may. */
	getBestTrainers(gameState: CommonGameState): Trainers | undefined
	{
		if (this.metadata && this.metadata.trainer)
		{
			const trainer = gameState.getEntityById(this.metadata.trainer);
			if (trainer && isPlaced(trainer))
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
		let trainers: CommonPlacedEntity[] = [];
		for (const ent of allTrainers.values())
		{
			// a trainer is a structure: on the map
			if (!isPlaced(ent))
				continue;
			const cost = this.template.costSum(ent);
			if (cost === costMin)
				trainers.push(ent);
			else if (cost < costMin)
			{
				costMin = cost;
				trainers = [ent];
			}
		}
		return atLeastOne(trainers);
	}

	/** Trains the units at the best of the buildings canStart found. */
	private start(gameState: CommonGameState, trainers: Trainers): void
	{
		if (this.metadata && this.metadata.trainer)
		{
			const { trainer, ...metadata } = this.metadata;
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
			trainers.sort(function(a, b): number
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
					if (hqOf(gameState).isNearInvadingArmy(a.position()))
						aa += 50;
					if (hqOf(gameState).isNearInvadingArmy(b.position()))
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
						const aBaseManager = hqOf(gameState).getBaseByID(aBase);
						if (!aBaseManager || aBaseManager.accessIndex !== wantedIndex)
							aa += 30;
					}
					if (!bBase)
						bb += 30;
					else
					{
						const bBaseManager = hqOf(gameState).getBaseByID(bBase);
						if (!bBaseManager || bBaseManager.accessIndex !== wantedIndex)
							bb += 30;
					}
				}
				// Then, if workers, small preference for bases with less workers
				if (workerUnit && aBase && bBase && aBase !== bBase)
				{
					const aBaseManager = hqOf(gameState).getBaseByID(aBase);
					const bBaseManager = hqOf(gameState).getBaseByID(bBase);
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
		type: TemplateName;
		ID: number;
		metadata: PlanMetadata | undefined;
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

	/** A saved plan: its id, metadata and cost from the save */
	static restore(gameState: CommonGameState, data: ReturnType<TrainingPlan["Serialize"]>): TrainingPlan
	{
		const plan = new TrainingPlan(gameState, data.type);
		plan.resume(data);
		return plan;
	}

	private resume(data: ReturnType<TrainingPlan["Serialize"]>): void
	{
		this.type = data.type;
		this.ID = data.ID;
		this.metadata = data.metadata;
		this.number = data.number;
		this.maxMerge = data.maxMerge;

		this.cost = new ResourcesManager();
		this.cost.Deserialize(data.cost);
	}
}
