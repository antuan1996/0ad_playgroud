import { batchSize } from "./workforce.ts";

/**
 * The build-order planner's model (PLAN.md §6.3.2): where the economy and the army will be some minutes on, from
 * where they are now and the workforce settings, in steps of STEP seconds. Pure: the same state and settings give
 * the same forecast.
 *
 * - Income: every gatherer brings in its resource's measured rate (world/gatherEconomy.ts, the walk included); a
 *   new unit gathers as the present gatherers do, in the same split.
 * - Training: each trainer trains a batch at a time (workforce.ts batchSize, as Petra queues them, cut to what the
 *   stock pays and the population houses), in `seconds x n^batchModifier` (the engine's Trainer.GetBatchTime);
 *   a civic centre trains support units up to their cap, then citizen soldiers (nextAtCentre); a barracks trains
 *   soldiers; the batches queued now are trained first, already paid for.
 * - Houses: one is built when the room left falls under a batch, and the wood is there.
 *
 * The soldiers counted are the citizen soldiers, who gather too: the head count of §46, where the winner had some
 * 20 more at minute 13.
 */

/** Seconds of one step of the forecast. */
export const STEP = 10;

/** What a batch trains: support units, citizen soldiers, or other units (they take room, and are not counted). */
export type BatchKind = "support" | "soldier" | "other";

/** A batch in a trainer's queue: what, how many, and the seconds it takes (the first one: the seconds left). */
export type QueuedBatch = { kind: BatchKind; count: number; seconds: number; };

/** A trainer: whether it is a civic centre (support units and soldiers) or a barracks (soldiers), and its queue. */
export type Trainer = { centre: boolean; queue: readonly QueuedBatch[]; };

/** A unit we train: its cost and its training time in seconds. */
export type TrainedUnit = { cost: Readonly<Record<string, number>>; seconds: number; };

/** The economy and army now, as the forecast starts from it. */
export type EconomyState = {
	/** game seconds */
	time: number;
	stock: Readonly<Record<string, number>>;
	/** gatherers per resource, and what one brings in a second */
	gatherers: Readonly<Record<string, number>>;
	ratePerGatherer: Readonly<Record<string, number>>;
	supports: number;
	soldiers: number;
	population: number;
	popLimit: number;
	popMax: number;
	/** civic centres and barracks able to train, with the batches already paid for in their queues */
	trainers: readonly Trainer[];
	/** the trainers' Trainer/BatchTimeModifier (0.8 for civic centres and barracks) */
	batchModifier: number;
	support: TrainedUnit;
	soldier: TrainedUnit;
	house: { cost: Readonly<Record<string, number>>; seconds: number; room: number; };
};

/** The workforce settings the planner chooses between. */
export type WorkforceSettings = { supportRatio: number; targetWorkers: number; };

/** Where the forecast ends. */
export type Forecast = { time: number; supports: number; soldiers: number; population: number; gathered: number; };

/** The state as the simulation changes it. */
type Running = {
	time: number;
	stock: Record<string, number>;
	gatherers: Record<string, number>;
	supports: number;
	soldiers: number;
	population: number;
	popLimit: number;
	gathered: number;
	/** seconds left on each trainer's unit, and what it trains: centres first */
	trainers: Array<
		{ left: number; unit: BatchKind | undefined; count: number; centre: boolean; queue: QueuedBatch[]; }
	>;
	houseLeft: number;
};

const affordable = (stock: Readonly<Record<string, number>>, cost: Readonly<Record<string, number>>): boolean =>
	Object.keys(cost).every((r) => (stock[r] ?? 0) >= cost[r]);

function pay(stock: Record<string, number>, cost: Readonly<Record<string, number>>): void
{
	for (const r in cost)
	{
		stock[r] = (stock[r] ?? 0) - cost[r];
	}
}

/** A step's income, from each resource's gatherers. */
function gather(run: Running, state: EconomyState): void
{
	for (const r in run.gatherers)
	{
		const amount = run.gatherers[r] * (state.ratePerGatherer[r] ?? 0) * STEP;
		run.stock[r] = (run.stock[r] ?? 0) + amount;
		run.gathered += amount;
	}
}

/** A new worker joins the gatherers, as they are split now. */
function joinGatherers(run: Running): void
{
	const total = Object.values(run.gatherers).reduce((a, b) => a + b, 0);
	for (const r in run.gatherers)
	{
		run.gatherers[r] += total > 0 ? run.gatherers[r] / total : 1 / Object.keys(run.gatherers).length;
	}
}

/**
 * What a centre trains next: support units until their cap (`supportRatio x target`), then citizen soldiers. The
 * share's curve (workforce.ts supportShare) decides which queue a new worker goes to, but the support units' queue
 * is funded first (FINDINGS §24), so the centre trains them while any are queued: in the games the support units
 * come first, and level off at their cap (FINDINGS §58).
 */
function nextAtCentre(run: Running, settings: WorkforceSettings): "support" | "soldier"
{
	return run.supports + inTraining(run, "support") < settings.supportRatio * settings.targetWorkers ?
		"support" :
		"soldier";
}

/** A finished batch: its units join, those who gather among the gatherers. */
function finish(run: Running, trainer: Running["trainers"][number]): void
{
	for (let i = 0; i < trainer.count; ++i)
	{
		if (trainer.unit === "support")
		{
			++run.supports;
		}
		else if (trainer.unit === "soldier")
		{
			++run.soldiers;
		}
		if (trainer.unit !== "other")
		{
			joinGatherers(run);
		}
	}
	trainer.unit = undefined;
}

/** The trainer's next batch: the next one queued (paid for, its room taken when queued), else a new one. */
function startNext(
	run: Running,
	state: EconomyState,
	settings: WorkforceSettings,
	trainer: Running["trainers"][number],
): boolean
{
	const queued = trainer.queue.shift();
	if (queued)
	{
		trainer.unit = queued.kind;
		trainer.count = queued.count;
		trainer.left = queued.seconds;
		return true;
	}
	return startBatch(run, state, trainer, trainer.centre ? nextAtCentre(run, settings) : "soldier", settings);
}

/**
 * A step of the trainers, the time used through it: a batch that ends within the step lets the next start at once
 * (a step of 10 s took a 14 s batch for 20 s otherwise).
 */
function train(run: Running, state: EconomyState, settings: WorkforceSettings): void
{
	for (const trainer of run.trainers)
	{
		let time = STEP;
		while (time > 0)
		{
			if (!trainer.unit && !startNext(run, state, settings, trainer))
			{
				break;
			}
			if (trainer.left > time)
			{
				trainer.left -= time;
				break;
			}
			time -= trainer.left;
			finish(run, trainer);
		}
	}
}

/** A trainer starts the biggest batch of `unit` the stock pays and the population houses, up to batchSize. */
function startBatch(
	run: Running,
	state: EconomyState,
	trainer: Running["trainers"][number],
	unit: "support" | "soldier",
	settings: WorkforceSettings,
): boolean
{
	const spec = unit === "support" ? state.support : state.soldier;
	const room = Math.min(run.popLimit, state.popMax) - run.population;
	// no more support units than their cap leaves
	const wanted = unit === "support" ?
		Math.ceil(settings.supportRatio * settings.targetWorkers - run.supports - inTraining(run, "support")) :
		Infinity;
	let count = 0;
	while (count < Math.min(batchSize(run.supports + run.soldiers), room, wanted) && affordable(run.stock, spec.cost))
	{
		pay(run.stock, spec.cost);
		++count;
	}
	if (!count)
	{
		return false;
	}
	run.population += count;
	trainer.unit = unit;
	trainer.count = count;
	trainer.left = spec.seconds * Math.pow(count, state.batchModifier);
	return true;
}

/** The units of a kind in training at the trainers now. */
function inTraining(run: Running, kind: BatchKind): number
{
	return run.trainers.reduce((sum, t) => sum + (t.unit === kind ? t.count : 0), 0);
}

/** A step of the housing: a house started when the room left falls under five, finished after its build time. */
function house(run: Running, state: EconomyState): void
{
	if (run.houseLeft > 0)
	{
		run.houseLeft -= STEP;
		if (run.houseLeft <= 0)
		{
			run.popLimit += state.house.room;
		}
		return;
	}
	if (run.popLimit - run.population < 5 && run.popLimit < state.popMax && affordable(run.stock, state.house.cost))
	{
		pay(run.stock, state.house.cost);
		run.houseLeft = state.house.seconds;
	}
}

/** The economy and army at `until` (game seconds), from `state` under `settings`. */
export function forecast(state: EconomyState, settings: WorkforceSettings, until: number): Forecast
{
	const trainers: Running["trainers"] = state.trainers.map((t) => ({
		left: 0,
		unit: undefined,
		count: 0,
		centre: t.centre,
		queue: [...t.queue],
	}));
	const run: Running = {
		time: state.time,
		stock: { ...state.stock },
		gatherers: { ...state.gatherers },
		supports: state.supports,
		soldiers: state.soldiers,
		population: state.population,
		popLimit: state.popLimit,
		gathered: 0,
		trainers,
		houseLeft: 0,
	};
	while (run.time + STEP <= until)
	{
		run.time += STEP;
		gather(run, state);
		train(run, state, settings);
		house(run, state);
	}
	return {
		time: run.time,
		supports: run.supports,
		soldiers: run.soldiers,
		population: run.population,
		gathered: Math.round(run.gathered),
	};
}
