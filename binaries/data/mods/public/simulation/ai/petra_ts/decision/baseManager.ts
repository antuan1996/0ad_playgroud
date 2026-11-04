import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { NO_TEMPLATE, baseId, seconds, worldPos } from "../adapter/brands.ts";
import { postCommand } from "../adapter/commands.ts";
import { debugWarn } from "../adapter/debug.ts";
import {
	dumpEntity,
	getBuiltEntity,
	getHolder,
	getLandAccess,
	isFastMoving,
	isNotWorthBuilding,
	requireStructureTemplate,
	requireValue,
} from "../adapter/entityExtend.ts";
import { gatherRate } from "../adapter/orders.ts";
import { isPlaced, isStructure } from "../adapter/placed.ts";
import { footprintHalves } from "../adapter/templateData.ts";
import { isInState } from "../adapter/unitState.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { isLent } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
import { BaseResources, type ResourceSupply } from "../world/baseResources.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import { createObstructionMap } from "../world/mapModule.ts";
import type { BasesManager } from "./basesManager.ts";
import { GOOD_DROPSITE, dropsiteVerdict, relaxedDropsiteQuality } from "./dropsites.ts";
import { nextField } from "./fields.ts";
import { fieldsBeatBerries } from "./foodSource.ts";

/**
 * Base Manager
 * Handles lower level economic stuffs.
 * Some tasks:
 *  -tasking workers: gathering/hunting/building/repairing?/scouting/plans.
 *  -giving feedback/estimates on GR
 *  -achieving building stuff plans (scouting/getting ressource/building) or other long-staying plans.
 *  -getting good spots for dropsites
 *  -managing dropsite use in the base
 *  -updating whatever needs updating, keeping track of stuffs (rebuilding needs…)
 */

/** The builders a base can spare, shared by its foundations and repairs in one turn */
type BuilderCrew = {
	workers: CommonEntityCollection;
	idleBuilderWorkers: CommonEntityCollection;
	builderRatio: number;
	builderTot: number;
};

export type SerializedBaseManager = {
	ID: BaseId;
	anchorId: EntityId | undefined;
	accessIndex: AccessIndex | undefined;
	maxDistResourceSquare: number;
	constructing: boolean;
	gatherers: Record<string, { nextCheck: number; used: number; lost: number }>;
	neededDefenders: number;
	territoryIndices: Array<CellIndex<"territory">>;
	timeNextIdleCheck: GameSeconds;
	dropsiteSupplies: Record<string, Record<string, ResourceSupply[]>>;
};

/** Whether a building is the base's anchor, or a wonder in a wonder game */
function isVital(gameState: CommonGameState, target: CommonEntity): boolean
{
	return target.getMetadata(PlayerID, "baseAnchor") === true ||
		!!target.hasClass("Wonder") && gameState.getVictoryConditions().has("wonder");
}

/** How many builders a damaged building wants, and the most the crew may have repairing */
function repairCrewSize(
	gameState: CommonGameState,
	target: CommonPlacedEntity,
	crew: BuilderCrew,
): { targetNB: number; maxTotalBuilders: number }
{
	let maxTotalBuilders = Math.ceil(crew.workers.length * crew.builderRatio);
	let targetNB = 1;
	if (target.hasClasses(["Fortress", "Wonder"]))
		targetNB = 3;
	if (isVital(gameState, target))
	{
		maxTotalBuilders = Math.ceil(crew.workers.length * Math.max(0.3, crew.builderRatio));
		targetNB = 5;
		if (target.healthLevel() < 0.3)
		{
			maxTotalBuilders = Math.ceil(crew.workers.length * Math.max(0.6, crew.builderRatio));
			targetNB = 7;
		}
	}
	return { targetNB, maxTotalBuilders };
}

/** The crew's idle builders within 200 of the target and free go to it, up to targetNB; returns those assigned then */
function assignIdleBuilders(crew: BuilderCrew, target: CommonPlacedEntity, assigned: number, targetNB: number): number
{
	crew.idleBuilderWorkers.forEach(function(ent: CommonEntity): void
	{
		if (ent.getMetadata(PlayerID, "target-foundation") !== undefined)
			return;
		if (assigned >= targetNB || !isPlaced(ent) || SquareVectorDistance(ent.position(), target.position()) > 40000)
			return;
		++assigned;
		++crew.builderTot;
		ent.setMetadata(PlayerID, "target-foundation", target.id());
	});
	return assigned;
}

/** The crew's workers not building, on the map, and lent to nothing nor shipped */
function freeNonBuilders(crew: BuilderCrew): CommonEntityCollection<CommonPlacedEntity>
{
	return crew.workers.filter((ent): ent is CommonPlacedEntity =>
	{
		if (ent.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_BUILDER)
			return false;
		if (!isPlaced(ent))
			return false;
		if (isLent(ent.getMetadata(PlayerID, "plan")))
			return false;
		if (ent.getMetadata(PlayerID, "transport"))
			return false;
		return true;
	});
}

/** How dear a worker is to send to build the target: its distance, an elephant's for a long build only, a farmer's thrice */
function builderCost(target: CommonPlacedEntity, worker: CommonPlacedEntity, time: number): number
{
	let coeff = SquareVectorDistance(target.position(), worker.position());
	// elephant moves slowly, so when far away they are only useful if build time is long
	if (worker.hasClass("Elephant"))
		coeff *= 0.5 * (1 + Math.sqrt(coeff) / 5 / time);
	else if (worker.getMetadata(PlayerID, "gather-type") === "food")
		coeff *= 3;
	return coeff;
}

/** What a dropsite at cell j would collect: twice the resource and once the others it takes, normalised */
function resourceValue(gameState: CommonGameState, resource: string, droppableResources: string[], j: number): number
{
	// We add 3 times the needed resource and once others that can be dropped here.
	let total = 2 * gameState.sharedScript.resourceMaps[resource].map[j];
	for (const res in gameState.sharedScript.resourceMaps)
		if (droppableResources.indexOf(res) !== -1)
			total += gameState.sharedScript.resourceMaps[res].map[j];

	total *= 0.7; // Just a normalisation factor as the locateMap is limited to 255
	return total;
}

/** The value of a dropsite at pos, none within 60 of another dropsite and less within 80 */
function spacedFromDropsites(total: number, pos: CommonPosition, dpEnts: CommonPlacedEntity[]): number
{
	for (const dp of dpEnts)
	{
		const dpPos = dp.position();
		const dist = SquareVectorDistance(dpPos, pos);
		if (dist < 3600)
			return 0;
		if (dist < 6400)
			total *= (Math.sqrt(dist) - 60) / 20;
	}
	return total;
}

/**
 * Get the best base (in terms of distance and accessIndex) for an entity.
 * It should be on the same accessIndex for structures.
 * If nothing found, return the noBase for units and undefined for structures.
 * If exclude is given, we exclude the base with ID = exclude.
 */
export function getBestBase(
	gameState: CommonGameState,
	ent: CommonEntity,
	onlyConstructedBase: boolean = false,
	exclude: number | false = false,
): BaseManager | undefined
{
	const place = placeOf(gameState, ent);
	if (!place)
	{
		aiWarn("Petra error: entity without position, but not garrisoned");
		dumpEntity(ent);
		return gameState.ai.HQ.basesManager.baselessBase();
	}
	const { pos, accessIndex } = place;

	let distmin = Math.min();
	let bestbase;
	for (const base of gameState.ai.HQ.baseManagers())
	{
		const baseless = gameState.ai.HQ.basesManager.baselessBase();
		if (base.ID === baseless.ID || exclude && base.ID === exclude)
			continue;
		if (onlyConstructedBase && (!base.anchor || base.anchor.foundationProgress() !== undefined))
			continue;
		if (ent.hasClass("Structure") && base.accessIndex !== accessIndex)
			continue;
		const dist = baseDistance(base, pos, accessIndex);
		if (dist === undefined || dist > distmin)
			continue;
		distmin = dist;
		bestbase = base;
	}
	if (!bestbase && !ent.hasClass("Structure"))
		bestbase = gameState.ai.HQ.basesManager.baselessBase();
	return bestbase;
}

/** Where ent is, or its holder if garrisoned, and that land; undefined if neither is on the map. */
function placeOf(
	gameState: CommonGameState,
	ent: CommonEntity,
): { pos: CommonPosition; accessIndex: AccessIndex | undefined } | undefined
{
	const pos = ent.position();
	if (pos)
		return { pos, "accessIndex": getLandAccess(gameState, ent) };
	const holder = getHolder(gameState, ent);
	if (!holder || !isPlaced(holder))
		return undefined;
	return { "pos": holder.position(), "accessIndex": getLandAccess(gameState, holder) };
}

/**
 * The square distance from pos to the base's anchor, or else to its first building (undefined without one),
 * raised for a base on another land or without an anchor.
 */
function baseDistance(base: BaseManager, pos: CommonPosition, accessIndex: AccessIndex | undefined): number | undefined
{
	let dist;
	if (base.anchor)
		dist = SquareVectorDistance(base.anchor.position(), pos);
	else
	{
		const first = base.buildings.values().next();
		if (first.done)
			return undefined;
		dist = SquareVectorDistance(first.value.position(), pos);
	}
	if (base.accessIndex !== accessIndex)
		dist += 50000000;
	if (!base.anchor)
		dist += 50000000;
	return dist;
}

export class BaseManager
{
	Config: Config;
	ID: BaseId;
	accessIndex: AccessIndex | undefined;
	anchor: CommonStructureEntity | undefined;
	anchorId: EntityId | undefined;
	basesManager: BasesManager;
	buildings: CommonEntityCollection<CommonPlacedEntity>;
	constructing: boolean;
	/** The resources within reach of the base's dropsites; the accessors below keep its fields' old names. */
	resources: BaseResources;
	get dropsiteSupplies(): Record<string, Record<string, ResourceSupply[]>>
	{
		return this.resources.dropsiteSupplies;
	}
	set dropsiteSupplies(supplies: Record<string, Record<string, ResourceSupply[]>>)
	{
		this.resources.dropsiteSupplies = supplies;
	}
	get dropsites(): Record<number, boolean | undefined>
	{
		return this.resources.dropsites;
	}
	set dropsites(dropsites: Record<number, boolean | undefined>)
	{
		this.resources.dropsites = dropsites;
	}
	gatherers: Record<string, { nextCheck: number; used: number; lost: number }> = {};
	maxDistResourceSquare: number;
	mobileDropsites: CommonEntityCollection;
	neededDefenders: number;
	territoryIndices: Array<CellIndex<"territory">>;
	timeNextIdleCheck: GameSeconds;
	units: CommonEntityCollection;
	workerObject: Worker;
	workers: CommonEntityCollection;

	/** A base in the given state; a restored one takes its saved id (its collections follow its units by it) */
	constructor(gameState: CommonGameState, basesManager: BasesManager, state: string, id?: BaseId)
	{
		this.Config = basesManager.Config;
		this.ID = id ?? baseId(gameState.ai.uniqueIDs.bases++);
		this.basesManager = basesManager;
		// the resources within reach of the base's dropsites (world/baseResources.ts)
		this.resources = new BaseResources();

		// anchor building: seen as the main building of the base. Needs to have territorial influence
		this.anchor = undefined;
		this.anchorId = undefined;
		this.accessIndex = undefined;

		// Maximum distance (from any dropsite) to look for resources
		// 3 areas are used: from 0 to max/4, from max/4 to max/2 and from max/2 to max
		this.maxDistResourceSquare = 360 * 360;

		this.constructing = false;
		// Defenders to train in this cc when its construction is finished
		this.neededDefenders = this.Config.difficulty > difficulty.EASY ? 3 + 2 * (this.Config.difficulty - 3) : 0;

		// vector for iterating, to check one use the HQ map.
		this.territoryIndices = [];

		this.timeNextIdleCheck = seconds(0);

		if (state === BaseManager.STATE_UNCONSTRUCTED)
			this.constructing = true;
		else if (state !== BaseManager.STATE_CAPTURED)
			this.neededDefenders = 0;
		this.workerObject = new Worker(this);
		// entitycollections
		this.units = gameState.getOwnUnits().filter(filters.byMetadata(PlayerID, "base", this.ID));
		this.workers = this.units.filter(filters.byMetadata(PlayerID, "role", Worker.ROLE_WORKER));
		this.buildings = gameState.getOwnStructures().filter(filters.byMetadata(PlayerID, "base", this.ID));
		this.mobileDropsites = this.units.filter(filters.isDropsite());

		this.units.registerUpdates();
		this.workers.registerUpdates();
		this.buildings.registerUpdates();
		this.mobileDropsites.registerUpdates();

		for (const res of Resources.GetCodes())
			this.gatherers[res] = { "nextCheck": 0, "used": 0, "lost": 0 };
	}

	/** A saved base: its anchor, supplies and counters from the save */
	static restore(gameState: CommonGameState, basesManager: BasesManager, data: SerializedBaseManager): BaseManager
	{
		const base = new BaseManager(gameState, basesManager, BaseManager.STATE_WITH_ANCHOR, data.ID);
		base.resume(gameState, data);
		return base;
	}

	static STATE_WITH_ANCHOR = "anchored";

	/**
	 * New base with a foundation anchor.
	 */
	static STATE_UNCONSTRUCTED = "unconstructed";

	/**
	 * Captured base with an anchor.
	 */
	static STATE_CAPTURED = "captured";

	/**
	 * Anchorless base, currently with dock.
	 */
	static STATE_ANCHORLESS = "anchorless";

	reset(gameState: CommonGameState, state: string): void
	{
		if (state === BaseManager.STATE_UNCONSTRUCTED)
			this.constructing = true;
		else
			this.constructing = false;
		if (state !== BaseManager.STATE_CAPTURED || this.Config.difficulty < difficulty.MEDIUM)
			this.neededDefenders = 0;
		else
			this.neededDefenders = 3 + 2 * (this.Config.difficulty - 3);
	}

	assignEntity(gameState: CommonGameState, ent: CommonEntity): void
	{
		ent.setMetadata(PlayerID, "base", this.ID);
		this.units.updateEnt(ent);
		this.workers.updateEnt(ent);
		this.buildings.updateEnt(ent);
		if (ent.resourceDropsiteTypes() && !ent.hasClass("Unit"))
			this.assignResourceToDropsite(gameState, ent, false);
	}

	setAnchor(gameState: CommonGameState, anchorEntity: CommonEntity, deserialize: boolean = false): boolean
	{
		// a civic centre, a structure: always on the map, with its obstruction and footprint
		if (!anchorEntity.hasClass("CivCentre") || !isStructure(anchorEntity))
		{
			aiWarn(
				"Error: Petra base " + this.ID + " has been assigned " + anchorEntity.templateName() + " as anchor.",
			);
		}
		else
		{
			this.anchor = anchorEntity;
			this.anchorId = anchorEntity.id();
			if (!deserialize)
				this.anchor.setMetadata(PlayerID, "baseAnchor", true);
			this.basesManager.resetBaseCache();
		}
		if (!deserialize)
			anchorEntity.setMetadata(PlayerID, "base", this.ID);
		this.buildings.updateEnt(anchorEntity);
		this.accessIndex = getLandAccess(gameState, anchorEntity);
		return true;
	}

	/* we lost our anchor. Let's reassign our units and buildings */
	anchorLost(gameState: CommonGameState): void
	{
		this.anchor = undefined;
		this.anchorId = undefined;
		this.neededDefenders = 0;
		this.basesManager.resetBaseCache();
	}

	/** Set a building of an anchorless base */
	setAnchorlessEntity(gameState: CommonGameState, ent: CommonEntity, deserialize: boolean = false): boolean
	{
		if (!this.buildings.hasEntities())
		{
			if (!getBuiltEntity(gameState, ent).resourceDropsiteTypes())
			{
				aiWarn("Error: Petra base " + this.ID + " has been assigned " + ent.templateName() + " as origin.");
			}
			this.accessIndex = getLandAccess(gameState, ent);
		}
		else if (this.accessIndex !== getLandAccess(gameState, ent))
		{
			aiWarn(
				" Error: Petra base " + this.ID + " with access " + this.accessIndex +
					" has been assigned " + ent.templateName() + " with access" +
					getLandAccess(gameState, ent),
			);
		}

		if (!deserialize)
			ent.setMetadata(PlayerID, "base", this.ID);
		this.buildings.updateEnt(ent);
		return true;
	}

	/**
	 * Assign the resources around the dropsites of this basis in three areas according to distance, and sort them in each area.
	 * Moving resources (animals) and buildable resources (fields) are treated elsewhere.
	 */
	assignResourceToDropsite(gameState: CommonGameState, dropsite: CommonEntity, deserialized: boolean): void
	{
		// a mobile dropsite aboard a ship reaches nothing
		if (!isPlaced(dropsite))
			return;
		// the baseless pool takes each dropsite's own land
		const access = this.ID === this.basesManager.baselessBase().ID ?
			getLandAccess(gameState, dropsite) :
			this.accessIndex;
		if (!this.resources.addDropsite(gameState, dropsite, access, this.maxDistResourceSquare))
		{
			debugWarn(
				this.Config,
				0,
				() => "assignResourceToDropsite: dropsite already in the list. Should never happen",
			);
			return;
		}
		if (deserialized)
			return;

		// Allows all allies to use this dropsite except if base anchor to be sure to keep
		// a minimum of resources for this base
		postCommand({
			"type": "set-dropsite-sharing",
			"entities": [dropsite.id()],
			"shared": dropsite.id() !== this.anchorId,
		});
	}

	// completely remove the dropsite resources from our list.
	removeDropsite(gameState: CommonGameState, entityID: EntityId): void
	{
		this.resources.removeDropsite(gameState, entityID);
	}

	/**
	 * @return {Object} - The position of the best place to build a new dropsite for the specified resource,
	 * 			its quality and its template name.
	 */
	findBestDropsiteAndLocation(
		gameState: CommonGameState,
		resource: string,
	): { quality: number; pos: CommonPosition; templateName: TemplateName }
	{
		// templateName is set together with quality, so it is "" only when the
		// quality is 0, which every caller rejects before using it.
		let bestResult: { quality: number; pos: CommonPosition; templateName: TemplateName } = {
			"quality": 0,
			"pos": worldPos(0, 0),
			"templateName": NO_TEMPLATE,
		};
		for (
			const templateName of gameState.ai.HQ.buildManager.findStructuresByFilter(
				gameState,
				filters.isDropsite(resource),
			)
		)
		{
			const dp = this.findBestDropsiteLocation(gameState, resource, templateName);
			if (dp.quality < bestResult.quality)
				continue;
			bestResult = { ...dp, "templateName": templateName };
		}
		return bestResult;
	}

	/**
	 * Returns the position of the best place to build a new dropsite for the specified resource and dropsite template.
	 */
	findBestDropsiteLocation(
		gameState: CommonGameState,
		resource: string,
		templateName: TemplateName,
	): { quality: number; pos: CommonPosition }
	{
		// Callers pass a template name from findStructuresByFilter(), which only
		// returns names whose template exists and is available.
		const template = requireStructureTemplate(gameState, gameState.applyCiv(templateName));

		// CCs and Docks are handled elsewhere.
		if (template.hasClasses(["CivCentre", "Dock"]))
			return { "quality": 0, "pos": worldPos(0, 0) };

		const halfSize = footprintHalves(template).halfSize;

		// This builds a map. The procedure is fairly simple. It adds the resource maps
		// 	(which are dynamically updated and are made so that they will facilitate DP placement)
		// Then checks for a good spot in the territory. If none, and town/city phase, checks outside
		// The AI will currently not build a CC if it wouldn't connect with an existing CC.

		const obstructions = createObstructionMap(gameState, this.accessIndex, template);

		const dpEnts = gameState.getOwnStructures().filter(filters.isDropsite(resource)).toEntityArray();

		// Foundations don't have the dropsite properties yet, so treat them separately.
		for (const foundation of gameState.getOwnFoundations().toEntityArray())
			if (getBuiltEntity(gameState, foundation).isResourceDropsite(resource))
				dpEnts.push(foundation);

		let bestIdx;
		let bestVal = 0;
		// dropsite templates always have an obstruction
		const obstructionRadius = template.obstructionRadius();
		const radius = Math.ceil(obstructionRadius.max / obstructions.cellSize);

		const territoryMap = gameState.ai.HQ.geography.territoryMap;
		const width = territoryMap.width;
		const cellSize = territoryMap.cellSize;

		const droppableResources = template.resourceDropsiteTypes() ?? [];

		for (const j of this.territoryIndices)
		{
			const i = territoryMap.getNonObstructedTile(j, radius, obstructions);
			if (i < 0) // no room around
				continue;

			let total = resourceValue(gameState, resource, droppableResources, j);
			if (total <= bestVal)
				continue;

			const pos: CommonPosition = worldPos(
				cellSize * (j % width + 0.5),
				cellSize * (Math.floor(j / width) + 0.5),
			);
			total = spacedFromDropsites(total, pos, dpEnts);
			if (total <= bestVal)
				continue;

			if (gameState.ai.HQ.isDangerousLocation(gameState, pos, halfSize))
				continue;
			bestVal = total;
			bestIdx = i;
		}

		if (this.Config.debug > 2)
			warn(" for dropsite best is " + bestVal);

		// bestIdx is set together with a positive bestVal
		if (bestVal <= 0 || bestIdx === undefined)
			return { "quality": bestVal, "pos": worldPos(0, 0) };

		const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
		return { "quality": bestVal, "pos": worldPos(x, z) };
	}

	getResourceLevel(
		gameState: CommonGameState,
		type: string,
		distances: string[] = ["nearby", "medium", "faraway"],
	): number
	{
		return this.resources.getResourceLevel(gameState, type, distances);
	}

	/** Whether one of our fields, built, a foundation or queued, belongs to this base. */
	hasOwnField(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): boolean
	{
		return gameState.getOwnStructures().filter(filters.byClass("Field")).toEntityArray().some(field =>
			field.getMetadata(PlayerID, "base") === this.ID
		) || queues.field.plans.some(plan => plan.metadata?.base === this.ID);
	}

	/** check our resource levels and react accordingly */
	checkResourceLevels(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		for (const type of Resources.GetCodes())
		{
			if (type === "food")
				this.checkFoodLevel(gameState, queues);
			else
				this.checkDropsites(gameState, queues, type);
		}
	}

	/** Fields (or a corral) when the food near the base runs low */
	private checkFoodLevel(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		const type = "food";
		const prox = ["nearby"];
		if (gameState.currentPhase() < 2)
			prox.push("medium");
		if (gameState.ai.HQ.canBuild(gameState, "structures/{civ}/field"))
		{ // let's see if we need to add new farms.
			this.planFields(gameState, queues, prox);
			return;
		}
		if (
			!gameState.getOwnEntitiesByClass("Corral", true).hasEntities() &&
			!queues.corral.hasQueuedUnits() && gameState.ai.HQ.canBuild(gameState, "structures/{civ}/corral")
		)
		{
			const count = this.getResourceLevel(gameState, type, prox); // animals are not accounted
			if (count < 900)
			{
				queues.corral.addPlan(
					new ConstructionPlan(gameState, "structures/{civ}/corral", { "favoredBase": this.ID }),
				);
				gameState.ai.HQ.needCorral = true;
			}
		}
	}

	/** A field when nextField wants one (or one per island on a naval map), a corral once the fields are full */
	private planFields(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, prox: string[]): void
	{
		const count = this.getResourceLevel(gameState, "food", prox); // animals are not accounted
		// a field is wanted as soon as it brings in more than the berries (decision/foodSource.ts)
		const economy = gameState.ai.HQ.gatherEconomy;
		const fieldsFirst = fieldsBeatBerries({
			"fruit": economy.foodRateOf("fruit"),
			"grain": economy.foodRateOf("grain"),
			"fruitGatherers": economy.foodGatherers.fruit,
		});
		const decision = nextField({
			"berries": count,
			fieldsFirst,
			"fields": gameState.getOwnStructures().filter(filters.byClass("Field")).length,
			"foundations": gameState.getOwnFoundations().filter(filters.byClass("Field")).length,
			"queued": queues.field.countQueuedUnits(),
			"maxFields": gameState.ai.HQ.maxFields,
			"provision": this.Config.Economy.provisionFields,
			"saving": !!gameState.ai.HQ.saveResources || !!gameState.ai.HQ.saveSpace,
		});
		// on a naval map, each island with a civic centre of ours has a field
		// of its own: Petra placed them by the town's count, near any food
		// dropsite, and the home island filled while the new ones had none
		// (FINDINGS §41)
		if (
			gameState.ai.HQ.navalMap && this.anchor && this.anchor.foundationProgress() === undefined &&
			!this.hasOwnField(gameState, queues)
		)
			queues.field.addPlan(new ConstructionPlan(gameState, "structures/{civ}/field", { "base": this.ID }));
		else if (decision === "first" || decision === "more")
		{
			queues.field.addPlan(new ConstructionPlan(gameState, "structures/{civ}/field", { "favoredBase": this.ID }));
			if (decision === "first")
				gameState.ai.HQ.needFarm = true;
		}
		else if (
			decision === "full" && gameState.ai.HQ.needCorral &&
			!gameState.getOwnEntitiesByClass("Corral", true).hasEntities() &&
			!queues.corral.hasQueuedUnits() &&
			gameState.ai.HQ.canBuild(gameState, "structures/{civ}/corral")
		)
		{
			queues.corral.addPlan(
				new ConstructionPlan(gameState, "structures/{civ}/corral", { "favoredBase": this.ID }),
			);
		}
	}

	/** A dropsite closer to the supplies of type when its gatherers walk more than they gather */
	private checkDropsites(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, type: string): void
	{
		if (
			!gameState.sharedScript.resourceMaps[type] || queues.dropsites.hasQueuedUnits() ||
			gameState.getOwnFoundations().filter(filters.byClass("Storehouse")).hasEntities()
		)
		{
			this.gatherers[type].nextCheck = gameState.ai.playedTurn;
			this.gatherers[type].used = 0;
			this.gatherers[type].lost = 0;
			return;
		}
		if (gameState.ai.playedTurn < this.gatherers[type].nextCheck)
			return;
		for (const ent of this.gatherersByType(gameState, type).values())
		{
			if (isInState(ent, "INDIVIDUAL.GATHER.GATHERING"))
				++this.gatherers[type].used;
			else if (isInState(ent, "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING"))
				++this.gatherers[type].lost;
		}
		// TODO  add also a test on remaining resources.
		const { used, lost } = this.gatherers[type];
		const verdict = dropsiteVerdict(type, used, lost);
		if (verdict !== "wait")
		{
			if (verdict === "closer")
				this.queueCloserDropsite(gameState, queues, type, relaxedDropsiteQuality(used, lost));
			this.gatherers[type].nextCheck = gameState.ai.playedTurn + 20;
			this.gatherers[type].used = 0;
			this.gatherers[type].lost = 0;
		}
		else if (used + lost === 0)
			this.gatherers[type].nextCheck = gameState.ai.playedTurn + 10;
	}

	/**
	 * A dropsite at the best place for type; with none good, a new base if none is planned,
	 * and if not possible, a dropsite of the relaxed quality.
	 */
	private queueCloserDropsite(
		gameState: CommonGameState,
		queues: PetraRuntime.QueueCollection,
		type: string,
		relaxedQuality: number,
	): void
	{
		const newDP = this.findBestDropsiteAndLocation(gameState, type);
		// templateName is only "" when quality is 0, which the > 50 check rejects.
		if (newDP.quality > GOOD_DROPSITE && gameState.ai.HQ.canBuild(gameState, newDP.templateName))
		{
			queues.dropsites.addPlan(
				new ConstructionPlan(gameState, newDP.templateName, { "base": this.ID, "type": type }, newDP.pos),
			);
			return;
		}
		if (
			gameState.getOwnFoundations().filter(filters.byClass("CivCentre")).hasEntities() ||
			queues.civilCentre.hasQueuedUnits()
		)
			return;
		if (
			(!gameState.ai.HQ.canExpand || !gameState.ai.HQ.buildNewBase(gameState, queues, type)) &&
			newDP.quality > relaxedQuality &&
			gameState.ai.HQ.canBuild(gameState, newDP.templateName)
		)
		{
			queues.dropsites.addPlan(
				new ConstructionPlan(gameState, newDP.templateName, { "base": this.ID, "type": type }, newDP.pos),
			);
		}
	}

	/** Adds the estimated gather rates from this base to the currentRates */
	addGatherRates(gameState: CommonGameState, currentRates: Record<string, number>): void
	{
		for (const res in currentRates)
		{
			// I calculate the exact gathering rate for each unit.
			// I must then lower that to account for travel time.
			// Given that the faster you gather, the more travel time matters,
			// I use some logarithms.
			// TODO: this should take into account for unit speed and/or distance to target

			this.gatherersByType(gameState, res).forEach(ent =>
			{
				if (ent.isIdle() || !isPlaced(ent))
					return;
				const gRate = gatherRate(gameState, ent);
				if (gRate)
					currentRates[res] += Math.log(1 + gRate) / 1.1;
			});
			if (res === "food")
			{
				this.workersBySubrole(gameState, Worker.SUBROLE_HUNTER).forEach(ent =>
				{
					if (ent.isIdle() || !isPlaced(ent))
						return;
					const gRate = gatherRate(gameState, ent);
					if (gRate)
						currentRates[res] += Math.log(1 + gRate) / 1.1;
				});
				this.workersBySubrole(gameState, Worker.SUBROLE_FISHER).forEach(ent =>
				{
					if (ent.isIdle() || !isPlaced(ent))
						return;
					const gRate = gatherRate(gameState, ent);
					if (gRate)
						currentRates[res] += Math.log(1 + gRate) / 1.1;
				});
			}
		}
	}

	assignRolelessUnits(gameState: CommonGameState, roleless?: Iterable<CommonEntity>): void
	{
		if (!roleless)
			roleless = this.units.filter(filters.not(filters.byHasMetadata(PlayerID, "role"))).values();

		for (const ent of roleless)
		{
			// the classes are not enough: a mercenary keeps Worker and
			// CitizenSoldier but cannot gather, so as a worker it would idle for good
			if (ent.hasClasses(["Worker", "CitizenSoldier", "FishingBoat"]) && ent.isGatherer())
				ent.setMetadata(PlayerID, "role", Worker.ROLE_WORKER);
			else if (ent.hasClass("Support") && ent.hasClass("Elephant"))
				ent.setMetadata(PlayerID, "role", Worker.ROLE_WORKER);
		}
	}

	/**
	 * If the numbers of workers on the resources is unbalanced then set some of workers to idle so
	 * they can be reassigned by reassignIdleWorkers.
	 * TODO: actually this probably should be in the HQ.
	 */
	setWorkersIdleByPriority(gameState: CommonGameState): void
	{
		this.timeNextIdleCheck = seconds(gameState.ai.elapsedTime + 8);
		// change resource only towards one which is more needed, and if changing will not change this order
		let nb = 1; // no more than 1 change per turn (otherwise we should update the rates)
		const mostNeeded = gameState.ai.HQ.pickMostNeededResources(gameState);
		let sumWanted = 0;
		let sumCurrent = 0;
		for (const need of mostNeeded)
		{
			sumWanted += need.wanted;
			sumCurrent += need.current;
		}
		let scale = 1;
		if (sumWanted > 0)
			scale = sumCurrent / sumWanted;

		for (let i = mostNeeded.length - 1; i > 0; --i)
		{
			const lessNeed = mostNeeded[i];
			for (let j = 0; j < i; ++j)
			{
				nb = this.rebalance(gameState, lessNeed, mostNeeded[j], scale, nb);
				if (nb === 0)
					return;
			}
		}
	}

	/**
	 * Gatherers move from a resource exhausted to the other, or from the less needed to the more needed
	 * when the difference is large; returns the switches still allowed.
	 */
	private rebalance(
		gameState: CommonGameState,
		lessNeed: { type: string; wanted: number; current: number },
		moreNeed: { type: string; wanted: number; current: number },
		scale: number,
		nb: number,
	): number
	{
		const lastFailed = gameState.ai.HQ.lastFailedGather[moreNeed.type];
		if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
			return nb;
		const lessExhausted = (): boolean =>
			lessNeed.type !== "food" && this.basesManager.isResourceExhausted(lessNeed.type);
		// Ensure that the most wanted resource is not exhausted
		if (moreNeed.type !== "food" && this.basesManager.isResourceExhausted(moreNeed.type))
		{
			if (lessExhausted())
				return nb;

			// And if so, move the gatherer to the less wanted one.
			nb = this.switchGatherer(gameState, moreNeed.type, lessNeed.type, nb);
			if (nb === 0)
				return nb;
		}

		// If we assume a mean rate of 0.5 per gatherer, this diff should be > 1
		// but we require a bit more to avoid too frequent changes
		if (
			scale * moreNeed.wanted - moreNeed.current - scale * lessNeed.wanted + lessNeed.current > 1.5 ||
			lessExhausted()
		)
			nb = this.switchGatherer(gameState, lessNeed.type, moreNeed.type, nb);
		return nb;
	}

	/**
	 * Switch some gatherers (limited to number) from resource "from" to resource "to"
	 * and return remaining number of possible switches.
	 * Prefer Civilian for food and CitizenSoldier for other resources.
	 */
	switchGatherer(gameState: CommonGameState, from: string, to: string, number: number): number
	{
		let num = number;
		let only;
		const gatherers = this.gatherersByType(gameState, from);
		if (from === "food" && gatherers.filter(filters.byClass("CitizenSoldier")).hasEntities())
			only = "CitizenSoldier";
		else if (to === "food" && gatherers.filter(filters.byClass("Civilian")).hasEntities())
			only = "Civilian";

		for (const ent of gatherers.values())
		{
			if (num === 0)
				return num;
			if (!ent.canGather(to))
				continue;
			if (only && !ent.hasClass(only))
				continue;
			--num;
			ent.stopMoving();
			ent.setMetadata(PlayerID, "gather-type", to);
			this.basesManager.AddTCResGatherer(to);
		}
		return num;
	}

	/** Drops the supply at `index` of the list for `resource` in `band`: its entity is gone. */
	forgetSupplyAt(resource: string, band: string, index: number): void
	{
		this.resources.forgetSupplyAt(resource, band, index);
	}

	reassignIdleWorkers(gameState: CommonGameState, idleWorkers?: Iterable<CommonEntity>): void
	{
		// Search for idle workers, and tell them to gather resources based on demand
		if (!idleWorkers)
		{
			const filter = filters.byMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
			idleWorkers = gameState.updatingCollection("idle-workers-base-" + this.ID, filter, this.workers).values();
		}

		for (const ent of idleWorkers)
		{
			// Check that the worker isn't garrisoned
			if (!isPlaced(ent))
				continue;
			// Support elephant can only be builders
			if (ent.hasClass("Support") && ent.hasClass("Elephant"))
			{
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
				continue;
			}

			if (ent.hasClass("Worker"))
				this.repairOrGather(gameState, ent);
			else if (isFastMoving(ent) && ent.canGather("food") && ent.canAttackClass("Animal"))
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_HUNTER);
			else if (ent.hasClass("FishingBoat"))
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_FISHER);
		}
	}

	/** An idle worker repairs the anchor in an emergency, or else gathers */
	private repairOrGather(gameState: CommonGameState, ent: CommonEntity): void
	{
		// Just emergency repairing here. It is better managed in assignToFoundations
		if (
			ent.isBuilder() && this.anchor && this.anchor.needsRepair() &&
			gameState.getOwnEntitiesByMetadata("target-foundation", this.anchor.id()).length < 2
		)
			ent.repair(this.anchor);
		else if (ent.isGatherer())
			this.gatherMostNeeded(gameState, ent);
	}

	/** The gatherer takes the most needed resource it can gather, not failed lately nor exhausted */
	private gatherMostNeeded(gameState: CommonGameState, ent: CommonEntity): void
	{
		const mostNeeded = gameState.ai.HQ.pickMostNeededResources(gameState);
		for (const needed of mostNeeded)
		{
			if (!ent.canGather(needed.type))
				continue;
			const lastFailed = gameState.ai.HQ.lastFailedGather[needed.type];
			if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
				continue;
			if (needed.type !== "food" && this.basesManager.isResourceExhausted(needed.type))
				continue;
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_GATHERER);
			ent.setMetadata(PlayerID, "gather-type", needed.type);
			this.basesManager.AddTCResGatherer(needed.type);
			return;
		}
	}

	workersBySubrole(gameState: CommonGameState, subrole: WorkerSubrole): CommonEntityCollection
	{
		return gameState.updatingCollection(
			"subrole-" + subrole + "-base-" + this.ID,
			filters.byMetadata(PlayerID, "subrole", subrole),
			this.workers,
		);
	}

	gatherersByType(gameState: CommonGameState, type: string): CommonEntityCollection
	{
		return gameState.updatingCollection(
			"workers-gathering-" + type + "-base-" + this.ID,
			filters.byMetadata(PlayerID, "gather-type", type),
			this.workersBySubrole(gameState, Worker.SUBROLE_GATHERER),
		);
	}

	/**
	 * returns an entity collection of workers.
	 * They are idled immediatly and their subrole set to idle.
	 */
	pickBuilders(gameState: CommonGameState, workers: CommonEntityCollection, number: number): void
	{
		const availableWorkers = this.workers.filter(ent =>
		{
			if (!isPlaced(ent) || !ent.isBuilder())
				return false;
			if (isLent(ent.getMetadata(PlayerID, "plan")))
				return false;
			if (ent.getMetadata(PlayerID, "transport"))
				return false;
			return true;
		}).toEntityArray();
		// idle hands first, then the town's own, then a plan's; builders last
		const lendScore = (ent: CommonEntity): number =>
		{
			const subrole = ent.getMetadata(PlayerID, "subrole");
			if (subrole === Worker.SUBROLE_BUILDER)
				return 100;
			if (subrole === Worker.SUBROLE_IDLE)
				return -50;
			return ent.getMetadata(PlayerID, "plan") === undefined ? -20 : 0;
		};
		availableWorkers.sort((a: CommonEntity, b: CommonEntity): number => lendScore(a) - lendScore(b));
		const needed = Math.min(number, availableWorkers.length - 3);
		for (let i = 0; i < needed; ++i)
		{
			availableWorkers[i].stopMoving();
			availableWorkers[i].setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
			workers.addEnt(availableWorkers[i]);
		}
		return;
	}

	/**
	 * If we have some foundations, and we don't have enough builder-workers,
	 * try reassigning some other workers who are nearby
	 * AI tries to use builders sensibly, not completely stopping its econ.
	 */
	assignToFoundations(gameState: CommonGameState, noRepair = false): void
	{
		let foundations = this.buildings.filter(
			filters.and(filters.isFoundation(), filters.not(filters.byClass("Field"))),
		);

		const damagedBuildings = this.buildings.filter(ent =>
			ent.foundationProgress() === undefined && ent.needsRepair()
		);

		// Check if nothing to build
		if (!foundations.length && !damagedBuildings.length)
			return;

		const workers = this.workers.filter(ent => ent.isBuilder());
		const builderWorkers = this.workersBySubrole(gameState, Worker.SUBROLE_BUILDER);
		const idleBuilderWorkers = builderWorkers.filter(filters.isIdle());

		// if we're constructing and we have the foundations to our base anchor, only try building that.
		if (this.constructing && foundations.filter(filters.byMetadata(PlayerID, "baseAnchor", true)).hasEntities())
		{
			foundations = foundations.filter(filters.byMetadata(PlayerID, "baseAnchor", true));
			const tID = foundations.toEntityArray()[0].id();
			workers.forEach(ent =>
			{
				const target = ent.getMetadata(PlayerID, "target-foundation");
				if (target && target !== tID)
				{
					ent.stopMoving();
					ent.setMetadata(PlayerID, "target-foundation", tID);
				}
			});
		}

		if (workers.length < 3)
		{
			const fromOtherBase = this.basesManager.bulkPickWorkers(gameState, this, 2);
			if (fromOtherBase)
			{
				const baseID = this.ID;
				fromOtherBase.forEach(worker =>
				{
					worker.setMetadata(PlayerID, "base", baseID);
					worker.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
					workers.updateEnt(worker);
					builderWorkers.updateEnt(worker);
					idleBuilderWorkers.updateEnt(worker);
				});
			}
		}

		const builderTot = builderWorkers.length - idleBuilderWorkers.length;

		// Make the limit on number of builders depends on the available resources
		const availableResources = gameState.ai.queueManager.getAvailableResources(gameState);
		let builderRatio = 1;
		for (const res of Resources.GetCodes())
		{
			if (availableResources[res] < 200)
			{
				builderRatio = 0.2;
				break;
			}
			else if (availableResources[res] < 1000)
				builderRatio = Math.min(builderRatio, availableResources[res] / 1000);
		}

		const crew: BuilderCrew = { workers, idleBuilderWorkers, builderRatio, builderTot };
		for (const target of foundations.values())
			this.assignToFoundation(gameState, target, crew);

		for (const target of damagedBuildings.values())
			this.assignToRepair(gameState, target, noRepair, crew);
	}

	/** Send builders to one foundation, within the crew's limits */
	assignToFoundation(gameState: CommonGameState, target: CommonPlacedEntity, crew: BuilderCrew): void
	{
		if (target.hasClass("Field"))
			return; // we do not build fields

		if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
		{
			if (
				!target.hasClasses(["CivCentre", "Wall"]) &&
				(!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder"))
			)
				return;
		}

		// if our territory has shrinked since this foundation was positioned, do not build it
		if (isNotWorthBuilding(gameState, target))
			return;

		let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
		const { targetNB, maxTotalBuilders } = this.foundationCrewSize(gameState, target, crew);

		if (assigned >= targetNB)
			return;
		assigned = assignIdleBuilders(crew, target, assigned, targetNB);
		if (assigned >= targetNB || crew.builderTot >= maxTotalBuilders)
			return;
		const nonBuilderWorkers = freeNonBuilders(crew).toEntityArray();
		const time = target.buildTime();
		nonBuilderWorkers.sort((workerA, workerB): number =>
			builderCost(target, workerA, time) - builderCost(target, workerB, time)
		);
		let current = 0;
		const nonBuilderTot = nonBuilderWorkers.length;
		while (assigned < targetNB && crew.builderTot < maxTotalBuilders && current < nonBuilderTot)
		{
			++assigned;
			++crew.builderTot;
			const ent = nonBuilderWorkers[current++];
			ent.stopMoving();
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		}
	}

	/** How many builders a foundation wants, and the most the crew may have building */
	private foundationCrewSize(
		gameState: CommonGameState,
		target: CommonPlacedEntity,
		crew: BuilderCrew,
	): { targetNB: number; maxTotalBuilders: number }
	{
		let maxTotalBuilders = Math.ceil(crew.workers.length * crew.builderRatio);
		if (maxTotalBuilders < 2 && crew.workers.length > 1)
			maxTotalBuilders = 2;
		if (
			target.hasClass("House") && gameState.getPopulationLimit() < gameState.getPopulation() + 5 &&
			gameState.getPopulationLimit() < gameState.getPopulationMax()
		)
			maxTotalBuilders += 2;
		let targetNB = 2;
		if (target.hasClasses(["Fortress", "Wonder"]) || target.getMetadata(PlayerID, "phaseUp") === true)
			targetNB = 7;
		else if (target.hasClasses(["Barracks", "Range", "Stable", "Tower", "Market"]))
			targetNB = 4;
		else if (target.hasClasses(["House", "DropsiteWood"]))
			targetNB = 3;

		if (isVital(gameState, target))
		{
			targetNB = 15;
			maxTotalBuilders = Math.max(maxTotalBuilders, 15);
		}

		if (!this.basesManager.hasActiveBase())
		{
			targetNB = crew.workers.length;
			maxTotalBuilders = targetNB;
		}
		return { targetNB, maxTotalBuilders };
	}

	/** Send builders to repair one damaged building, within the crew's limits */
	assignToRepair(gameState: CommonGameState, target: CommonPlacedEntity, noRepair: boolean, crew: BuilderCrew): void
	{
		// Don't repair if we're still under attack, unless it's a vital (civcentre or wall) building
		// that's being destroyed.
		if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
		{
			if (
				target.healthLevel() > 0.5 ||
				!target.hasClasses(["CivCentre", "Wall"]) &&
					(!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder"))
			)
				return;
		}
		else if (noRepair && !target.hasClass("CivCentre"))
			return;

		if (target.decaying())
			return;

		let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
		const { targetNB, maxTotalBuilders } = repairCrewSize(gameState, target, crew);

		if (assigned >= targetNB)
			return;
		assigned = assignIdleBuilders(crew, target, assigned, targetNB);
		if (assigned >= targetNB || crew.builderTot >= maxTotalBuilders)
			return;
		const nonBuilderWorkers = freeNonBuilders(crew);
		const num = Math.min(nonBuilderWorkers.length, targetNB - assigned);
		const nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), num);

		nearestNonBuilders.forEach(function(ent: CommonEntity): void
		{
			++assigned;
			++crew.builderTot;
			ent.stopMoving();
			ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
			ent.setMetadata(PlayerID, "target-foundation", target.id());
		});
	}

	/** Return false when the base is not active (no workers on it) */
	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): boolean
	{
		const baseless = this.basesManager.baselessBase();
		if (this.ID === baseless.ID)
		{
			this.updateBaseless(gameState);
			return false;
		}

		if (!this.anchor) // This anchor has been destroyed, but the base may still be usable
			return this.updateAnchorless(gameState);

		Engine.ProfileStart("Base update - base " + this.ID);

		this.checkResourceLevels(gameState, queues);
		this.assignToFoundations(gameState);

		if (this.constructing)
			this.leaveIfTooNearEnemy(gameState, this.anchor);
		else if (this.neededDefenders && gameState.ai.HQ.trainEmergencyUnits(gameState, [this.anchor.position()]))
			--this.neededDefenders;

		if (
			gameState.ai.elapsedTime > this.timeNextIdleCheck &&
			(gameState.currentPhase() > 1 || gameState.ai.HQ.phasing === 2)
		)
			this.setWorkersIdleByPriority(gameState);

		// check if workers can find something useful to do
		this.putWorkersToWork(gameState);

		Engine.ProfileStop();
		return true;
	}

	/** The roleless get a role, the idle a job, and every worker and mobile dropsite its turn */
	private putWorkersToWork(gameState: CommonGameState): void
	{
		this.assignRolelessUnits(gameState);
		this.reassignIdleWorkers(gameState);
		for (const ent of this.workers.values())
			this.workerObject.update(gameState, ent);
		for (const ent of this.mobileDropsites.values())
			this.workerObject.moveToGatherer(gameState, ent, false);
	}

	/** Builds, rebalances the gatherers and puts the workers to work, as a base without its own update does */
	private manageWithoutBase(gameState: CommonGameState): void
	{
		this.assignToFoundations(gameState);
		if (gameState.ai.elapsedTime > this.timeNextIdleCheck)
			this.setWorkersIdleByPriority(gameState);
		this.putWorkersToWork(gameState);
	}

	/**
	 * The baseless pool: with some active base, it hands it its workers and buildings;
	 * otherwise it looks for anything useful to do, i.e. treasures to gather
	 */
	private updateBaseless(gameState: CommonGameState): void
	{
		if (this.basesManager.hasActiveBase())
		{
			for (const ent of this.units.values())
			{
				// a unit always finds a base while one is active
				const bestBase = requireValue(getBestBase(gameState, ent));
				if (bestBase.ID !== this.ID)
					bestBase.assignEntity(gameState, ent);
			}
			for (const ent of this.buildings.values())
			{
				const bestBase = getBestBase(gameState, ent);
				if (!bestBase)
				{
					if (ent.hasClass("Dock"))
					{
						aiWarn(
							"Petra: dock in 'noBase' baseManager. It may be useful to " +
								"do an anchorless base for " + ent.templateName(),
						);
					}
					continue;
				}
				if (ent.resourceDropsiteTypes())
					this.removeDropsite(gameState, ent.id());
				bestBase.assignEntity(gameState, ent);
			}
		}
		else if (gameState.ai.HQ.canBuildUnits)
			this.manageWithoutBase(gameState);
	}

	/**
	 * A base whose anchor was destroyed: without buildings its units go to their nearest base; with a base with
	 * an anchor on the land everything goes to it; else it goes on (returns true) without an anchor.
	 */
	private updateAnchorless(gameState: CommonGameState): boolean
	{
		if (!this.buildings.hasEntities())
		{
			// Reassign all remaining entities to its nearest base
			for (const ent of this.units.values())
			{
				const base = getBestBase(gameState, ent, false, this.ID);
				if (!base)
					continue;
				base.assignEntity(gameState, ent);
			}
			return false;
		}
		// If we have a base with anchor on the same land, reassign everything to it
		let reassignedBase;
		for (const ent of this.buildings.values())
		{
			const base = getBestBase(gameState, ent);
			if (!base)
				continue;
			if (base.anchor)
				reassignedBase = base;
			break;
		}

		if (reassignedBase)
		{
			for (const ent of this.units.values())
				reassignedBase.assignEntity(gameState, ent);
			for (const ent of this.buildings.values())
			{
				if (ent.resourceDropsiteTypes())
					this.removeDropsite(gameState, ent.id());
				reassignedBase.assignEntity(gameState, ent);
			}
			return false;
		}

		this.manageWithoutBase(gameState);
		return true;
	}

	/** A base being founded in enemy territory too near an enemy civic centre destroys its anchor */
	private leaveIfTooNearEnemy(gameState: CommonGameState, anchor: CommonPlacedEntity): void
	{
		const owner = gameState.ai.HQ.geography.territoryMap.getOwner(anchor.position());
		if (owner === 0 || gameState.isPlayerAlly(owner))
			return;
		// we're in enemy territory. If we're too close from the enemy, destroy us.
		const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
		for (const cc of ccEnts.values())
		{
			if (cc.owner() !== owner || !isPlaced(cc))
				continue;
			if (SquareVectorDistance(cc.position(), anchor.position()) > 8000)
				continue;
			anchor.destroy();
			this.basesManager.resetBaseCache();
			break;
		}
	}

	AddTCGatherer(supplyID: EntityId): void
	{
		return this.basesManager.AddTCGatherer(supplyID);
	}

	RemoveTCGatherer(supplyID: EntityId): void
	{
		this.basesManager.RemoveTCGatherer(supplyID);
	}

	GetTCGatherer(supplyID: EntityId): number
	{
		return this.basesManager.GetTCGatherer(supplyID);
	}

	Serialize(): SerializedBaseManager
	{
		return {
			"ID": this.ID,
			"anchorId": this.anchorId,
			"accessIndex": this.accessIndex,
			"maxDistResourceSquare": this.maxDistResourceSquare,
			"constructing": this.constructing,
			"gatherers": this.gatherers,
			"neededDefenders": this.neededDefenders,
			"territoryIndices": this.territoryIndices,
			"timeNextIdleCheck": this.timeNextIdleCheck,
			"dropsiteSupplies": this.resources.dropsiteSupplies,
		};
	}

	private resume(gameState: CommonGameState, data: SerializedBaseManager): void
	{
		// Fallbacks for fields absent in savegames written by an older version:
		// the value the constructor gave
		this.anchorId = data.anchorId;
		this.accessIndex = data.accessIndex;
		this.maxDistResourceSquare = data.maxDistResourceSquare ?? 360 * 360;
		this.constructing = data.constructing ?? false;
		this.gatherers = data.gatherers ?? this.gatherers;
		this.neededDefenders = data.neededDefenders ?? this.neededDefenders;
		this.territoryIndices = data.territoryIndices ?? [];
		this.timeNextIdleCheck = data.timeNextIdleCheck ?? 0;
		this.resources.dropsiteSupplies = data.dropsiteSupplies ?? this.resources.dropsiteSupplies;

		const anchor = this.anchorId !== undefined ? gameState.getEntityById(this.anchorId) : undefined;
		// a civic centre: on the map
		this.anchor = anchor && isStructure(anchor) ? anchor : undefined;
	}
}
