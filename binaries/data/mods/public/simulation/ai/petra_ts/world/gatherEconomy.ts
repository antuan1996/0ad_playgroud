/**
 * How fast each resource comes in per gatherer, measured (PLAN.md §3.4,
 * world/; stage 5's economy model).
 *
 * Petra estimated its income from each gatherer's rate while gathering
 * (BasesManager.GetCurrentGatherRates): a woman walking 100 m to far berries
 * counted as one at the bush. Here a resource's rate per gatherer is what the
 * units actually gathering bring in, divided by all its gatherers, those
 * walking and carrying back included, smoothed over about a minute: the walk
 * is in it, so slow food reads slow (FINDINGS §18: food about 0.4 a second per
 * gatherer at minutes 4-10, wood 0.9).
 *
 * The same per food source (berries, fields, hunt, fish): where food comes
 * from is decided on it (decision/foodSource.ts).
 *
 * The headquarters owns one and updates it each of its turns (the gatherer
 * split that read the per-resource rates was dropped, FINDINGS §19).
 */
import { gatherRate, ordersOf } from "../adapter/orders.ts";
import { isInState } from "../adapter/unitState.ts";

/** Seconds over which the rate per gatherer is smoothed (an exponential moving average's time constant). */
export const SMOOTHING = 60;

/**
 * What a gatherer brings in per second before anything is measured, the walk
 * included: stage 5's measured means at minutes 4-10 (FINDINGS §18).
 */
export const PRIOR_RATE: Readonly<Record<string, number>> = { "food": 0.4, "wood": 0.85, "stone": 0.45, "metal": 0.45 };
const DEFAULT_PRIOR = 0.4;

/** The food sources: what a food supply's specific type is. */
export const FOOD_SOURCES = ["fruit", "grain", "meat", "fish"] as const;
export type FoodSource = typeof FOOD_SOURCES[number];

/**
 * What a food gatherer brings in per second before anything is measured, by
 * source, the walk included (FINDINGS §20: a field 0.54 a second at minutes
 * 4-8, berries 0.6-0.75 by the civic centre).
 */
export const FOOD_PRIOR_RATE: Readonly<Record<FoodSource, number>> = { "fruit": 0.6, "grain": 0.55, "meat": 1, "fish": 0.5 };

export type SerializedGatherEconomy = {
	perGatherer: Record<string, number>;
	perFoodGatherer: Partial<Record<FoodSource, number>>;
	lastUpdate: number | undefined;
};

export class GatherEconomy
{
	/** Per resource: units per second per gatherer, the walk included, smoothed. */
	perGatherer: Record<string, number> = {};
	/** Per resource, at the last update: gatherers on it (food: gatherers, hunters, fishers). */
	gatherers: Record<string, number> = {};
	/** Per resource, at the last update: the summed rate of the units gathering it, per second. */
	income: Record<string, number> = {};
	/**
	 * Per resource, at the last update: its gatherers the engine has idle, with
	 * nothing of theirs to gather (a field takes five; the sixth woman waits).
	 */
	idle: Record<string, number> = {};
	/** Per food source: units per second per gatherer, the walk included, smoothed. */
	perFoodGatherer: Partial<Record<FoodSource, number>> = {};
	/** Per food source, at the last update: its gatherers. */
	foodGatherers: Record<FoodSource, number> = { "fruit": 0, "grain": 0, "meat": 0, "fish": 0 };
	/** Game seconds of the last update. */
	lastUpdate: number | undefined;

	/** Units per second a gatherer on a food source can be expected to bring in. */
	foodRateOf(source: FoodSource): number
	{
		return this.perFoodGatherer[source] ?? FOOD_PRIOR_RATE[source];
	}

	/**
	 * Where a food gatherer's food comes from: the supply its order names, or
	 * while it carries back to a dropsite, the supply of the order after. One
	 * whose supply is gone carries back from berries picked clean (the fields
	 * and the hunt last: FINDINGS §20), so it counts on the berries' side;
	 * hunters and fishers without a target count as theirs.
	 */
	foodSourceOf(gameState: CommonGameState, ent: CommonEntity, subrole: string | undefined): FoodSource
	{
		for (const data of ordersOf(ent).slice(0, 2))
		{
			const target = data.target === undefined ? undefined : gameState.getEntityById(data.target);
			const specific = target?.resourceSupplyType()?.specific;
			if (specific === "fruit" || specific === "grain" || specific === "meat" || specific === "fish")
				return specific;
			if (target && !target.resourceSupplyType())
				continue;	// a dropsite: the supply is the next order's
			break;
		}
		return subrole === "hunter" ? "meat" : subrole === "fisher" ? "fish" : "fruit";
	}

	/** Units per second a new gatherer on `resource` can be expected to bring in. */
	rateOf(resource: string): number
	{
		return this.perGatherer[resource] ?? PRIOR_RATE[resource] ?? DEFAULT_PRIOR;
	}

	/** Counts the gatherers and what they gather now, and folds it into the rates per gatherer. */
	update(gameState: CommonGameState): void
	{
		const gatherers: Record<string, number> = {};
		const income: Record<string, number> = {};
		const idle: Record<string, number> = {};
		const foodGatherers: Record<FoodSource, number> = { "fruit": 0, "grain": 0, "meat": 0, "fish": 0 };
		const foodIncome: Record<FoodSource, number> = { "fruit": 0, "grain": 0, "meat": 0, "fish": 0 };
		for (const res of Resources.GetCodes())
		{
			gatherers[res] = 0;
			income[res] = 0;
			idle[res] = 0;
		}
		for (const ent of gameState.getOwnEntitiesByRole("worker", true).values())
		{
			const subrole = ent.getMetadata(PlayerID, "subrole");
			let res: string | undefined;
			if (subrole === "gatherer")
				res = ent.getMetadata(PlayerID, "gather-type");
			else if (subrole === "hunter" || subrole === "fisher")
				res = "food";
			if (res === undefined || !(res in gatherers) || !ent.position())
				continue;
			++gatherers[res];
			const rate = isInState(ent, "INDIVIDUAL.GATHER.GATHERING") ? gatherRate(gameState, ent) ?? 0 : 0;
			income[res] += rate;
			if (!rate && ent.isIdle())
				++idle[res];
			if (res === "food")
			{
				const source = this.foodSourceOf(gameState, ent, subrole);
				++foodGatherers[source];
				foodIncome[source] += rate;
			}
		}
		this.gatherers = gatherers;
		this.income = income;
		this.idle = idle;
		this.foodGatherers = foodGatherers;

		const now = gameState.ai.elapsedTime;
		// the first update only sets the prior: the gatherers have only begun to walk
		const weight = this.lastUpdate === undefined ? 0 : 1 - Math.exp(-(now - this.lastUpdate) / SMOOTHING);
		this.lastUpdate = now;
		for (const res in gatherers)
		{
			if (!gatherers[res])
				continue;
			const measured = income[res] / gatherers[res];
			this.perGatherer[res] = this.rateOf(res) * (1 - weight) + measured * weight;
		}
		for (const source of FOOD_SOURCES)
			if (foodGatherers[source])
				this.perFoodGatherer[source] = this.foodRateOf(source) * (1 - weight) +
					foodIncome[source] / foodGatherers[source] * weight;
	}

	Serialize(): SerializedGatherEconomy
	{
		return { "perGatherer": this.perGatherer, "perFoodGatherer": this.perFoodGatherer, "lastUpdate": this.lastUpdate };
	}

	Deserialize(data: SerializedGatherEconomy): void
	{
		this.perGatherer = data.perGatherer;
		this.perFoodGatherer = data.perFoodGatherer;
		this.lastUpdate = data.lastUpdate;
	}
}
