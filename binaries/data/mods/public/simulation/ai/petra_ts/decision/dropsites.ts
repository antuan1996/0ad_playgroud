/**
 * The dropsites (stage 5's economy module, PLAN.md §6.1): whether a base's
 * gatherers of a resource walk too much and want a dropsite nearer, from a
 * tally of them over many turns (those gathering against those carrying
 * back), and how good a place must be. Petra's rule, lifted out of the base
 * manager unchanged.
 */

/** A dropsite place's quality (findBestDropsiteAndLocation) worth building on. */
export const GOOD_DROPSITE = 50;
/** The share of the tally carrying back above which the gatherers want a dropsite nearer. */
const WALKING = 0.15;

/**
 * Wait (too few samples yet: 150 for wood, 60 for the others), fine (few
 * carry back), or closer (a dropsite nearer is wanted).
 */
export type DropsiteVerdict = "wait" | "fine" | "closer";

export function dropsiteVerdict(type: string, gathering: number, carrying: number): DropsiteVerdict
{
	const total = gathering + carrying;
	if (total <= 60 || total <= 150 && type === "wood")
		return "wait";
	return carrying / total > WALKING ? "closer" : "fine";
}

/**
 * The quality a place must have when no good one is left and no new base can
 * be planned: the more the gatherers walk, the lower, to 25 at most.
 */
export function relaxedDropsiteQuality(gathering: number, carrying: number): number
{
	return Math.min(25, GOOD_DROPSITE * WALKING / (carrying / (gathering + carrying)));
}
