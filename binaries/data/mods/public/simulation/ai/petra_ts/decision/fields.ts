/**
 * The fields (stage 5's economy module, PLAN.md §6.1): whether a base plans
 * another field. Petra's rule, lifted out of the base manager unchanged; the
 * field as soon as the berries bring in less is stage 5's (FINDINGS §20,
 * decision/foodSource.ts).
 */

/** What the field decision reads. */
export interface FieldCensus
{
	/** food left in the berries within reach of the base's dropsites */
	berries: number;
	/** whether a gatherer brings in more at a field than at the berries, measured */
	fieldsFirst: boolean;
	/** our fields, foundations included */
	fields: number;
	/** our field foundations */
	foundations: number;
	/** fields in the queue */
	queued: number;
	/** the most fields the HQ allows, or false for no limit */
	maxFields: number | false;
	/** fields to keep being built at a time (Config.Economy.provisionFields) */
	provision: number;
	/** whether the HQ saves resources or room */
	saving: boolean;
}

/**
 * The first field (no field yet, the berries below 600 or bringing in less),
 * one more (fewer in construction than the goal), enough, or full (at the
 * HQ's limit: the base may build a corral instead).
 */
export type FieldDecision = "first" | "more" | "enough" | "full";

export function nextField(census: Readonly<FieldCensus>): FieldDecision
{
	if (census.fields + census.queued === 0)
		return census.berries < 600 || census.fieldsFirst ? "first" : "enough";
	if (census.maxFields && census.fields + census.queued >= census.maxFields)
		return "full";
	let goal = census.provision;
	if (census.saving || census.berries > 300 || census.fields > 5)
		goal = Math.max(goal - 1, 1);
	// while the berries bring in less than a field, one more field at a time
	if (census.fieldsFirst)
		++goal;
	return census.foundations + census.queued < goal ? "more" : "enough";
}
