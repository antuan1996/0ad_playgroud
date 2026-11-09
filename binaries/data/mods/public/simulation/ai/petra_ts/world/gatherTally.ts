/**
 * The turn's tally of our gatherers (PLAN.md §3.4, world/): the gatherers sent
 * to each supply this turn beyond what the engine counts yet, those sent to
 * each resource, and the gather rates measured, worked out once a turn. The
 * bases manager (decision/basesManager.ts) owns it and starts it anew each
 * turn; its bases book their workers on it, and the layers below read it as
 * `gameState.ai.bases.tally`. Not saved.
 */

export class GatherTally
{
	/** the gatherers booked on each supply this turn, by supply id (negative when one left it) */
	private booked: Record<number, number> = {};
	/** the gatherers sent to each resource this turn */
	private byResource: Record<string, number> = {};
	/** the turn's gather rates, once worked out */
	private rates: Record<string, number> | undefined = undefined;

	/** A turn starts: nothing is booked yet */
	newTurn(): void
	{
		this.booked = {};
		this.byResource = {};
		this.rates = undefined;
	}

	/** A gatherer was sent to the supply this turn */
	bookGatherer(supplyID: EntityId): void
	{
		if (this.booked[supplyID] !== undefined)
		{
			++this.booked[supplyID];
		}
		else
		{
			this.booked[supplyID] = 1;
		}
	}

	/** A gatherer left the supply this turn */
	unbookGatherer(supplyID: EntityId): void
	{
		if (this.booked[supplyID])
		{
			--this.booked[supplyID];
		}
		else
		{
			this.booked[supplyID] = -1;
		}
	}

	/** How many of our gatherers this turn are booked on the supply beyond what the engine counts */
	gatherersBooked(supplyID: EntityId): number
	{
		return this.booked[supplyID] || 0;
	}

	/** A gatherer was sent to the resource this turn (half a gatherer's rate more, if the rates are worked out) */
	bookForResource(resource: string): void
	{
		this.byResource[resource] = (this.byResource[resource] ?? 0) + 1;
		if (this.rates)
		{
			this.rates[resource] += 0.5;
		}
	}

	/** How many gatherers were sent to the resource this turn */
	bookedForResource(resource: string): number
	{
		return this.byResource[resource] ?? 0;
	}

	/**
	 * The current gather rates, once a turn: half a gatherer's rate for each sent this turn, plus what the bases
	 * measure (addBaseRates), none below 0. Not per-se exact: ad-hoc adjustments account for travel distance.
	 */
	currentRates(addBaseRates: (rates: Record<string, number>) => void): Record<string, number>
	{
		if (!this.rates)
		{
			const rates: Record<string, number> = {};
			for (const res of Resources.GetCodes())
			{
				rates[res] = 0.5 * this.bookedForResource(res);
			}
			addBaseRates(rates);
			for (const res of Resources.GetCodes())
			{
				rates[res] = Math.max(rates[res], 0);
			}
			this.rates = rates;
		}
		return this.rates;
	}
}
