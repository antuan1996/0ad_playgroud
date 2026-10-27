/**
 * Where food comes from (stage 5's second domain, PLAN.md §6): the berries or
 * fields by a farmstead, decided by what a gatherer brings in from each,
 * measured (world/gatherEconomy.ts, the walk included).
 *
 * Petra queued its first field once the berries within reach fell below 600
 * food, whatever they brought in, and then kept a fixed number of fields in
 * progress. But berries slow down long before they run out: their gatherers
 * walk to bushes ever further from a dropsite (trips of 40 at minutes 0-2,
 * 130-150 by minutes 6-10) and back from the ones they picked clean, gathering
 * 40% of the time against a field's 90% (FINDINGS §20). Here a field is
 * wanted as soon as a gatherer brings in more there than at the berries.
 */

/** Below this many gatherers on the berries, their measured rate is too few samples to act on. */
export const MIN_BERRY_GATHERERS = 3;

/** What the food-source decision reads. */
export interface FoodRates
{
	/** units per second a gatherer brings in from the berries, the walk included */
	fruit: number;
	/** the same at a field */
	grain: number;
	/** gatherers on the berries now */
	fruitGatherers: number;
}

/** Whether a gatherer would bring in more at a field than at the berries, measured on enough berry gatherers. */
export function fieldsBeatBerries(rates: Readonly<FoodRates>): boolean
{
	return rates.fruitGatherers >= MIN_BERRY_GATHERERS && rates.fruit < rates.grain;
}
