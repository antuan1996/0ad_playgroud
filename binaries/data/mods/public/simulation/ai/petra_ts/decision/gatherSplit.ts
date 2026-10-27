/**
 * Not wired into the bot (FINDINGS §19): as the gatherer split, its variants
 * played 42-52% against the version before them, so pickMostNeededResources
 * keeps Petra's order; kept, with its property tests, for the decisions that
 * need a share of the gatherers (where food comes from, PLAN.md §6).
 *
 * How many gatherers each resource should have (stage 5's first utility
 * decision, PLAN.md §6): pure, over what the queues want (QueueManager.
 * gatherDemand: the costs of what is queued, and the reserve floors, in
 * units per second) and what a gatherer brings in (world/gatherEconomy.ts,
 * the walk included).
 *
 * Income should follow demand: with each resource's income in proportion to
 * the rate the queues want, everything queued becomes affordable at about the
 * same time, and no resource piles up while another holds the queues back.
 * So resource r gets a share of the gatherers in proportion to the gatherers
 * its demand takes, wanted_r / rate_r: a resource that comes slowly per
 * gatherer needs more of them for the same income.
 *
 * Petra compared the wanted rates with an estimate of the current income
 * that counted a walking gatherer as one at the supply, and moved a gatherer
 * when the gap passed a fixed threshold; here the decision is made in
 * gatherers, against the measured rate.
 */

/** One resource as the split sees it. */
export interface GatherNeed
{
	type: string;
	/** units per second the queues want */
	wanted: number;
	/** units per second it brings in now */
	current: number;
	/** gatherers it has (and has been given this turn) */
	gatherers: number;
	/** gatherers it should have */
	target: number;
}

/** A gatherer is moved only when the two resources' deficits differ by at least this many gatherers. */
export const SWITCH_GAP = 2;

/**
 * The gatherers each resource should have, of `total`. What is queued is paid
 * for by income in proportion to its costs, so a resource takes the
 * gatherers its cost rate needs, costs / rate. A reserve floor (stock below
 * the config's short-queue amounts) is no purchase: it takes its wanted rate
 * as gatherers, whatever the resource's rate, so a slow resource with only a
 * reserve to fill does not draw gatherers off the ones that pay for the
 * queues (FINDINGS §19: weighted by its rate, metal's reserve cost wood).
 * With nothing wanted, the gatherers stay where they are.
 */
export function targetGatherers(total: number, costs: Readonly<Record<string, number>>,
	floors: Readonly<Record<string, number>>, rate: Readonly<Record<string, number>>,
	gatherers: Readonly<Record<string, number>>): Record<string, number>
{
	const weights: Record<string, number> = {};
	let sum = 0;
	for (const res in costs)
	{
		weights[res] = Math.max(0, costs[res]) / Math.max(rate[res] ?? 0, 0.05) + Math.max(0, floors[res] ?? 0);
		sum += weights[res];
	}
	const target: Record<string, number> = {};
	for (const res in costs)
		target[res] = sum > 0 ? total * weights[res] / sum : gatherers[res] ?? 0;
	return target;
}

/**
 * The targets, none above what a saturated resource employs: a resource whose
 * gatherers stand idle (its fields full, its supplies taken) gains nothing by
 * one more, whatever its share, so its target is the gatherers at work, and
 * the share it cannot use goes to the others, in proportion to theirs. The
 * share alone rewards saturation: idle gatherers lower the measured rate, and
 * a lower rate asks for more gatherers (FINDINGS §19: 82 women on 14 fields,
 * ten of them idle for minutes).
 */
export function capAtSaturation(target: Readonly<Record<string, number>>, gatherers: Readonly<Record<string, number>>,
	idle: Readonly<Record<string, number>>): Record<string, number>
{
	const capped: Record<string, number> = {};
	let freed = 0;
	let open = 0;
	for (const res in target)
	{
		const working = (gatherers[res] ?? 0) - (idle[res] ?? 0);
		if (idle[res] && target[res] > working)
		{
			capped[res] = working;
			freed += target[res] - working;
		}
		else
		{
			capped[res] = target[res];
			if (!idle[res])
				open += target[res];
		}
	}
	if (freed > 0 && open > 0)
		for (const res in target)
			if (!idle[res])
				capped[res] += freed * target[res] / open;
	return capped;
}

/** A resource's deficit: the gatherers it lacks (negative: has too many). */
export function deficit(need: GatherNeed): number
{
	return need.target - need.gatherers;
}

/**
 * The needs, most short of gatherers first; the more wanted first among
 * equals; and those with no target (nothing queued, no reserve to fill) after
 * all others, however their deficits compare: a gatherer that cannot go to
 * the first (its supplies failed, or are exhausted) goes to an over-staffed
 * resource that is wanted, not to one nobody wants (FINDINGS §19: ranked by
 * deficit alone, an unwanted resource's 0 came before a wanted one's -1, and
 * metal took the gatherers food turned away).
 */
export function byDeficit(needs: GatherNeed[]): GatherNeed[]
{
	const wanted = (need: GatherNeed): number => need.target > 0 ? 1 : 0;
	return [...needs].sort((a, b) => wanted(b) - wanted(a) || deficit(b) - deficit(a) || b.wanted - a.wanted);
}

/** Whether moving a gatherer from `from` to `to` brings the split closer to its targets. */
export function worthSwitching(from: GatherNeed, to: GatherNeed): boolean
{
	return deficit(to) - deficit(from) >= SWITCH_GAP;
}
