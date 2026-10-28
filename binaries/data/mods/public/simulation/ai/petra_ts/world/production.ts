/**
 * How busy our infantry trainers are, measured (stage 5's economy model,
 * world/; FINDINGS §29): the share of our built barracks and ranges with a
 * batch in their queue, smoothed over about a minute. The stables are left
 * out: the army asks for few riders, and an idle stable says nothing of
 * whether the barracks keep up.
 *
 * The headquarters owns one and updates it each of its turns. It is not
 * saved: after a load it measures again from nothing, within a minute.
 */
import { SMOOTHING } from "./gatherEconomy.ts";

/** The classes of the buildings that train our infantry. */
export const MILITARY_TRAINERS = ["Barracks", "Range"] as const;

export class ProductionLoad
{
	/** The share of our infantry trainers training, smoothed. */
	busy = 0;
	/** Our built infantry trainers at the last update. */
	trainers = 0;
	/** Game seconds of the last update. */
	lastUpdate: number | undefined;

	update(gameState: CommonGameState): void
	{
		let trainers = 0;
		let training = 0;
		for (const cls of MILITARY_TRAINERS)
			for (const ent of gameState.getOwnEntitiesByClass(cls, true).values())
			{
				if (ent.foundationProgress() !== undefined)
					continue;
				++trainers;
				if (ent.trainingQueue()?.length)
					++training;
			}
		this.trainers = trainers;
		const now = gameState.ai.elapsedTime;
		const weight = this.lastUpdate === undefined ? 1 : 1 - Math.exp(-(now - this.lastUpdate) / SMOOTHING);
		this.lastUpdate = now;
		this.busy = this.busy * (1 - weight) + (trainers ? training / trainers : 0) * weight;
	}
}
