/**
 * The workforce (stage 5's economy module, PLAN.md §6.1): how many workers to
 * train at a time, when to stop, and whether the next is a support unit or a
 * citizen soldier. Petra's rules, lifted out of Headquarters.trainMoreWorkers
 * unchanged; the share's cap of 0.5 is stage 5's (FINDINGS §26).
 */

/** A trainable unit's weights for findBestTrainableUnit: a name, a weight and its arguments. */
export type TrainableRequirement = [string, number, ...string[]];

/** What the training decision reads: the workers not in a plan, counted with those queued and in training. */
export interface WorkforceCensus
{
	/** workers out of a plan, those in training included */
	workers: number;
	/** support units and citizen soldiers in the queues */
	queuedSupports: number;
	queuedSoldiers: number;
	/** units in training at our trainers */
	inTraining: number;
	/** the workers wanted in all (HQ.targetNumWorkers) */
	target: number;
	/** the population the town phase waits for (Config.Economy.popPhase2) */
	popPhase2: number;
	/** in the village phase and not researching the town phase */
	waitingForTown: boolean;
	/** whether the HQ saves resources */
	saving: boolean;
}

/** One worker at a time below 12, then a tenth of the workers, at most five. */
export function batchSize(workers: number): number
{
	return workers < 12 ? 1 : Math.min(5, Math.ceil(workers / 10));
}

/** Whether no worker is to be queued: enough of them, the town phase awaited, or the queues full. */
export function trainingStopped(census: Readonly<WorkforceCensus>): boolean
{
	const queued = census.queuedSupports + census.queuedSoldiers;
	const total = census.workers + queued;
	if (census.saving && total > census.popPhase2 + 10)
		return true;
	if (total > census.target || total >= census.popPhase2 && census.waitingForTown)
		return true;
	return queued > 50 || census.queuedSupports > 20 && census.queuedSoldiers > 20 || census.inTraining > 15;
}

/**
 * How fast the support units' share starts: 0.85, 0.7 while a rush is to be
 * prepared, and towards 1 in a truce of more than two minutes left.
 */
export function supportAlpha(rushToCome: boolean, ceasefireLeft: number | undefined): number
{
	let alpha = rushToCome ? 0.7 : 0.85;
	if (ceasefireLeft !== undefined)
		alpha += (1 - alpha) * Math.min(Math.max(ceasefireLeft - 120, 0), 180) / 180;
	return alpha;
}

/**
 * The support units wanted among `total` workers: `supportRatio · target`
 * when the town is large, a share `alpha` at the start,
 * `max · (1 − e^(−alpha · total / max))` between; the share's cap falls to
 * 0.1 where no field can be built (support units gather food at the fields).
 */
export function supportShare(total: number, supportRatio: number, target: number, alpha: number, fields: boolean): number
{
	const supportMax = (fields ? supportRatio : Math.min(supportRatio, 0.1)) * target;
	return supportMax * (1 - Math.exp(-alpha*total/supportMax));
}

/** A citizen soldier's weights: quick and cheap below 45 workers, then the strongest. */
export function soldierRequirements(total: number): TrainableRequirement[]
{
	if (total < 45)
		return [ ["speed", 0.5], ["costsResource", 0.5, "stone"], ["costsResource", 0.5, "metal"] ];
	return [ ["strength", 1] ];
}
