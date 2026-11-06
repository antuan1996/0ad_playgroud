import * as filters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { isPlaced } from "../adapter/placed.ts";
import { hqOf } from "./hq.ts";
import { QueuePlan, type PlanMetadata, type PlanStart } from "./queueplan.ts";
import { Worker } from "./worker.ts";

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

	constructor(
		gameState: CommonGameState,
		type: string,
		metadata?: PlanMetadata,
		number: number = 1,
		maxMerge: number = 5,
	)
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
		{
			return undefined;
		}
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
			{
				return [trainer];
			}
		}

		let allTrainers = gameState.findTrainers(this.type);
		if (this.metadata && this.metadata.sea)
		{
			allTrainers = allTrainers.filter(filters.byMetadata(PlayerID, "sea", this.metadata.sea));
		}
		if (this.metadata && this.metadata.base)
		{
			allTrainers = allTrainers.filter(filters.byMetadata(PlayerID, "base", this.metadata.base));
		}
		if (!allTrainers || !allTrainers.hasEntities())
		{
			return undefined;
		}

		// Keep only trainers with smallest cost
		let costMin = Math.min();
		let trainers: CommonPlacedEntity[] = [];
		for (const ent of allTrainers.values())
		{
			// a trainer is a structure: on the map
			if (!isPlaced(ent))
			{
				continue;
			}
			const cost = this.template.costSum(ent);
			if (cost === costMin)
			{
				trainers.push(ent);
			}
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
			trainers.sort(this.trainerOrder(gameState));
		}

		if (this.metadata && this.metadata.base !== undefined && this.metadata.base === 0)
		{
			this.metadata.base = trainers[0].getMetadata(PlayerID, "base");
		}
		trainers[0].train(gameState.getPlayerCiv(), this.type, this.number, this.metadata);

		this.onStart(gameState);
	}

	/**
	 * Which building trains first: the shortest queue, a barracks before the
	 * civic centre for soldiers, support units away from an invading army,
	 * the wanted land, and for workers the town with fewer of them.
	 */
	private trainerOrder(gameState: CommonGameState): (a: CommonPlacedEntity, b: CommonPlacedEntity) => number
	{
		const wantedIndex = this.metadata && this.metadata.index ? this.metadata.index : undefined;
		const workerUnit = this.metadata && this.metadata.role && this.metadata.role === Worker.ROLE_WORKER;
		const supportUnit = this.template.hasClass("Support");
		const hq = hqOf(gameState);
		// a building's own score: its queue, raised for the civic centre, danger and the wrong land
		const score = (ent: CommonPlacedEntity): number =>
		{
			let value = ent.trainingQueueTime() ?? NaN;
			if (ent.hasClass("Civic") && !supportUnit)
			{
				value += 10;
			}
			if (supportUnit && hq.isNearInvadingArmy(ent.position()))
			{
				value += 50;
			}
			if (wantedIndex)
			{
				const base = ent.getMetadata(PlayerID, "base");
				const baseManager = base ? hq.basesManager.getBaseByID(base) : undefined;
				if (!baseManager || baseManager.accessIndex !== wantedIndex)
				{
					value += 30;
				}
			}
			return value;
		};
		return (a, b): number =>
		{
			let aa = score(a);
			let bb = score(b);
			// Then, if workers, small preference for bases with less workers
			const aBase = a.getMetadata(PlayerID, "base");
			const bBase = b.getMetadata(PlayerID, "base");
			if (workerUnit && aBase && bBase && aBase !== bBase)
			{
				const apop = hq.basesManager.getBaseByID(aBase)?.workers.length;
				const bpop = hq.basesManager.getBaseByID(bBase)?.workers.length;
				if (apop !== undefined && bpop !== undefined)
				{
					if (apop > bpop)
					{
						aa++;
					}
					else if (bpop > apop)
					{
						bb++;
					}
				}
			}
			return aa - bb;
		};
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
		cost: { amounts: Record<string, number>; population: number; };
		number: number;
		maxMerge: number;
	}
	{
		return { ...this.serializeBase("unit"), maxMerge: this.maxMerge };
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
		this.resumeBase(data);
		this.maxMerge = data.maxMerge;
	}
}
