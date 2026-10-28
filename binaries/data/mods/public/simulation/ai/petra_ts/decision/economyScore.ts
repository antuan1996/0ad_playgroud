/**
 * The economy's options on one scale (stage 5's scoring module, PLAN.md
 * §6.1): the seconds an option takes to pay back what it costs from the
 * income it adds, measured (world/gatherEconomy.ts, the walk included). The
 * sooner an option pays back, the better a buy it is now.
 *
 * Its first use is research (FINDINGS §28): Petra queued its economy
 * techs at the research queue's priority, below the women's, the soldiers',
 * the houses' and the fields', so the plough came at minute 11.6 with 26-40
 * women on the fields since minute 4; a tech that pays back within the four
 * minutes after it is bought now goes before the women.
 */
import type { GatherEconomy } from "../world/gatherEconomy.ts";

const RATES = "ResourceGatherer/Rates/";

/**
 * Seconds within which an option must pay back to be bought before the
 * women: a game is decided at minute 28 (median), and what pays back in
 * four minutes has paid for itself several times by then.
 */
export const PAYBACK_HORIZON = 240;

/**
 * What our gatherers of one supply type ("food.grain", "wood.tree", ...)
 * bring in per second now, the walk included.
 */
export function incomeOf(economy: Readonly<GatherEconomy>, type: string): number
{
	const [generic, specific] = type.split(".");
	if (generic === "food")
	{
		if (specific === "fruit" || specific === "grain" || specific === "meat" || specific === "fish")
			return economy.foodGatherers[specific] * economy.foodRateOf(specific);
		return 0;
	}
	return (economy.gatherers[generic] ?? 0) * economy.rateOf(generic);
}

/**
 * The income per second a technology's modifications add: for each gather
 * rate it multiplies, what that supply type brings in times the gain. Other
 * effects (capacities, speeds, armour) count nothing here.
 */
export function incomeGain(economy: Readonly<GatherEconomy>, modifications: readonly CommonTechnologyModification[]): number
{
	let gain = 0;
	for (const modification of modifications)
		if (modification.value.startsWith(RATES) && modification.multiply !== undefined)
			gain += (modification.multiply - 1) * incomeOf(economy, modification.value.slice(RATES.length));
	return gain;
}

/** Seconds until an option pays back: the time it takes to have, then its cost over the income it adds. */
export function paybackSeconds(cost: number, delay: number, gain: number): number
{
	return gain > 0 ? delay + cost / gain : Infinity;
}
