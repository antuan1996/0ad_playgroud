/**
 * Which structures our units can build (PLAN.md §3.4, world/): for each
 * structure template, the units of ours that can build it, kept up as units
 * are made, lost, captured or given new build lists. The build manager
 * (decision/buildManager.ts) owns it (buildManager.builders) and saves it.
 */
import * as filters from "simulation/ai/common-api/filters.js";

function addBuilder(builders: Map<TemplateName, EntityId[]>, civ: string, entity: CommonEntity): void
{
	for (const buildable of entity.buildableEntities(civ))
	{
		const buildableList = builders.get(buildable);
		if (buildableList)
		{
			buildableList.push(entity.id());
		}
		else
		{
			builders.set(buildable, [entity.id()]);
		}
	}
}

function removeBuilder(builders: Map<TemplateName, EntityId[]>, entityId: EntityId): void
{
	for (const entities of builders.values())
	{
		const entityIndex = entities.indexOf(entityId);
		if (entityIndex !== -1)
		{
			entities.splice(entityIndex, 1);
		}
	}
}

export class Builders
{
	/** the units of ours that can build each structure template */
	private byTemplate = new Map<TemplateName, EntityId[]>();

	/** At the start of a game: the builders our starting units are */
	static start(gameState: CommonGameState): Builders
	{
		const builders = new Builders();
		const civ = gameState.getPlayerCiv();
		for (const ent of gameState.getOwnUnits().values())
		{
			addBuilder(builders.byTemplate, civ, ent);
		}
		return builders;
	}

	/** Update the builders counters */
	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		const civ = gameState.getPlayerCiv();

		for (const evt of events.Create)
		{
			if (events.Destroy.some((e: EngineAIDestroyEvent): boolean => e.entity === evt.entity))
			{
				continue;
			}
			const ent = gameState.getEntityById(evt.entity);
			if (ent && ent.isOwn(PlayerID) && ent.hasClass("Unit"))
			{
				addBuilder(this.byTemplate, civ, ent);
			}
		}

		for (const evt of events.Destroy)
		{
			removeBuilder(this.byTemplate, evt.entity);
		}

		for (const evt of events.OwnershipChanged)
		{ // capture events
			if (evt.from === PlayerID)
			{
				removeBuilder(this.byTemplate, evt.entity);
				continue;
			}
			else if (evt.to !== PlayerID)
			{
				continue;
			}

			const ent = gameState.getEntityById(evt.entity);
			if (ent?.hasClass("Unit"))
			{
				addBuilder(this.byTemplate, civ, ent);
			}
		}

		for (const evt of events.ValueModification)
		{
			if (
				evt.component !== "Builder" ||
				!evt.valueNames.some((val: string): boolean => val.startsWith("Builder/Entities/"))
			)
			{
				continue;
			}

			// Unfortunately there really is not an easy way to determine the changes
			// at this stage, so we simply have to dump the cache.
			this.byTemplate = new Map();

			for (const ent of gameState.getOwnUnits().values())
			{
				addBuilder(this.byTemplate, civ, ent);
			}
		}
	}

	/**
	 * Get the buildable structures passing a filter.
	 */
	findStructuresByFilter(gameState: CommonGameState, filter: CommonEntityFilter): TemplateName[]
	{
		const result = [];
		for (const [templateName, entities] of this.byTemplate)
		{
			if (!entities.length || gameState.isTemplateDisabled(templateName))
			{
				continue;
			}
			const template = gameState.getTemplate(templateName);
			if (!template || !template.available(gameState))
			{
				continue;
			}
			if (filter.func(template))
			{
				result.push(templateName);
			}
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
		const numBuilders = this.byTemplate.get(template);
		return numBuilders && numBuilders.length > 0;
	}

	/** The builders by template, as the build manager saves them */
	Serialize(): Map<TemplateName, EntityId[]>
	{
		return this.byTemplate;
	}

	/** The saved builders back (none in a save older than them) */
	resume(data: Map<TemplateName, EntityId[]> | undefined): void
	{
		this.byTemplate = data ?? new Map();
	}
}
