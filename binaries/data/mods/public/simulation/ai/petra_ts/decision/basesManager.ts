import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { SquareVectorDistance, aiWarn, getMapIndices } from "simulation/ai/common-api/utils.js";
import { NEW_ANCHORLESS_BASE, NEW_BASE, NO_BASE, NO_LAND, baseId, worldPos } from "../adapter/brands.ts";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced, isStructure } from "../adapter/placed.ts";
import { requireStateName } from "../adapter/unitState.ts";
import { Worker } from "../execution/worker.ts";
import type { Config } from "../world/config.ts";
import { BaseManager, getBestBase, type SerializedBaseManager } from "./baseManager.ts";
import { handleNewBase } from "./hqEvents.ts";

export interface SerializedBasesManager
{
	properties: { currentBase: number; };
	noBase: SerializedBaseManager;
	baseManagers: SerializedBaseManager[];
}

type BasesManagerTurnCache = {
	currentRates?: Record<string, number>;
	resourceGatherer?: Record<number, number>;
	resourceGathererByType?: Record<string, number>;
	base?: { active: number; potential: number; };
};

/** A trained animal (a supply) walks to the nearest of our dropsites for its resource on its land. */
function toNearestDropsite(gameState: CommonGameState, ent: CommonPlacedEntity): void
{
	const type = ent.resourceSupplyType();
	if (!type || !type.generic)
	{
		return;
	}
	const dropsites = gameState.getOwnDropsites(type.generic);
	const pos = ent.position();
	const access = getLandAccess(gameState, ent);
	let distmin = Math.min();
	let goal;
	for (const dropsite of dropsites.values())
	{
		if (!isPlaced(dropsite) || getLandAccess(gameState, dropsite) !== access)
		{
			continue;
		}
		const dist = SquareVectorDistance(pos, dropsite.position());
		if (dist > distmin)
		{
			continue;
		}
		distmin = dist;
		goal = dropsite.position();
	}
	if (goal)
	{
		ent.move(goal[0], goal[1]);
	}
}

/**
 * Bases Manager
 * Manages the list of available bases and queries information from those (e.g. resource levels).
 * Only one base is run every turn.
 */

export class BasesManager
{
	Config: Config;
	/** Each territory cell's base id, 0 for none */
	basesMap: InfoMap;

	currentBase = 0;

	// Cache some quantities for performance.
	turnCache: BasesManagerTurnCache = {};

	// Deals with unit/structure without base.
	noBase: BaseManager;

	baseManagers: BaseManager[] = [];

	/** No bases yet but the one for what has none; a saved manager has its saved bases and their map */
	constructor(Config: Config, gameState: CommonGameState, saved?: SerializedBasesManager)
	{
		this.Config = Config;
		// Each pixel is a base ID, or 0 if not or not accessible.
		this.basesMap = new InfoMap(gameState.sharedScript, "territory");
		if (!saved)
		{
			this.noBase = new BaseManager(gameState, this, BaseManager.STATE_WITH_ANCHOR);
			this.noBase.accessIndex = NO_LAND;
			return;
		}
		this.currentBase = saved.properties.currentBase;
		this.noBase = BaseManager.restore(gameState, this, saved.noBase);
		this.baseManagers = saved.baseManagers.map((data) => BaseManager.restore(gameState, this, data));
		// the base map, from the territory indices of each base
		for (const base of this.baseManagers)
		{
			for (const j of base.territoryIndices)
			{
				this.basesMap.map[j] = base.ID;
			}
		}
	}

	/** At the start of a game, a base for each of our civic centres */
	createStartingBases(gameState: CommonGameState): void
	{
		for (const cc of gameState.getOwnStructures().filter(filters.byClass("CivCentre")).values())
		{
			if (cc.foundationProgress() === undefined)
			{
				this.createBase(gameState, cc, BaseManager.STATE_WITH_ANCHOR);
			}
			else
			{
				this.createBase(gameState, cc, BaseManager.STATE_UNCONSTRUCTED);
			}
		}
	}

	/**
	 * Create a new base in the baseManager:
	 * If an existing one without anchor already exist, use it.
	 * Otherwise create a new one.
	 * TODO when buildings, criteria should depend on distance
	 */
	createBase(
		gameState: CommonGameState,
		ent: CommonEntity,
		type: string = BaseManager.STATE_WITH_ANCHOR,
		deserialize: boolean = false,
	): BaseManager
	{
		const access = getLandAccess(gameState, ent);
		let newbase;
		for (const base of this.baseManagers)
		{
			if (base.accessIndex !== access)
			{
				continue;
			}
			if (type !== BaseManager.STATE_ANCHORLESS && base.anchor)
			{
				continue;
			}
			if (type !== BaseManager.STATE_ANCHORLESS)
			{
				// TODO we keep the first one, we should rather use the nearest if buildings
				// and possibly also cut on distance
				newbase = base;
				break;
			}
			else
			{
				// TODO here also test on distance instead of first
				if (newbase && !base.anchor)
				{
					continue;
				}
				newbase = base;
				if (newbase.anchor)
				{
					break;
				}
			}
		}

		if (this.Config.debug > 0)
		{
			aiWarn(" ----------------------------------------------------------");
			aiWarn(" BasesManager createBase entrance avec access " + access + " and type " + type);
			aiWarn(
				" with access " + uneval(this.baseManagers.map((base: BaseManager): number | undefined =>
					base.accessIndex
				)) + " and base nbr " + uneval(this.baseManagers.map((base: BaseManager): number => base.ID)) +
					" and anchor " + uneval(this.baseManagers.map((base: BaseManager): boolean => !!base.anchor)),
			);
		}

		if (!newbase)
		{
			newbase = new BaseManager(gameState, this, type);
			this.baseManagers.push(newbase);
		}
		else
		{
			newbase.reset(gameState, type);
		}

		if (type !== BaseManager.STATE_ANCHORLESS)
		{
			newbase.setAnchor(gameState, ent, deserialize);
		}
		else
		{
			newbase.setAnchorlessEntity(gameState, ent, deserialize);
		}

		return newbase;
	}

	/** checkEvents: an entity renamed (promoted, upgraded, packed). */
	onEntityRenamed(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.EntityRenamed)
		{
			const ent = gameState.getEntityById(evt.newentity);
			const baseID = ent?.getMetadata(PlayerID, "base");
			if (!ent || ent.owner() !== PlayerID || baseID === undefined)
			{
				continue;
			}

			const base = this.getBaseByID(baseID);
			if (!base)
			{
				continue;
			}

			// Promoted workers should be reset - their new gathering rates/capabilities might differ meaningfully.
			if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER)
			{
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
				if (!ent.isGatherer())
				{
					// TODO: Find a way to properly reset the metadata, as this is currently done selectively
					ent.setMetadata(PlayerID, "gather-type", undefined);
					ent.setMetadata(PlayerID, "supply", undefined);
					ent.setMetadata(PlayerID, "role", undefined);
					base.assignRolelessUnits(gameState, [ent]);
				}
				continue;
			}

			// Handle cases where a base anchor changes
			if (!base.anchorId || base.anchorId !== evt.entity)
			{
				continue;
			}
			base.anchorId = evt.newentity;
			base.anchor = ent && isStructure(ent) ? ent : undefined;
		}
	}

	/** checkEvents: entities created (foundations). */
	onCreate(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.Create)
		{
			// Let's check if we have a valuable foundation needing builders quickly
			// (normal foundations are taken care in baseManager.assignToFoundations)
			const ent = gameState.getEntityById(evt.entity);
			if (!ent || ent.owner() !== PlayerID || ent.foundationProgress() === undefined)
			{
				continue;
			}

			if (ent.getMetadata(PlayerID, "base") === NEW_BASE)
			{ // Standard base around a cc
				// Okay so let's try to create a new base around this.
				const newbase = this.createBase(gameState, ent, BaseManager.STATE_UNCONSTRUCTED);
				// Let's get a few units from other bases there to build this. (Soldiers
				// first on another island lost the island games: FINDINGS §39.)
				this.sendBuilders(gameState, newbase, ent, 10);
			}
			else if (ent.getMetadata(PlayerID, "base") === NEW_ANCHORLESS_BASE)
			{ // anchorless base around a dock
				const newbase = this.createBase(gameState, ent, BaseManager.STATE_ANCHORLESS);
				// Let's get a few units from other bases there to build this.
				this.sendBuilders(gameState, newbase, ent, 4);
			}
		}
	}

	/** Takes up to `count` workers from the other bases to build a new base's foundation. */
	private sendBuilders(
		gameState: CommonGameState,
		newbase: BaseManager,
		foundation: CommonEntity,
		count: number,
	): void
	{
		const builders = this.bulkPickWorkers(gameState, newbase, count);
		if (builders === false)
		{
			return;
		}
		builders.forEach((worker) =>
		{
			worker.setMetadata(PlayerID, "base", newbase.ID);
			worker.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
			worker.setMetadata(PlayerID, "target-foundation", foundation.id());
		});
	}

	/** checkEvents: buildings finished.; whether it added a base. */
	onConstructionFinished(gameState: CommonGameState, events: EngineAIEvents): boolean
	{
		let addBase = false;
		for (const evt of events.ConstructionFinished)
		{
			if (evt.newentity === evt.entity)
			{ // repaired building
				continue;
			}
			const ent = gameState.getEntityById(evt.newentity);
			if (!ent || ent.owner() !== PlayerID)
			{
				continue;
			}
			const baseID = ent.getMetadata(PlayerID, "base");
			if (baseID === undefined)
			{
				continue;
			}
			const base = this.getBaseByID(baseID);
			if (!base)
			{
				continue;
			}
			base.buildings.updateEnt(ent);
			if (ent.resourceDropsiteTypes())
			{
				base.assignResourceToDropsite(gameState, ent, false);
			}

			if (ent.getMetadata(PlayerID, "baseAnchor") === true)
			{
				if (base.constructing)
				{
					base.constructing = false;
				}
				addBase = true;
			}
		}
		return addBase;
	}

	/** checkEvents: entities changing hands (captured, converted).; whether it added a base. */
	onOwnershipChanged(gameState: CommonGameState, events: EngineAIEvents): boolean
	{
		let addBase = false;
		for (const evt of events.OwnershipChanged)
		{
			if (evt.from === PlayerID)
			{
				this.lostToOther(gameState, evt.entity);
			}
			if (evt.to === PlayerID && this.gainedFromOther(gameState, evt.entity))
			{
				addBase = true;
			}
		}
		return addBase;
	}

	/** An entity we lost leaves its base: a dropsite its lists, an anchor its base. */
	private lostToOther(gameState: CommonGameState, entityId: EntityId): void
	{
		const ent = gameState.getEntityById(entityId);
		if (!ent)
		{
			return;
		}
		const baseID = ent.getMetadata(PlayerID, "base");
		if (baseID === undefined)
		{
			return;
		}
		const base = this.getBaseByID(baseID);
		if (!base)
		{
			return;
		}
		if (ent.resourceDropsiteTypes() && ent.hasClass("Structure"))
		{
			base.removeDropsite(gameState, ent.id());
		}
		if (ent.getMetadata(PlayerID, "baseAnchor") === true)
		{
			base.anchorLost(gameState);
		}
	}

	/**
	 * An entity we gained joins a base: a unit the best one, a civic centre a
	 * new base around it, a new island's dropsite an anchorless base; true if a
	 * built civic centre made a base.
	 */
	private gainedFromOther(gameState: CommonGameState, entityId: EntityId): boolean
	{
		const ent = gameState.getEntityById(entityId);
		if (!ent)
		{
			return false;
		}
		if (ent.hasClass("Unit"))
		{
			const bestBase = getBestBase(gameState, this, ent);
			if (bestBase)
			{
				bestBase.assignEntity(gameState, ent);
			}
			return false;
		}
		if (ent.hasClass("CivCentre"))
		{ // build a new base around it
			const built = ent.foundationProgress() === undefined;
			const newbase = this.createBase(
				gameState,
				ent,
				built ? BaseManager.STATE_CAPTURED : BaseManager.STATE_UNCONSTRUCTED,
			);
			newbase.assignEntity(gameState, ent);
			return built;
		}
		let base;
		// If dropsite on new island, create a base around it
		if (!ent.decaying() && ent.resourceDropsiteTypes())
		{
			base = this.createBase(gameState, ent, BaseManager.STATE_ANCHORLESS);
		}
		else
		{
			base = getBestBase(gameState, this, ent) || this.noBase;
		}
		if (base)
		{
			base.assignEntity(gameState, ent);
		}
		return false;
	}

	/** checkEvents: units trained. */
	onTrainingFinished(gameState: CommonGameState, events: EngineAIEvents): void
	{
		for (const evt of events.TrainingFinished)
		{
			for (const entId of evt.entities)
			{
				const ent = gameState.getEntityById(entId);
				if (!ent || !ent.isOwn(PlayerID))
				{
					continue;
				}

				// Assign it immediately to something useful to do.
				if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER)
				{
					this.setNewWorkerToWork(gameState, ent);
				}
				else if (ent.resourceSupplyType() && isPlaced(ent))
				{
					toNearestDropsite(gameState, ent);
				}
			}
		}
	}

	/** A worker just trained: to its base, or the best one, and to work at once. */
	private setNewWorkerToWork(gameState: CommonGameState, ent: CommonEntity): void
	{
		let base;
		if (ent.getMetadata(PlayerID, "base") === undefined)
		{
			base = getBestBase(gameState, this, ent);
			if (base)
			{
				base.assignEntity(gameState, ent);
			}
		}
		else
		{
			const baseID = ent.getMetadata(PlayerID, "base");
			base = baseID === undefined ? undefined : this.getBaseByID(baseID);
		}
		if (!base)
		{
			return;
		}
		base.reassignIdleWorkers(gameState, [ent]);
		base.workerObject.update(gameState, ent);
	}

	/** TODO check if the new anchorless bases should be added to addBase */
	checkEvents(gameState: CommonGameState, events: EngineAIEvents): void
	{
		this.turnCache = {};
		let addBase = false;

		for (const evt of events.Destroy)
		{
			// Let's check we haven't lost an important building here.
			if (evt && !evt.SuccessfulFoundation && evt.metadata?.[PlayerID]?.base)
			{
				// A new base foundation was created and destroyed on the same (AI) turn
				if (evt.metadata[PlayerID].base === -1 || evt.metadata[PlayerID].base === -2)
				{
					continue;
				}
				const base = this.getBaseByID(evt.metadata[PlayerID].base);
				if (!base)
				{
					continue;
				}
				base.removeDropsite(gameState, evt.entity);
				if (evt.metadata[PlayerID].baseAnchor && evt.metadata[PlayerID].baseAnchor === true)
				{
					base.anchorLost(gameState);
				}
			}
		}

		this.onEntityRenamed(gameState, events);

		this.onCreate(gameState, events);

		if (this.onConstructionFinished(gameState, events))
		{
			addBase = true;
		}

		if (this.onOwnershipChanged(gameState, events))
		{
			addBase = true;
		}

		this.onTrainingFinished(gameState, events);

		if (addBase)
		{
			handleNewBase(gameState.ai.HQ, gameState);
		}
	}

	/**
	 * returns an entity collection of workers through BaseManager.pickBuilders
	 * TODO: when same accessIndex, sort by distance
	 */
	bulkPickWorkers(gameState: CommonGameState, baseRef: BaseManager, number: number): CommonEntityCollection | false
	{
		const accessIndex = baseRef.accessIndex;
		if (!accessIndex)
		{
			return false;
		}
		const baseBest = this.baseManagers.slice();
		// We can also use workers without a base.
		baseBest.push(this.noBase);
		baseBest.sort((a: BaseManager, b: BaseManager): 0 | 1 | -1 =>
		{
			if (a.accessIndex === accessIndex && b.accessIndex !== accessIndex)
			{
				return -1;
			}
			else if (b.accessIndex === accessIndex && a.accessIndex !== accessIndex)
			{
				return 1;
			}
			return 0;
		});

		let needed = number;
		const workers = new EntityCollection(gameState.sharedScript);
		for (const base of baseBest)
		{
			if (base.ID === baseRef.ID)
			{
				continue;
			}
			base.pickBuilders(gameState, workers, needed);
			if (workers.length >= number)
			{
				break;
			}
			needed = number - workers.length;
		}
		if (!workers.length)
		{
			return false;
		}
		return workers;
	}

	/**
	 * @return {Object} - Resources (estimation) still gatherable in our territory.
	 */
	getTotalResourceLevel(
		gameState: CommonGameState,
		resources: string[] = Resources.GetCodes(),
		proximity: string[] = ["nearby", "medium"],
	): Record<string, number>
	{
		const total: Record<string, number> = {};
		for (const res of resources)
		{
			total[res] = 0;
		}
		for (const base of this.baseManagers)
		{
			for (const res in total)
			{
				total[res] += base.getResourceLevel(gameState, res, proximity);
			}
		}

		return total;
	}

	/**
	 * Returns the current gather rate
	 * This is not per-se exact, it performs a few adjustments ad-hoc to account for travel distance, stuffs like that.
	 */
	GetCurrentGatherRates(gameState: CommonGameState): Record<string, number>
	{
		if (!this.turnCache.currentRates)
		{
			const currentRates: Record<string, number> = {};
			for (const res of Resources.GetCodes())
			{
				currentRates[res] = 0.5 * this.GetTCResGatherer(res);
			}

			this.addGatherRates(gameState, currentRates);

			for (const res of Resources.GetCodes())
			{
				currentRates[res] = Math.max(currentRates[res], 0);
			}

			this.turnCache.currentRates = currentRates;
		}

		return this.turnCache.currentRates;
	}

	/** Some functions that register that we assigned a gatherer to a resource this turn */

	/** Add a gatherer to the turn cache for this supply. */
	AddTCGatherer(supplyID: EntityId): void
	{
		if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID] !== undefined)
		{
			++this.turnCache.resourceGatherer[supplyID];
		}
		else
		{
			if (!this.turnCache.resourceGatherer)
			{
				this.turnCache.resourceGatherer = {};
			}
			this.turnCache.resourceGatherer[supplyID] = 1;
		}
	}

	/** Remove a gatherer from the turn cache for this supply. */
	RemoveTCGatherer(supplyID: EntityId): void
	{
		if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID])
		{
			--this.turnCache.resourceGatherer[supplyID];
		}
		else
		{
			if (!this.turnCache.resourceGatherer)
			{
				this.turnCache.resourceGatherer = {};
			}
			this.turnCache.resourceGatherer[supplyID] = -1;
		}
	}

	GetTCGatherer(supplyID: EntityId): number
	{
		if (this.turnCache.resourceGatherer && this.turnCache.resourceGatherer[supplyID])
		{
			return this.turnCache.resourceGatherer[supplyID];
		}

		return 0;
	}

	/** The next two are to register that we assigned a gatherer to a resource this turn. */
	AddTCResGatherer(resource: string): void
	{
		if (!this.turnCache.resourceGathererByType)
		{
			this.turnCache.resourceGathererByType = {};
		}
		this.turnCache.resourceGathererByType[resource] = (this.turnCache.resourceGathererByType[resource] ?? 0) + 1;

		if (this.turnCache.currentRates)
		{
			this.turnCache.currentRates[resource] += 0.5;
		}
	}

	GetTCResGatherer(resource: string): number
	{
		return this.turnCache.resourceGathererByType?.[resource] ?? 0;
	}

	/**
	 * returns the number of bases with a cc
	 * ActiveBases includes only those with a built cc
	 * PotentialBases includes also those with a cc in construction
	 */
	numActiveBases(): number
	{
		if (!this.turnCache.base)
		{
			this.updateBaseCache();
		}
		return this.turnCache.base?.active ?? 0;
	}

	hasActiveBase(): boolean
	{
		return !!this.numActiveBases();
	}

	numPotentialBases(): number
	{
		if (!this.turnCache.base)
		{
			this.updateBaseCache();
		}
		return this.turnCache.base?.potential ?? 0;
	}

	hasPotentialBase(): boolean
	{
		return !!this.numPotentialBases();
	}

	/**
	 * Updates the number of active and potential bases.
	 * 		.potential {number} - Bases that may or may not still be a foundation.
	 * 		.active {number} - Usable bases.
	 */
	updateBaseCache(): void
	{
		this.turnCache.base = { active: 0, potential: 0 };
		for (const base of this.baseManagers)
		{
			if (!base.anchor)
			{
				continue;
			}
			++this.turnCache.base.potential;
			if (base.anchor.foundationProgress() === undefined)
			{
				++this.turnCache.base.active;
			}
		}
	}

	resetBaseCache(): void
	{
		this.turnCache.base = undefined;
	}

	baselessBase(): BaseManager
	{
		return this.noBase;
	}

	/**
	 * @param {number} baseID
	 * @return {Object} - The base corresponding to baseID.
	 */
	getBaseByID(baseID: BaseId): BaseManager | undefined
	{
		if (this.noBase.ID === baseID)
		{
			return this.noBase;
		}
		return this.baseManagers.find((base: BaseManager): boolean => base.ID === baseID);
	}

	/**
	 * flag a resource as exhausted
	 */
	isResourceExhausted(resource: string): boolean
	{
		return this.baseManagers.every((base: BaseManager): boolean =>
			!base.dropsiteSupplies[resource].nearby.length &&
			!base.dropsiteSupplies[resource].medium.length &&
			!base.dropsiteSupplies[resource].faraway.length
		);
	}

	/**
	 * Count gatherers returning resources in the number of gatherers of resourceSupplies
	 * to prevent the AI always reassigning idle workers to these resourceSupplies (specially in naval maps).
	 */
	assignGatherers(): void
	{
		for (const base of this.baseManagers)
		{
			for (const worker of base.workers.values())
			{
				const aiState = requireStateName(worker);
				if (aiState.split(".").indexOf("RETURNRESOURCE") === -1)
				{
					continue;
				}
				const orders = ordersOf(worker);
				if (
					orders.length < 2 || !orders[1].target ||
					orders[1].target !== worker.getMetadata(PlayerID, "supply")
				)
				{
					continue;
				}
				this.AddTCGatherer(orders[1].target);
			}
		}
	}

	/**
	 * Assign an entity to the closest base.
	 * Used by the starting strategy.
	 */
	assignEntity(gameState: CommonGameState, ent: CommonEntity, territoryIndex: CellIndex<"territory">): void
	{
		const bestbase = this.assignToBase(gameState, ent, territoryIndex);
		// now assign entities garrisoned inside this entity
		if (ent.isGarrisonHolder() && ent.garrisoned().length)
		{
			for (const id of ent.garrisoned())
			{
				const garrisoned = gameState.getEntityById(id);
				if (bestbase && garrisoned)
				{
					bestbase.assignEntity(gameState, garrisoned);
				}
			}
		}
		// and find something useful to do if we already have a base
		if (isPlaced(ent) && bestbase && bestbase.ID !== this.noBase.ID)
		{
			bestbase.assignRolelessUnits(gameState, [ent]);
			if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER)
			{
				bestbase.reassignIdleWorkers(gameState, [ent]);
				bestbase.workerObject.update(gameState, ent);
			}
		}
	}

	/** Assigns ent to its base, the base of its territory cell, or else the best one; returns that base. */
	private assignToBase(
		gameState: CommonGameState,
		ent: CommonEntity,
		territoryIndex: CellIndex<"territory">,
	): BaseManager | undefined
	{
		for (const base of this.baseManagers)
		{
			if (
				(!ent.getMetadata(PlayerID, "base") || ent.getMetadata(PlayerID, "base") !== base.ID) &&
				base.territoryIndices.indexOf(territoryIndex) === -1
			)
			{
				continue;
			}
			base.assignEntity(gameState, ent);
			return base;
		}
		// entity outside our territory
		let bestbase;
		if (ent.hasClass("Structure") && !ent.decaying() && ent.resourceDropsiteTypes())
		{
			bestbase = this.createBase(gameState, ent, BaseManager.STATE_ANCHORLESS);
		}
		else
		{
			bestbase = getBestBase(gameState, this, ent) || this.noBase;
		}
		if (bestbase)
		{
			bestbase.assignEntity(gameState, ent);
		}
		return bestbase;
	}

	/**
	 * Adds the gather rates of individual bases to a shared object.
	 * @param {Object} gameState
	 * @param {Object} rates - The rates to add the gather rates to.
	 */
	addGatherRates(gameState: CommonGameState, rates: Record<string, number>): void
	{
		for (const base of this.baseManagers)
		{
			base.addGatherRates(gameState, rates);
		}
	}

	/**
	 * @param {number} territoryIndex
	 * @return {number} - The ID of the base at the given territory index.
	 */
	baseAtIndex(territoryIndex: CellIndex<"territory">): BaseId
	{
		// the map holds base ids, NO_BASE where no base claims the cell
		return baseId(this.basesMap.map[territoryIndex]);
	}

	/**
	 * @param {number} territoryIndex
	 */
	removeBaseFromTerritoryIndex(territoryIndex: CellIndex<"territory">): void
	{
		const baseID = this.baseAtIndex(territoryIndex);
		if (baseID === NO_BASE)
		{
			return;
		}
		const base = this.getBaseByID(baseID);
		if (base)
		{
			const index = base.territoryIndices.indexOf(territoryIndex);
			if (index !== -1)
			{
				base.territoryIndices.splice(index, 1);
			}
			else
			{
				aiWarn(" problem in headquarters::updateTerritories for base " + baseID);
			}
		}
		else
		{
			aiWarn(" problem in headquarters::updateTerritories without base " + baseID);
		}
		this.basesMap.map[territoryIndex] = 0;
	}

	/**
	 * @return {boolean} - Whether the index was added to a base.
	 */
	addTerritoryIndexToBase(
		gameState: CommonGameState,
		territoryIndex: CellIndex<"territory">,
		passabilityMap: CommonPassabilityMap,
	): boolean
	{
		if (this.baseAtIndex(territoryIndex) !== 0)
		{
			return false;
		}
		let landPassable = false;
		const ind = getMapIndices(territoryIndex, gameState.ai.geography.territoryMap, passabilityMap);
		let access;
		for (const k of ind)
		{
			if (!gameState.ai.geography.landRegions[gameState.ai.accessibility.landPassMap[k]])
			{
				continue;
			}
			landPassable = true;
			access = gameState.ai.accessibility.landPassMap[k];
			break;
		}
		if (!landPassable)
		{
			return false;
		}
		let distmin = Math.min();
		let baseID;
		const pos: CommonPosition = worldPos(
			gameState.ai.geography.territoryMap.cellSize *
				(territoryIndex % gameState.ai.geography.territoryMap.width + 0.5),
			gameState.ai.geography.territoryMap.cellSize *
				(Math.floor(territoryIndex / gameState.ai.geography.territoryMap.width) + 0.5),
		);
		for (const base of this.baseManagers)
		{
			if (!base.anchor)
			{
				continue;
			}
			if (base.accessIndex !== access)
			{
				continue;
			}
			const dist = SquareVectorDistance(base.anchor.position(), pos);
			if (dist >= distmin)
			{
				continue;
			}
			distmin = dist;
			baseID = base.ID;
		}
		if (!baseID)
		{
			return false;
		}
		const territoryBase = this.getBaseByID(baseID);
		if (territoryBase)
		{
			territoryBase.territoryIndices.push(territoryIndex);
		}
		this.basesMap.map[territoryIndex] = baseID;
		return true;
	}

	/**
	 * We will loop only on one active base per turn.
	 */
	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): void
	{
		Engine.ProfileStart("BasesManager update");

		this.assignGatherers();
		let nbBases = this.baseManagers.length;
		let activeBase = false;
		this.noBase.update(gameState, queues, events);
		while (!activeBase && nbBases !== 0)
		{
			this.currentBase %= this.baseManagers.length;
			activeBase = this.baseManagers[this.currentBase++].update(gameState, queues, events);
			--nbBases;
		}

		Engine.ProfileStop();
	}

	Serialize(): SerializedBasesManager
	{
		const properties = { currentBase: this.currentBase };

		const baseManagers = [];
		for (const base of this.baseManagers)
		{
			baseManagers.push(base.Serialize());
		}

		return { properties: properties, noBase: this.noBase.Serialize(), baseManagers: baseManagers };
	}
}
