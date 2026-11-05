import type { Config } from "../world/config.ts";
import type { Queue } from "./queue.ts";

/** The queues in the order the queue manager funds them, with their names */
type QueueOrder = ReadonlyArray<[PetraRuntime.QueueName, Queue]>;

/**
 * Adds the costs of the first items of the unpaused queues to the totals of
 * their horizon: the first item ready to go in 30 s (short), the second in
 * 60 s (medium), one not yet ready in 300 s (long).
 */
function addQueuedCosts(
	gameState: CommonGameState,
	queueOrder: QueueOrder,
	totalShort: Record<string, number>,
	totalMedium: Record<string, number>,
	totalLong: Record<string, number>,
): void
{
	let total;
	// queueArrays because it's faster.
	for (const q of queueOrder)
	{
		const queue = q[1];
		if (queue.paused)
		{
			continue;
		}
		for (let j = 0; j < queue.length(); ++j)
		{
			if (j > 1)
			{
				break;
			}
			const cost = queue.plans[j].getCost();
			if (queue.plans[j].isGo(gameState))
			{
				if (j === 0)
				{
					total = totalShort;
				}
				else
				{
					total = totalMedium;
				}
			}
			else
			{
				total = totalLong;
			}
			for (const type in total)
			{
				total[type] += cost[type];
			}
			if (!queue.plans[j].isGo(gameState))
			{
				break;
			}
		}
	}
}

/** What the queues hold, by horizon (short, medium, long), on top of `initial`'s amounts per resource. */
function queuedTotals(
	gameState: CommonGameState,
	queueOrder: QueueOrder,
	initial: (res: string) => [number, number, number],
): { totalShort: Record<string, number>; totalMedium: Record<string, number>; totalLong: Record<string, number>; }
{
	const totalShort: Record<string, number> = {};
	const totalMedium: Record<string, number> = {};
	const totalLong: Record<string, number> = {};
	for (const res of Resources.GetCodes())
	{
		[totalShort[res], totalMedium[res], totalLong[res]] = initial(res);
	}
	addQueuedCosts(gameState, queueOrder, totalShort, totalMedium, totalLong);
	return { totalShort, totalMedium, totalLong };
}

/**
 * What the gatherers are wanted for, in two parts (decision/gatherSplit.ts):
 * `costs`, the rates that pay for what is queued over the horizons of
 * wantedGatherRates, the stock spent on them first; and `floors`, the rate
 * that brings what stock is left up to the config's short-queue amounts
 * (Config.queues.short: a reserve, not a purchase) within 30 s. On the first
 * turn, before any queue is set, the config's first-turn rates are costs.
 */
export function gatherDemand(
	gameState: CommonGameState,
	config: Config,
	queueOrder: QueueOrder,
): { costs: Record<string, number>; floors: Record<string, number>; }
{
	const costs: Record<string, number> = {};
	const floors: Record<string, number> = {};
	if (gameState.ai.playedTurn === 0)
	{
		for (const res of Resources.GetCodes())
		{
			costs[res] = config.queues.firstTurn[res] || config.queues.firstTurn.default;
			floors[res] = 0;
		}
		return { costs, floors };
	}
	const stock = gameState.getResources();
	const { totalShort, totalMedium, totalLong } = queuedTotals(gameState, queueOrder, () => [0, 0, 0]);
	for (const res of Resources.GetCodes())
	{
		let left = Math.max(0, stock[res]);
		const short = Math.max(0, totalShort[res] - left);
		left = Math.max(0, left - totalShort[res]);
		const medium = Math.max(0, totalMedium[res] - left);
		left = Math.max(0, left - totalMedium[res]);
		const long = Math.max(0, totalLong[res] - left);
		left = Math.max(0, left - totalLong[res]);
		costs[res] = short / 30 + medium / 60 + long / 300;
		const reserve = config.queues.short[res] || config.queues.short.default;
		floors[res] = Math.max(0, reserve - left) / 30;
	}
	return { costs, floors };
}

// calculate the gather rates we'd want to be able to start all elements in our queues
// TODO: many things.
export function wantedGatherRates(
	gameState: CommonGameState,
	config: Config,
	queueOrder: QueueOrder,
): PetraRuntime.Dict<number>
{
	// default values for first turn when we have not yet set our queues.
	if (gameState.ai.playedTurn === 0)
	{
		const ret: Record<string, number> = {};
		for (const res of Resources.GetCodes())
		{
			ret[res] = config.queues.firstTurn[res] || config.queues.firstTurn.default;
		}
		return ret;
	}

	// get out current resources, not removing accounts.
	const current = gameState.getResources();
	// short queue is the first item of a queue, assumed to be ready in 30s
	// medium queue is the second item of a queue, assumed to be ready in 60s
	// long queue contains the isGo=false items, assumed to be ready in 300s
	const { totalShort, totalMedium, totalLong } = queuedTotals(
		gameState,
		queueOrder,
		(
			res,
		) => [
			config.queues.short[res] || config.queues.short.default,
			config.queues.medium[res] || config.queues.medium.default,
			config.queues.long[res] || config.queues.long.default,
		],
	);
	// global rates
	const rates: Record<string, number> = {};
	let diff;
	for (const res of Resources.GetCodes())
	{
		if (current[res] > 0)
		{
			diff = Math.min(current[res], totalShort[res]);
			totalShort[res] -= diff;
			current[res] -= diff;
			if (current[res] > 0)
			{
				diff = Math.min(current[res], totalMedium[res]);
				totalMedium[res] -= diff;
				current[res] -= diff;
				if (current[res] > 0)
				{
					totalLong[res] -= Math.min(current[res], totalLong[res]);
				}
			}
		}
		rates[res] = totalShort[res] / 30 + totalMedium[res] / 60 + totalLong[res] / 300;
	}
	return rates;
}
