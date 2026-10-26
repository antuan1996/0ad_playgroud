import * as filters from "simulation/ai/common-api/filters.js";
import type { BasesManager } from "./basesManager.ts";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { Config } from "./config.ts";
import * as difficulty from "./difficultyLevel.ts";
import { getBestBase, getBuiltEntity, getLandAccess, isFastMoving, isNotWorthBuilding, requireTemplate, requireValue } from
	"../adapter/entityExtend.ts";
import { BaseResources } from "../world/baseResources.ts";
import { createObstructionMap } from "../world/mapModule.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { Worker } from "../execution/worker.ts";
import { NO_TEMPLATE, seconds, worldPos } from "../adapter/brands.ts";
import { isInState } from "../adapter/unitState.ts";
import { postCommand } from "../adapter/commands.ts";

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

export type ResourceSupply = {
	dropsite: EntityId;
	dist: number;
	ent?: CommonEntity;
	id: EntityId;
};

export type SerializedBaseManager = {
	ID: number;
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

export class BaseManager
{
	declare Config: Config;
	declare ID: number;
	declare accessIndex: AccessIndex | undefined;
	declare anchor: CommonEntity | undefined;
	declare anchorId: EntityId | undefined;
	declare basesManager: BasesManager;
	declare buildings: CommonEntityCollection;
	declare constructing: boolean;
	/** The resources within reach of the base's dropsites; the accessors below keep its fields' old names. */
	declare resources: BaseResources;
	get dropsiteSupplies(): Record<string, Record<string, ResourceSupply[]>> { return this.resources.dropsiteSupplies; }
	set dropsiteSupplies(supplies: Record<string, Record<string, ResourceSupply[]>>) { this.resources.dropsiteSupplies = supplies; }
	get dropsites(): Record<number, boolean | undefined> { return this.resources.dropsites; }
	set dropsites(dropsites: Record<number, boolean | undefined>) { this.resources.dropsites = dropsites; }
	declare gatherers: Record<string, { nextCheck: number; used: number; lost: number }>;
	declare maxDistResourceSquare: number;
	declare mobileDropsites: CommonEntityCollection;
	declare neededDefenders: number;
	declare territoryIndices: Array<CellIndex<"territory">>;
	declare timeNextIdleCheck: GameSeconds;
	declare units: CommonEntityCollection;
	declare workerObject: Worker;
	declare workers: CommonEntityCollection;

	constructor(gameState: CommonGameState, basesManager: BasesManager)
	{
		this.Config = basesManager.Config;
		this.ID = gameState.ai.uniqueIDs.bases++;
		this.basesManager = basesManager;
		// init() makes it afresh; here so that a base read back from a save has one before init
		this.resources = new BaseResources();

		// anchor building: seen as the main building of the base. Needs to have territorial influence
		this.anchor = undefined;
		this.anchorId = undefined;
		this.accessIndex = undefined;

		// Maximum distance (from any dropsite) to look for resources
		// 3 areas are used: from 0 to max/4, from max/4 to max/2 and from max/2 to max
		this.maxDistResourceSquare = 360*360;

		this.constructing = false;
		// Defenders to train in this cc when its construction is finished
		this.neededDefenders = this.Config.difficulty > difficulty.EASY ? 3 + 2*(this.Config.difficulty - 3) : 0;

		// vector for iterating, to check one use the HQ map.
		this.territoryIndices = [];

		this.timeNextIdleCheck = seconds(0);
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

	init(gameState: CommonGameState, state: string): void
	{
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

		// the resources within reach of the base's dropsites (world/baseResources.ts)
		this.resources = new BaseResources();
		this.gatherers = {};
		for (const res of Resources.GetCodes())
			this.gatherers[res] = { "nextCheck": 0, "used": 0, "lost": 0 };
	}

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
		if (!anchorEntity.hasClass("CivCentre"))
		{
			aiWarn("Error: Petra base " + this.ID + " has been assigned " + anchorEntity.templateName() +
				" as anchor.");
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
				aiWarn("Error: Petra base " + this.ID + " has been assigned " + ent.templateName() +
					" as origin.");
			}
			this.accessIndex = getLandAccess(gameState, ent);
		}
		else if (this.accessIndex !== getLandAccess(gameState, ent))
		{
			aiWarn(" Error: Petra base " + this.ID + " with access " + this.accessIndex +
				" has been assigned " + ent.templateName() + " with access" +
				getLandAccess(gameState, ent));
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
		const baseless = this.ID == this.basesManager.baselessBase().ID;
		if (!this.resources.addDropsite(gameState, dropsite, this.accessIndex, baseless, this.maxDistResourceSquare, this.Config.debug))
			return;
		if (deserialized)
			return;

		// Allows all allies to use this dropsite except if base anchor to be sure to keep
		// a minimum of resources for this base
		postCommand({
			"type": "set-dropsite-sharing",
			"entities": [dropsite.id()],
			"shared": dropsite.id() != this.anchorId
		});
	}

	// completely remove the dropsite resources from our list.
	removeDropsite(gameState: CommonGameState, entityID: EntityId): void
	{
		this.resources.removeDropsite(gameState, entityID);
	}

	/**
	 * @return {Object} - The position of the best place to build a new dropsite for the specified resource,
	 *			its quality and its template name.
	 */
	findBestDropsiteAndLocation(gameState: CommonGameState, resource: string):
		{ quality: number; pos: CommonPosition; templateName: TemplateName }
	{
		// templateName is set together with quality, so it is "" only when the
		// quality is 0, which every caller rejects before using it.
		let bestResult: { quality: number; pos: CommonPosition; templateName: TemplateName } = {
			"quality": 0,
			"pos": worldPos(0, 0),
			"templateName": NO_TEMPLATE
		};
		for (const templateName of gameState.ai.HQ.buildManager.findStructuresByFilter(gameState,
			filters.isDropsite(resource)))
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
	findBestDropsiteLocation(gameState: CommonGameState, resource: string, templateName: TemplateName): { quality: number; pos: CommonPosition }
	{
		// Callers pass a template name from findStructuresByFilter(), which only
		// returns names whose template exists and is available.
		const template = requireTemplate(gameState, gameState.applyCiv(templateName));

		// CCs and Docks are handled elsewhere.
		if (template.hasClasses(["CivCentre", "Dock"]))
			return { "quality": 0, "pos": worldPos(0, 0) };

		let halfSize = 0;
		if (template.get("Footprint/Square"))
			halfSize = Math.max(+template.get("Footprint/Square/@depth"), +template.get("Footprint/Square/@width")) / 2;
		else if (template.get("Footprint/Circle"))
			halfSize = +template.get("Footprint/Circle/@radius");

		// This builds a map. The procedure is fairly simple. It adds the resource maps
		//	(which are dynamically updated and are made so that they will facilitate DP placement)
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
		const obstructionRadius = requireValue(template.obstructionRadius());
		const radius = Math.ceil(obstructionRadius.max / obstructions.cellSize);

		const territoryMap = gameState.ai.HQ.geography.territoryMap;
		const width = territoryMap.width;
		const cellSize = territoryMap.cellSize;

		const droppableResources = template.resourceDropsiteTypes() ?? [];

		for (const j of this.territoryIndices)
		{
			const i = territoryMap.getNonObstructedTile(j, radius, obstructions);
			if (i < 0)  // no room around
				continue;

			// We add 3 times the needed resource and once others that can be dropped here.
			let total = 2 * gameState.sharedScript.resourceMaps[resource].map[j];
			for (const res in gameState.sharedScript.resourceMaps)
				if (droppableResources.indexOf(res) != -1)
					total += gameState.sharedScript.resourceMaps[res].map[j];

			total *= 0.7;   // Just a normalisation factor as the locateMap is limited to 255
			if (total <= bestVal)
				continue;

			const pos: CommonPosition = worldPos(cellSize * (j%width+0.5), cellSize * (Math.floor(j/width)+0.5));

			for (const dp of dpEnts)
			{
				const dpPos = dp.position();
				if (!dpPos)
					continue;
				const dist = SquareVectorDistance(dpPos, pos);
				if (dist < 3600)
				{
					total = 0;
					break;
				}
				else if (dist < 6400)
					total *= (Math.sqrt(dist)-60)/20;
			}
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

	getResourceLevel(gameState: CommonGameState, type: string, distances: string[] = ["nearby", "medium", "faraway"]): number
	{
		return this.resources.getResourceLevel(gameState, type, distances);
	}

	/** check our resource levels and react accordingly */
	checkResourceLevels(gameState: CommonGameState, queues: PetraRuntime.QueueCollection): void
	{
		for (const type of Resources.GetCodes())
		{
			if (type == "food")
			{
				const prox = ["nearby"];
				if (gameState.currentPhase() < 2)
					prox.push("medium");
				if (gameState.ai.HQ.canBuild(gameState, "structures/{civ}/field"))	// let's see if we need to add new farms.
				{
					const count = this.getResourceLevel(gameState, type, prox);  // animals are not accounted
					const numFarms = gameState.getOwnStructures().filter(filters.byClass("Field"))
						.length;  // including foundations
					const numQueue = queues.field.countQueuedUnits();

					// TODO  if not yet farms, add a check on time used/lost and build farmstead if needed
					if (numFarms + numQueue == 0)	// starting game, rely on fruits as long as we have enough of them
					{
						if (count < 600)
						{
							queues.field.addPlan(new ConstructionPlan(gameState,
								"structures/{civ}/field", { "favoredBase": this.ID }));
							gameState.ai.HQ.needFarm = true;
						}
					}
					else if (!gameState.ai.HQ.maxFields || numFarms + numQueue < gameState.ai.HQ.maxFields)
					{
						const numFound = gameState.getOwnFoundations().filter(filters.byClass("Field"))
							.length;
						let goal = this.Config.Economy.provisionFields;
						if (gameState.ai.HQ.saveResources || gameState.ai.HQ.saveSpace || count > 300 || numFarms > 5)
							goal = Math.max(goal-1, 1);
						if (numFound + numQueue < goal)
						{
							queues.field.addPlan(new ConstructionPlan(gameState,
								"structures/{civ}/field", { "favoredBase": this.ID }));
						}
					}
					else if (gameState.ai.HQ.needCorral &&
						!gameState.getOwnEntitiesByClass("Corral", true).hasEntities() &&
						!queues.corral.hasQueuedUnits() &&
						gameState.ai.HQ.canBuild(gameState, "structures/{civ}/corral"))
					{
						queues.corral.addPlan(new ConstructionPlan(gameState,
							"structures/{civ}/corral", { "favoredBase": this.ID }));
					}
					continue;
				}
				if (!gameState.getOwnEntitiesByClass("Corral", true).hasEntities() &&
				    !queues.corral.hasQueuedUnits() && gameState.ai.HQ.canBuild(gameState, "structures/{civ}/corral"))
				{
					const count = this.getResourceLevel(gameState, type, prox);  // animals are not accounted
					if (count < 900)
					{
						queues.corral.addPlan(new ConstructionPlan(gameState,
							"structures/{civ}/corral", { "favoredBase": this.ID }));
						gameState.ai.HQ.needCorral = true;
					}
				}
				continue;
			}
			// Non food stuff
			if (!gameState.sharedScript.resourceMaps[type] || queues.dropsites.hasQueuedUnits() ||
				gameState.getOwnFoundations().filter(filters.byClass("Storehouse")).hasEntities())
			{
				this.gatherers[type].nextCheck = gameState.ai.playedTurn;
				this.gatherers[type].used = 0;
				this.gatherers[type].lost = 0;
				continue;
			}
			if (gameState.ai.playedTurn < this.gatherers[type].nextCheck)
				continue;
			for (const ent of this.gatherersByType(gameState, type).values())
			{
				if (isInState(ent, "INDIVIDUAL.GATHER.GATHERING"))
					++this.gatherers[type].used;
				else if (isInState(ent, "INDIVIDUAL.GATHER.RETURNINGRESOURCE.APPROACHING"))
					++this.gatherers[type].lost;
			}
			// TODO  add also a test on remaining resources.
			const total = this.gatherers[type].used + this.gatherers[type].lost;
			if (total > 150 || total > 60 && type != "wood")
			{
				const ratio = this.gatherers[type].lost / total;
				if (ratio > 0.15)
				{
					const newDP = this.findBestDropsiteAndLocation(gameState, type);
					// templateName is only "" when quality is 0, which the > 50 check rejects.
					if (newDP.quality > 50 && gameState.ai.HQ.canBuild(gameState, newDP.templateName))
					{
						queues.dropsites.addPlan(new ConstructionPlan(gameState, newDP.templateName,
							{ "base": this.ID, "type": type }, newDP.pos));
					}
					else if (!gameState.getOwnFoundations().filter(filters.byClass("CivCentre"))
						.hasEntities() &&
						!queues.civilCentre.hasQueuedUnits())
					{
						// No good dropsite, try to build a new base if no base already planned,
						// and if not possible, be less strict on dropsite quality.
						if ((!gameState.ai.HQ.canExpand || !gameState.ai.HQ.buildNewBase(gameState, queues, type)) &&
							newDP.quality > Math.min(25, 50*0.15/ratio) &&
							gameState.ai.HQ.canBuild(gameState, newDP.templateName))
						{
							queues.dropsites.addPlan(new ConstructionPlan(gameState,
								newDP.templateName, { "base": this.ID, "type": type },
								newDP.pos));
						}
					}
				}
				this.gatherers[type].nextCheck = gameState.ai.playedTurn + 20;
				this.gatherers[type].used = 0;
				this.gatherers[type].lost = 0;
			}
			else if (total == 0)
				this.gatherers[type].nextCheck = gameState.ai.playedTurn + 10;
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

			this.gatherersByType(gameState, res).forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
			{
				if (ent.isIdle() || !ent.position())
					return;
				const gRate = ent.currentGatherRate();
				if (gRate)
					currentRates[res] += Math.log(1+gRate)/1.1;
			});
			if (res == "food")
			{
				this.workersBySubrole(gameState, Worker.SUBROLE_HUNTER).forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
				{
					if (ent.isIdle() || !ent.position())
						return;
					const gRate = ent.currentGatherRate();
					if (gRate)
						currentRates[res] += Math.log(1+gRate)/1.1;
				});
				this.workersBySubrole(gameState, Worker.SUBROLE_FISHER).forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
				{
					if (ent.isIdle() || !ent.position())
						return;
					const gRate = ent.currentGatherRate();
					if (gRate)
						currentRates[res] += Math.log(1+gRate)/1.1;
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
		let nb = 1;    // no more than 1 change per turn (otherwise we should update the rates)
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

		for (let i = mostNeeded.length-1; i > 0; --i)
		{
			const lessNeed = mostNeeded[i];
			for (let j = 0; j < i; ++j)
			{
				const moreNeed = mostNeeded[j];
				const lastFailed = gameState.ai.HQ.lastFailedGather[moreNeed.type];
				if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
					continue;
				// Ensure that the most wanted resource is not exhausted
				if (moreNeed.type != "food" && this.basesManager.isResourceExhausted(moreNeed.type))
				{
					if (lessNeed.type != "food" && this.basesManager.isResourceExhausted(lessNeed.type))
						continue;

					// And if so, move the gatherer to the less wanted one.
					nb = this.switchGatherer(gameState, moreNeed.type, lessNeed.type, nb);
					if (nb == 0)
						return;
				}

				// If we assume a mean rate of 0.5 per gatherer, this diff should be > 1
				// but we require a bit more to avoid too frequent changes
				if (scale*moreNeed.wanted - moreNeed.current - scale*lessNeed.wanted + lessNeed.current > 1.5 ||
				    lessNeed.type != "food" && this.basesManager.isResourceExhausted(lessNeed.type))
				{
					nb = this.switchGatherer(gameState, lessNeed.type, moreNeed.type, nb);
					if (nb == 0)
						return;
				}
			}
		}
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
		if (from == "food" && gatherers.filter(filters.byClass("CitizenSoldier")).hasEntities())
			only = "CitizenSoldier";
		else if (to == "food" && gatherers.filter(filters.byClass("Civilian")).hasEntities())
			only = "Civilian";

		for (const ent of gatherers.values())
		{
			if (num == 0)
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
			if (!ent.position())
				continue;
			// Support elephant can only be builders
			if (ent.hasClass("Support") && ent.hasClass("Elephant"))
			{
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
				continue;
			}

			if (ent.hasClass("Worker"))
			{
				// Just emergency repairing here. It is better managed in assignToFoundations
				if (ent.isBuilder() && this.anchor && this.anchor.needsRepair() &&
					gameState.getOwnEntitiesByMetadata("target-foundation", this.anchor.id()).length < 2)
					ent.repair(this.anchor);
				else if (ent.isGatherer())
				{
					const mostNeeded = gameState.ai.HQ.pickMostNeededResources(gameState);
					for (const needed of mostNeeded)
					{
						if (!ent.canGather(needed.type))
							continue;
						const lastFailed = gameState.ai.HQ.lastFailedGather[needed.type];
						if (lastFailed && gameState.ai.elapsedTime - lastFailed < 20)
							continue;
						if (needed.type != "food" && this.basesManager.isResourceExhausted(needed.type))
							continue;
						ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_GATHERER);
						ent.setMetadata(PlayerID, "gather-type", needed.type);
						this.basesManager.AddTCResGatherer(needed.type);
						break;
					}
				}
			}
			else if (isFastMoving(ent) && ent.canGather("food") && ent.canAttackClass("Animal"))
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_HUNTER);
			else if (ent.hasClass("FishingBoat"))
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_FISHER);
		}
	}

	workersBySubrole(gameState: CommonGameState, subrole: string): CommonEntityCollection
	{
		return gameState.updatingCollection("subrole-" + subrole +"-base-" + this.ID,
			filters.byMetadata(PlayerID, "subrole", subrole), this.workers);
	}

	gatherersByType(gameState: CommonGameState, type: string): CommonEntityCollection
	{
		return gameState.updatingCollection("workers-gathering-" + type +"-base-" +
			this.ID, filters.byMetadata(PlayerID, "gather-type", type),
		this.workersBySubrole(gameState, Worker.SUBROLE_GATHERER));
	}

	/**
	 * returns an entity collection of workers.
	 * They are idled immediatly and their subrole set to idle.
	 */
	pickBuilders(gameState: CommonGameState, workers: CommonEntityCollection, number: number): void
	{
		const availableWorkers = this.workers.filter((ent: import("simulation/ai/common-api/entity.js").Entity): boolean =>
		{
			if (!ent.position() || !ent.isBuilder())
				return false;
			if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
				return false;
			if (ent.getMetadata(PlayerID, "transport"))
				return false;
			return true;
		}).toEntityArray();
		availableWorkers.sort((a: import("simulation/ai/common-api/entity.js").Entity, b: import("simulation/ai/common-api/entity.js").Entity): number =>
		{
			let vala = 0;
			let valb = 0;
			if (a.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_BUILDER)
				vala = 100;
			if (b.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_BUILDER)
				valb = 100;
			if (a.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_IDLE)
				vala = -50;
			if (b.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_IDLE)
				valb = -50;
			if (a.getMetadata(PlayerID, "plan") === undefined)
				vala = -20;
			if (b.getMetadata(PlayerID, "plan") === undefined)
				valb = -20;
			return vala - valb;
		});
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
		let foundations = this.buildings.filter(filters.and(filters.isFoundation(),
			filters.not(filters.byClass("Field"))));

		const damagedBuildings = this.buildings.filter((ent: import("simulation/ai/common-api/entity.js").Entity): boolean => ent.foundationProgress() === undefined && ent.needsRepair());

		// Check if nothing to build
		if (!foundations.length && !damagedBuildings.length)
			return;

		const workers = this.workers.filter((ent: import("simulation/ai/common-api/entity.js").Entity): boolean => ent.isBuilder());
		const builderWorkers = this.workersBySubrole(gameState, Worker.SUBROLE_BUILDER);
		const idleBuilderWorkers = builderWorkers.filter(filters.isIdle());

		// if we're constructing and we have the foundations to our base anchor, only try building that.
		if (this.constructing && foundations.filter(filters.byMetadata(PlayerID, "baseAnchor", true))
			.hasEntities())
		{
			foundations = foundations.filter(filters.byMetadata(PlayerID, "baseAnchor", true));
			const tID = foundations.toEntityArray()[0].id();
			workers.forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
			{
				const target = ent.getMetadata(PlayerID, "target-foundation");
				if (target && target != tID)
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
				fromOtherBase.forEach((worker: CommonEntity): void =>
				{
					worker.setMetadata(PlayerID, "base", baseID);
					worker.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
					workers.updateEnt(worker);
					builderWorkers.updateEnt(worker);
					idleBuilderWorkers.updateEnt(worker);
				});
			}
		}

		let builderTot = builderWorkers.length - idleBuilderWorkers.length;

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

		for (const target of foundations.values())
		{
			if (target.hasClass("Field"))
				continue; // we do not build fields

			if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
				if (!target.hasClasses(["CivCentre", "Wall"]) &&
				    (!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder")))
					continue;

			// if our territory has shrinked since this foundation was positioned, do not build it
			if (isNotWorthBuilding(gameState, target))
				continue;

			let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
			let maxTotalBuilders = Math.ceil(workers.length * builderRatio);
			if (maxTotalBuilders < 2 && workers.length > 1)
				maxTotalBuilders = 2;
			if (target.hasClass("House") && gameState.getPopulationLimit() < gameState.getPopulation() + 5 &&
			    gameState.getPopulationLimit() < gameState.getPopulationMax())
				maxTotalBuilders += 2;
			let targetNB = 2;
			if (target.hasClasses(["Fortress", "Wonder"]) ||
			    target.getMetadata(PlayerID, "phaseUp") == true)
				targetNB = 7;
			else if (target.hasClasses(["Barracks", "Range", "Stable", "Tower", "Market"]))
				targetNB = 4;
			else if (target.hasClasses(["House", "DropsiteWood"]))
				targetNB = 3;

			if (target.getMetadata(PlayerID, "baseAnchor") == true ||
			    target.hasClass("Wonder") && gameState.getVictoryConditions().has("wonder"))
			{
				targetNB = 15;
				maxTotalBuilders = Math.max(maxTotalBuilders, 15);
			}

			if (!this.basesManager.hasActiveBase())
			{
				targetNB = workers.length;
				maxTotalBuilders = targetNB;
			}

			if (assigned >= targetNB)
				continue;
			idleBuilderWorkers.forEach(function(ent: import("simulation/ai/common-api/entity.js").Entity): void 
			{
				if (ent.getMetadata(PlayerID, "target-foundation") !== undefined)
					return;
				if (assigned >= targetNB || !ent.position() ||
					SquareVectorDistance(ent.position(), target.position()) > 40000)
				{
					return;
				}
				++assigned;
				++builderTot;
				ent.setMetadata(PlayerID, "target-foundation", target.id());
			});
			if (assigned >= targetNB || builderTot >= maxTotalBuilders)
				continue;
			const nonBuilderWorkers = workers.filter(function(ent: import("simulation/ai/common-api/entity.js").Entity): boolean 
			{
				if (ent.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_BUILDER)
					return false;
				if (!ent.position())
					return false;
				if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
					return false;
				if (ent.getMetadata(PlayerID, "transport"))
					return false;
				return true;
			}).toEntityArray();
			const time = target.buildTime();
			nonBuilderWorkers.sort((workerA: import("simulation/ai/common-api/entity.js").Entity, workerB: import("simulation/ai/common-api/entity.js").Entity): number =>
			{
				let coeffA = SquareVectorDistance(target.position(), workerA.position());
				// elephant moves slowly, so when far away they are only useful if build time is long
				if (workerA.hasClass("Elephant"))
					coeffA *= 0.5 * (1 + Math.sqrt(coeffA)/5/time);
				else if (workerA.getMetadata(PlayerID, "gather-type") == "food")
					coeffA *= 3;
				let coeffB = SquareVectorDistance(target.position(), workerB.position());
				if (workerB.hasClass("Elephant"))
					coeffB *= 0.5 * (1 + Math.sqrt(coeffB)/5/time);
				else if (workerB.getMetadata(PlayerID, "gather-type") == "food")
					coeffB *= 3;
				return coeffA - coeffB;
			});
			let current = 0;
			const nonBuilderTot = nonBuilderWorkers.length;
			while (assigned < targetNB && builderTot < maxTotalBuilders && current < nonBuilderTot)
			{
				++assigned;
				++builderTot;
				const ent = nonBuilderWorkers[current++];
				ent.stopMoving();
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
				ent.setMetadata(PlayerID, "target-foundation", target.id());
			}
		}

		for (const target of damagedBuildings.values())
		{
			// Don't repair if we're still under attack, unless it's a vital (civcentre or wall) building
			// that's being destroyed.
			if (gameState.ai.HQ.isNearInvadingArmy(target.position()))
			{
				if (target.healthLevel() > 0.5 ||
				    !target.hasClasses(["CivCentre", "Wall"]) &&
				    (!target.hasClass("Wonder") || !gameState.getVictoryConditions().has("wonder")))
					continue;
			}
			else if (noRepair && !target.hasClass("CivCentre"))
				continue;

			if (target.decaying())
				continue;

			let assigned = gameState.getOwnEntitiesByMetadata("target-foundation", target.id()).length;
			let maxTotalBuilders = Math.ceil(workers.length * builderRatio);
			let targetNB = 1;
			if (target.hasClasses(["Fortress", "Wonder"]))
				targetNB = 3;
			if (target.getMetadata(PlayerID, "baseAnchor") == true ||
			    target.hasClass("Wonder") && gameState.getVictoryConditions().has("wonder"))
			{
				maxTotalBuilders = Math.ceil(workers.length * Math.max(0.3, builderRatio));
				targetNB = 5;
				if (target.healthLevel() < 0.3)
				{
					maxTotalBuilders = Math.ceil(workers.length * Math.max(0.6, builderRatio));
					targetNB = 7;
				}

			}

			if (assigned >= targetNB)
				continue;
			idleBuilderWorkers.forEach(function(ent: import("simulation/ai/common-api/entity.js").Entity): void 
			{
				if (ent.getMetadata(PlayerID, "target-foundation") !== undefined)
					return;
				if (assigned >= targetNB || !ent.position() ||
				    SquareVectorDistance(ent.position(), target.position()) > 40000)
					return;
				++assigned;
				++builderTot;
				ent.setMetadata(PlayerID, "target-foundation", target.id());
			});
			if (assigned >= targetNB || builderTot >= maxTotalBuilders)
				continue;
			const nonBuilderWorkers = workers.filter(function(ent: import("simulation/ai/common-api/entity.js").Entity): boolean 
			{
				if (ent.getMetadata(PlayerID, "subrole") === Worker.SUBROLE_BUILDER)
					return false;
				if (!ent.position())
					return false;
				if (ent.getMetadata(PlayerID, "plan") == -2 || ent.getMetadata(PlayerID, "plan") == -3)
					return false;
				if (ent.getMetadata(PlayerID, "transport"))
					return false;
				return true;
			});
			const num = Math.min(nonBuilderWorkers.length, targetNB-assigned);
			const nearestNonBuilders = nonBuilderWorkers.filterNearest(target.position(), num);

			nearestNonBuilders.forEach(function(ent: import("simulation/ai/common-api/entity.js").Entity): void 
			{
				++assigned;
				++builderTot;
				ent.stopMoving();
				ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_BUILDER);
				ent.setMetadata(PlayerID, "target-foundation", target.id());
			});
		}
	}

	/** Return false when the base is not active (no workers on it) */
	update(gameState: CommonGameState, queues: PetraRuntime.QueueCollection, events: EngineAIEvents): boolean
	{
		const baseless = this.basesManager.baselessBase();
		if (this.ID == baseless.ID)
		{
			// if some active base, reassigns the workers/buildings
			// otherwise look for anything useful to do, i.e. treasures to gather
			if (this.basesManager.hasActiveBase())
			{
				for (const ent of this.units.values())
				{
					// a unit always finds a base while one is active
					const bestBase = requireValue(getBestBase(gameState, ent));
					if (bestBase.ID != this.ID)
						bestBase.assignEntity(gameState, ent);
				}
				for (const ent of this.buildings.values())
				{
					const bestBase = getBestBase(gameState, ent);
					if (!bestBase)
					{
						if (ent.hasClass("Dock"))
						{
							aiWarn("Petra: dock in 'noBase' baseManager. It may be useful to " +
								"do an anchorless base for " + ent.templateName());
						}
						continue;
					}
					if (ent.resourceDropsiteTypes())
						this.removeDropsite(gameState, ent.id());
					bestBase.assignEntity(gameState, ent);
				}
			}
			else if (gameState.ai.HQ.canBuildUnits)
			{
				this.assignToFoundations(gameState);
				if (gameState.ai.elapsedTime > this.timeNextIdleCheck)
					this.setWorkersIdleByPriority(gameState);
				this.assignRolelessUnits(gameState);
				this.reassignIdleWorkers(gameState);
				for (const ent of this.workers.values())
					this.workerObject.update(gameState, ent);
				for (const ent of this.mobileDropsites.values())
					this.workerObject.moveToGatherer(gameState, ent, false);
			}
			return false;
		}

		if (!this.anchor)   // This anchor has been destroyed, but the base may still be usable
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
				if (!ent.position())
					continue;
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

			this.assignToFoundations(gameState);
			if (gameState.ai.elapsedTime > this.timeNextIdleCheck)
				this.setWorkersIdleByPriority(gameState);
			this.assignRolelessUnits(gameState);
			this.reassignIdleWorkers(gameState);
			for (const ent of this.workers.values())
				this.workerObject.update(gameState, ent);
			for (const ent of this.mobileDropsites.values())
				this.workerObject.moveToGatherer(gameState, ent, false);
			return true;
		}

		Engine.ProfileStart("Base update - base " + this.ID);

		this.checkResourceLevels(gameState, queues);
		this.assignToFoundations(gameState);

		if (this.constructing)
		{
			const owner = gameState.ai.HQ.geography.territoryMap.getOwner(this.anchor.position());
			if (owner != 0 && !gameState.isPlayerAlly(owner))
			{
				// we're in enemy territory. If we're too close from the enemy, destroy us.
				const ccEnts = gameState.updatingGlobalCollection("allCCs",
					filters.byClass("CivCentre"));
				for (const cc of ccEnts.values())
				{
					if (cc.owner() != owner)
						continue;
					if (SquareVectorDistance(cc.position(), this.anchor.position()) > 8000)
						continue;
					this.anchor.destroy();
					this.basesManager.resetBaseCache();
					break;
				}
			}
		}
		else if (this.neededDefenders && gameState.ai.HQ.trainEmergencyUnits(gameState, [this.anchor.position()]))
			--this.neededDefenders;

		if (gameState.ai.elapsedTime > this.timeNextIdleCheck &&
		   (gameState.currentPhase() > 1 || gameState.ai.HQ.phasing == 2))
			this.setWorkersIdleByPriority(gameState);

		this.assignRolelessUnits(gameState);
		this.reassignIdleWorkers(gameState);
		// check if workers can find something useful to do
		for (const ent of this.workers.values())
			this.workerObject.update(gameState, ent);
		for (const ent of this.mobileDropsites.values())
			this.workerObject.moveToGatherer(gameState, ent, false);

		Engine.ProfileStop();
		return true;
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
			"dropsiteSupplies": this.resources.dropsiteSupplies
		};
	}

	Deserialize(gameState: CommonGameState, data: SerializedBaseManager): void
	{
		// Fallbacks for fields absent in savegames written by an older version:
		// either the constructor default, or the value already held by this manager
		// when it depends on the game state (basesManager calls init() between the
		// two calls to this method)
		this.ID = data.ID ?? this.ID;
		this.anchorId = data.anchorId;
		this.accessIndex = data.accessIndex;
		this.maxDistResourceSquare = data.maxDistResourceSquare ?? 360 * 360;
		this.constructing = data.constructing ?? false;
		this.gatherers = data.gatherers ?? this.gatherers;
		this.neededDefenders = data.neededDefenders ?? this.neededDefenders;
		this.territoryIndices = data.territoryIndices ?? [];
		this.timeNextIdleCheck = data.timeNextIdleCheck ?? 0;
		this.resources.dropsiteSupplies = data.dropsiteSupplies ?? this.resources.dropsiteSupplies;

		this.anchor = this.anchorId !== undefined ? gameState.getEntityById(this.anchorId) : undefined;
	}
}
