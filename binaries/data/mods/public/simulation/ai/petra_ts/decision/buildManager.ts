import * as filters from "simulation/ai/common-api/filters.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";

function addBuilder(builders: Map<TemplateName, EntityId[]>, civ: string, entity: CommonEntity): void
{
	for (const buildable of entity.buildableEntities(civ))
	{
		const buildableList = builders.get(buildable);
		if (buildableList)
			buildableList.push(entity.id());
		else
			builders.set(buildable, [entity.id()]);
	}
}

function removeBuilder(builders: Map<TemplateName, EntityId[]>, entityId: EntityId): void
{
	for (const entities of builders.values())
	{
		const entityIndex = entities.indexOf(entityId);
		if (entityIndex !== -1)
			entities.splice(entityIndex, 1);
	}
}

/**
 * One task of this manager is to cache the list of structures we have builders for,
 * to avoid having to loop on all entities each time.
 * It also takes care of the structures we can't currently build and should not try to build endlessly.
 */

/** a structure not to try again before `time`, and why */
type Unbuildable = { reason: string; time: number };

export type SerializedBuildManager = {
	builders: Map<TemplateName, EntityId[]>;
	unbuildables: Map<string, Unbuildable>;
};

export class BuildManager
{
	declare elapsedTime: GameSeconds;

	// List of buildings we have builders for, with number of possible builders.
	builders = new Map<TemplateName, EntityId[]>();
	// List of buildings we can't currently build (because no room, no builder or whatever),
	// with time we should wait before trying again to build it.
	unbuildables = new Map<string, Unbuildable>();

	/** Initialization at start of game */
	init(gameState: CommonGameState): void
	{
		const civ = gameState.getPlayerCiv();
		for (const ent of gameState.getOwnUnits().values())
			addBuilder(this.builders, civ, ent);
	}

	/** Update the builders counters */
	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		this.elapsedTime = gameState.ai.elapsedTime;
		const civ = gameState.getPlayerCiv();

		for (const evt of events.Create)
		{
			if (events.Destroy.some((e: EngineAIDestroyEvent): boolean => e.entity === evt.entity))
				continue;
			const ent = gameState.getEntityById(evt.entity);
			if (ent && ent.isOwn(PlayerID) && ent.hasClass("Unit"))
				addBuilder(this.builders, civ, ent);
		}

		for (const evt of events.Destroy)
			removeBuilder(this.builders, evt.entity);

		for (const evt of events.OwnershipChanged)   // capture events
		{
			if (evt.from === PlayerID)
			{
				removeBuilder(this.builders, evt.entity);
				continue;
			}
			else if (evt.to !== PlayerID)
				continue;

			const ent = gameState.getEntityById(evt.entity);
			if (ent?.hasClass("Unit"))
				addBuilder(this.builders, civ, ent);
		}

		for (const evt of events.ValueModification)
		{
			if (evt.component !== "Builder" ||
				  !evt.valueNames.some((val: string): boolean => val.startsWith("Builder/Entities/")))
				continue;

			// Unfortunately there really is not an easy way to determine the changes
			// at this stage, so we simply have to dump the cache.
			this.builders = new Map();

			for (const ent of gameState.getOwnUnits().values())
				addBuilder(this.builders, civ, ent);
		}
	}


	/**
	 * Get the buildable structures passing a filter.
	 */
	findStructuresByFilter(gameState: CommonGameState, filter: CommonEntityFilter): TemplateName[]
	{
		const result = [];
		for (const [templateName, entities] of this.builders)
		{
			if (!entities.length || gameState.isTemplateDisabled(templateName))
				continue;
			const template = gameState.getTemplate(templateName);
			if (!template || !template.available(gameState))
				continue;
			if (filter.func(template))
				result.push(templateName);
		}
		return result;
	}

	/**
	 * Get the first buildable structure with a given class
	 * TODO when several available, choose the best one
	 */
	findStructureWithClass(gameState: CommonGameState, classes: string[]): string | undefined
	{
		return this.findStructuresByFilter(gameState, filters.byClasses(classes))[0];
	}

	hasBuilder(template: TemplateName): boolean | undefined
	{
		const numBuilders = this.builders.get(template);
		return numBuilders && numBuilders.length > 0;
	}

	isUnbuildable(gameState: CommonGameState, template: string): boolean
	{
		const unbuildable = this.unbuildables.get(template);
		return unbuildable !== undefined && unbuildable.time > gameState.ai.elapsedTime;
	}

	setBuildable(template: string): void
	{
		if (this.unbuildables.has(template))
			this.unbuildables.delete(template);
	}

	/** Time is the duration in second that we will wait before checking again if it is buildable */
	setUnbuildable(gameState: CommonGameState, template: string, time: number = 90, reason: string = "room"): void
	{
		const unbuildable = this.unbuildables.get(template);
		if (unbuildable === undefined)
		{
			this.unbuildables.set(template,
				{ "reason": reason, "time": gameState.ai.elapsedTime + time });
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
			if (unbuildable.reason === "room" && unbuildable.time > gameState.ai.elapsedTime)
				++num;
		return num;
	}

	/** Reset the unbuildables due to missing room */
	resetMissingRoom(gameState: CommonGameState): void
	{
		for (const [key, unbuildable] of this.unbuildables)
			if (unbuildable.reason === "room")
				this.unbuildables.delete(key);
	}

	Serialize(): SerializedBuildManager
	{
		return {
			"builders": this.builders,
			"unbuildables": this.unbuildables
		};
	}

	Deserialize(data: SerializedBuildManager): void
	{
		// The fallbacks keep the value set by the field initializers for fields
		// absent in savegames written by an older version
		this.builders = data.builders ?? new Map();
		this.unbuildables = data.unbuildables ?? new Map();
	}
}
