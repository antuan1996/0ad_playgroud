import { Builders } from "../world/builders.ts";

/**
 * The structures we can't currently build and should not try to build endlessly, each until a time and for a
 * reason. Which structures our units can build at all is its builders (world/builders.ts).
 */

/** a structure not to try again before `time`, and why */
type Unbuildable = { reason: string; time: number; };

export type SerializedBuildManager = {
	builders: Map<TemplateName, EntityId[]>;
	unbuildables: Map<string, Unbuildable>;
};

export class BuildManager
{
	/** which structures our units can build (world/builders.ts) */
	readonly builders: Builders;
	// List of buildings we can't currently build (because no room, no builder or whatever),
	// with time we should wait before trying again to build it.
	unbuildables = new Map<string, Unbuildable>();

	constructor(builders: Builders = new Builders())
	{
		this.builders = builders;
	}

	/** At the start of a game: the builders our starting units are */
	static start(gameState: CommonGameState): BuildManager
	{
		return new BuildManager(Builders.start(gameState));
	}

	isUnbuildable(gameState: CommonGameState, template: string): boolean
	{
		const unbuildable = this.unbuildables.get(template);
		return unbuildable !== undefined && unbuildable.time > gameState.ai.elapsedTime;
	}

	setBuildable(template: string): void
	{
		if (this.unbuildables.has(template))
		{
			this.unbuildables.delete(template);
		}
	}

	/** Time is the duration in second that we will wait before checking again if it is buildable */
	setUnbuildable(gameState: CommonGameState, template: string, time: number = 90, reason: string = "room"): void
	{
		const unbuildable = this.unbuildables.get(template);
		if (unbuildable === undefined)
		{
			this.unbuildables.set(template, { reason: reason, time: gameState.ai.elapsedTime + time });
		}
		else
		{
			if (unbuildable.time < gameState.ai.elapsedTime + time)
			{
				unbuildable.reason = reason;
				unbuildable.time = gameState.ai.elapsedTime + time;
			}
		}
	}

	/** Return the number of unbuildables due to missing room */
	numberMissingRoom(gameState: CommonGameState): number
	{
		let num = 0;
		for (const unbuildable of this.unbuildables.values())
		{
			if (unbuildable.reason === "room" && unbuildable.time > gameState.ai.elapsedTime)
			{
				++num;
			}
		}
		return num;
	}

	/** Reset the unbuildables due to missing room */
	resetMissingRoom(gameState: CommonGameState): void
	{
		for (const [key, unbuildable] of this.unbuildables)
		{
			if (unbuildable.reason === "room")
			{
				this.unbuildables.delete(key);
			}
		}
	}

	Serialize(): SerializedBuildManager
	{
		return { builders: this.builders.Serialize(), unbuildables: this.unbuildables };
	}

	/** A saved build manager: its builders and what it cannot build yet */
	static restore(data: SerializedBuildManager): BuildManager
	{
		const manager = new BuildManager();
		manager.resume(data);
		return manager;
	}

	private resume(data: SerializedBuildManager): void
	{
		// The fallbacks keep the value set by the field initializers for fields
		// absent in savegames written by an older version
		this.builders.resume(data.builders);
		this.unbuildables = data.unbuildables ?? new Map();
	}
}
