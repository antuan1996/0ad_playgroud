import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { NO_BASE, NO_LAND, cellIndex, worldPos } from "../adapter/brands.ts";
import { getBuiltEntity, requireTemplate, requireValue } from "../adapter/entityExtend.ts";
import { isStructureTemplate } from "../adapter/templateData.ts";
import * as mapMask from "../world/mapMask.ts";
import { createObstructionMap } from "../world/mapModule.ts";
import { buildOverseaDock, constructOnShore, findDockPosition } from "./dockPlacement.ts";
import { QueuePlan, type PlanMetadata, type PlanStart } from "./queueplan.ts";

export type BuildingPosition = {
	x: number;
	z: number;
	angle: number;
	base: BaseId;
	access?: AccessIndex;
	xx?: number;
	zz?: number;
} | false;

/** A market's cell on our border gains, and with the town phase another cell inside it, unless it shoots */
function borderBonus(
	placement: InfoMap<"territory">,
	j: CellIndex<"territory">,
	border: number,
	rule: { favorBorder: boolean | undefined; disfavorBorder: boolean; },
): void
{
	if (rule.favorBorder && border & mapMask.border)
	{
		placement.set(j, placement.map[j] + 50);
	}
	else if (rule.disfavorBorder && !(border & mapMask.fullBorder))
	{
		placement.set(j, placement.map[j] + 10);
	}
}

/** What one of our structures adds to the placement map of a new building; returns whether it is a house near a house */
function influenceOf(
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	placement: InfoMap<"territory">,
	ent: CommonStructureEntity,
): boolean
{
	const cellSize = placement.cellSize;
	const pos = ent.position();
	const x = Math.round(pos[0] / cellSize);
	const z = Math.round(pos[1] / cellSize);

	const struct = getBuiltEntity(gameState, ent);
	const structDropsiteTypes = struct.resourceDropsiteTypes();
	if (structDropsiteTypes && structDropsiteTypes.indexOf("food") !== -1)
	{
		if (template.hasClasses(["Field", "Corral"]))
		{
			placement.addInfluence(x, z, 80 / cellSize, 50);
		}
		// If this is not a field add a negative influence because we want to leave this area for fields
		else
		{
			placement.addInfluence(x, z, 80 / cellSize, -20);
		}
	}
	else if (template.hasClass("House"))
	{
		if (ent.hasClass("House"))
		{
			placement.addInfluence(x, z, 60 / cellSize, 40); // houses are close to other houses
			return true;
		}
		else if (ent.hasClasses(["Gate", "!Wall"]))
		{
			placement.addInfluence(x, z, 60 / cellSize, -40); // and further away from other stuffs
		}
	}
	else if (
		template.hasClass("Farmstead") && !ent.hasClasses(["Field", "Corral"]) && ent.hasClasses(["Gate", "!Wall"])
	)
	{
		placement.addInfluence(x, z, 100 / cellSize, -25); // move farmsteads away to make room (Wall test needed for iber)
	}
	else if (template.hasClass("GarrisonFortress") && ent.hasClass("House"))
	{
		placement.addInfluence(x, z, 120 / cellSize, -50);
	}
	else if (template.hasClass("Military"))
	{
		placement.addInfluence(x, z, 40 / cellSize, -40);
	}
	else if (template.genericName() === "Rotary Mill" && ent.hasClass("Field"))
	{
		placement.addInfluence(x, z, 60 / cellSize, 40);
	}
	return false;
}

/** A farmstead goes away from the wood, and from the map border: we need space around it */
function awayFromWood(gameState: CommonGameState, placement: InfoMap<"territory">): void
{
	const borderMap = gameState.ai.geography.borderMap;
	for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
	{
		const j = cellIndex(placement, jIndex);
		let value = placement.map[j] - gameState.sharedScript.resourceMaps.wood.map[j] / 3;
		if (borderMap.map[j] & mapMask.fullBorder)
		{
			value /= 2; // we need space around farmstead, so disfavor map border
		}
		placement.set(j, value);
	}
}

/**
 * Defines a construction plan, ie a building.
 * We'll try to fing a good position if non has been provided
 */

/** Whether a territory cell belongs to the base named, or to any base of ours when none is */
function inBase(gameState: CommonGameState, cell: CellIndex<"territory">, base: BaseId | undefined): boolean
{
	const at = gameState.ai.bases.baseAtIndex(cell);
	return base !== undefined ? at === base : at !== 0;
}

export class ConstructionPlan extends QueuePlan<CommonStructureTemplate, "building">
{
	position: CommonPosition | 0;

	constructor(gameState: CommonGameState, type: string, metadata?: PlanMetadata, position?: CommonPosition | 0)
	{
		const name = gameState.applyCiv(type);
		// a building's template: the base refuses one that is not a structure's as one it cannot find
		const template = gameState.getTemplate(name);
		super(gameState, name, template && isStructureTemplate(template) ? template : null, "building", metadata);

		this.position = position ? position : 0;
	}

	canStart(gameState: CommonGameState): PlanStart | undefined
	{
		if (gameState.ai.town.turnCache.buildingBuilt)
		{ // do not start another building if already one this turn
			return undefined;
		}

		if (!this.isGo(gameState))
		{
			return undefined;
		}

		if (!this.template.available(gameState))
		{
			return undefined;
		}

		if (gameState.ai.build.hasBuilder(this.type) !== true)
		{
			return undefined;
		}
		// the spot is sought once paid: a building without room is dropped all the same
		return () => this.start(gameState);
	}

	/** Lays the foundation at the best spot found; with none, the plan is dropped and the building marked unbuildable a while. */

	start(gameState: CommonGameState): void
	{
		Engine.ProfileStart("Building construction start");
		const laid = this.layFoundation(gameState);
		Engine.ProfileStop();

		if (laid && this.metadata && this.metadata.proximity)
		{
			gameState.ai.naval.createTransportIfNeeded(
				gameState,
				this.metadata.proximity,
				worldPos(laid.pos.x, laid.pos.z),
				laid.access,
			);
		}
	}

	/** The foundation laid at the best spot: its spot and land, or undefined when it was not */
	private layFoundation(
		gameState: CommonGameState,
	): { pos: Exclude<BuildingPosition, false>; access: AccessIndex; } | undefined
	{
		// We don't care which builder we assign, since they won't actually do
		// the building themselves - all we care about is that there is at least
		// one unit that can start the foundation (should always be the case here).
		const builder = gameState.findBuilder(this.type);
		if (!builder)
		{
			aiWarn("petra error: builder not found when starting construction.");
			return undefined;
		}

		const pos = this.findGoodPosition(gameState);
		if (!pos)
		{
			gameState.ai.build.setUnbuildable(gameState, this.type, 90, "room");
			return undefined;
		}

		if (!this.stillWorthBuilding(gameState))
		{
			return undefined;
		}
		gameState.ai.town.markBuildingStarted();

		if (this.metadata === undefined)
		{
			this.metadata = { base: pos.base };
		}
		else if (this.metadata.base === undefined)
		{
			this.metadata.base = pos.base;
		}

		// needed for Docks whose position is on water
		const access = pos.access ? pos.access : gameState.ai.accessibility.getAccessValue(worldPos(pos.x, pos.z));
		this.metadata.access = access;

		if (this.template.buildPlacementType() === "shore")
		{
			constructOnShore(gameState, builder, this.type, pos, this.metadata);
		}
		else if (pos.xx === undefined || pos.x === pos.xx && pos.z === pos.zz)
		{
			builder.construct(this.type, pos.x, pos.z, pos.angle, this.metadata);
			// followed until it stands: a spot that fails is avoided (FINDINGS §39)
			if (this.template.hasClass("CivCentre"))
			{
				gameState.ai.town.noteCivCentreOrdered(gameState, worldPos(pos.x, pos.z));
			}
		}
		// try with the lowest, move towards us unless we're same
		else
		{
			for (let step = 0; step <= 1; step += 0.2)
			{
				builder.construct(
					this.type,
					step * pos.x + (1 - step) * (pos.xx ?? NaN),
					step * pos.z + (1 - step) * (pos.zz ?? NaN),
					pos.angle,
					this.metadata,
				);
			}
		}
		this.onStart(gameState);
		return { pos, access };
	}

	/** Check if this Market is still worth building (others may have been built making it useless). */
	private stillWorthBuilding(gameState: CommonGameState): boolean
	{
		if (
			!this.metadata || !this.metadata.expectedGain ||
			this.template.hasClass("Market") && !gameState.getOwnEntitiesByClass("Market", true).hasEntities()
		)
		{
			return true;
		}
		const tradeManager = gameState.ai.trade;
		tradeManager.checkRoutes(gameState);
		return tradeManager.isNewMarketWorth(this.metadata.expectedGain);
	}

	findGoodPosition(gameState: CommonGameState): BuildingPosition
	{
		const template = this.template;

		if (template.buildPlacementType() === "shore")
		{
			return findDockPosition(gameState, template, this.metadata);
		}

		if (template.hasClass("Storehouse") && this.metadata && this.metadata.base)
		{
			const storehouse = this.storehouseSpot(gameState, this.metadata.base);
			if (storehouse)
			{
				return storehouse;
			}
		}

		if (!this.position)
		{
			const special = this.specialPosition(gameState, template);
			if (special !== undefined)
			{
				return special;
			}
		}

		// Compute each tile's closeness to friendly structures, in our territory:
		const placement = new InfoMap(gameState.sharedScript, "territory");
		const alreadyHasHouses = this.placeInfluence(gameState, template, placement);
		this.restrictPlacement(gameState, template, placement);

		// Find the best non-obstructed:
		// Find target building's approximate obstruction radius, and expand by a bit to make sure we're not too close,
		// this allows room for units to walk between buildings.
		// note: not for houses and dropsites who ought to be closer to either each other or a resource.
		// also not for fields who can be stacked quite a bit

		const obstructions = createObstructionMap(gameState, NO_LAND, template);
		// obstructions.dumpIm(template.buildPlacementType() + "_obstructions.png");

		const radius = this.placementRadius(gameState, obstructions.cellSize);

		let bestTile;
		if (template.hasClass("House") && !alreadyHasHouses)
		{
			// try to get some space to place several houses first
			bestTile = placement.findBestTile(3 * radius, obstructions);
			if (!bestTile.val)
			{
				bestTile = undefined;
			}
		}

		if (!bestTile)
		{
			bestTile = placement.findBestTile(radius, obstructions);
		}

		if (!bestTile.val)
		{
			return false;
		}

		const bestIdx = requireValue(bestTile.idx);

		const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

		const territorypos = placement.gamePosToMapPos(worldPos(x, z));
		const territoryIndex = cellIndex(placement, territorypos[0] + territorypos[1] * placement.width);
		// default angle = 3*Math.PI/4;
		return { x: x, z: z, angle: 3 * Math.PI / 4, base: gameState.ai.bases.baseAtIndex(territoryIndex) };
	}

	/** recompute the best dropsite location in case some conditions have changed */
	private storehouseSpot(gameState: CommonGameState, baseId: BaseId): BuildingPosition | undefined
	{
		const base = requireValue(gameState.ai.bases.getBaseByID(baseId));
		const type = this.metadata && this.metadata.type ? this.metadata.type : "wood";
		const newpos = base.findBestDropsiteLocation(gameState, type, this.template.templateName());
		if (!newpos || !(newpos.quality > 0))
		{
			return undefined;
		}
		const pos = newpos.pos;
		return { x: pos[0], z: pos[1], angle: 3 * Math.PI / 4, base: baseId };
	}

	/**
	 * The room kept around the building, in cells: more for a fortress, an arsenal or an elephant stable,
	 * less for houses, dropsites, fields and markets
	 */
	private placementRadius(gameState: CommonGameState, cellSize: number): number
	{
		const template = this.template;
		const obstructionRadius = template.obstructionRadius();
		if (
			template.hasClasses(["Fortress", "Arsenal"]) ||
			this.type === gameState.applyCiv("structures/{civ}/elephant_stable")
		)
		{
			return Math.floor((obstructionRadius.max + 8) / cellSize);
		}
		if (template.resourceDropsiteTypes() === undefined && !template.hasClasses(["House", "Field", "Market"]))
		{
			return Math.ceil((obstructionRadius.max + 4) / cellSize);
		}
		return Math.ceil(obstructionRadius.max / cellSize);
	}

	/**
	 * The placement of a building with a rule of its own (a civic centre, a tower or
	 * fortress, a market): a position, false for none, or undefined to search as for any.
	 */
	specialPosition(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition | undefined
	{
		if (template.hasClass("CivCentre"))
		{
			return this.civCentreSpot(gameState, template);
		}
		else if (template.hasClasses(["Tower", "Fortress", "ArmyCamp"]))
		{
			const pos = gameState.ai.placement.findDefensiveLocation(gameState, template);
			if (pos)
			{
				return { x: pos[0], z: pos[1], angle: 3 * Math.PI / 4, base: pos[2] };
			}
			// if this fortress is our first one, just try the standard placement
			if (
				!template.hasClass("Fortress") || gameState.getOwnEntitiesByClass("Fortress", true).hasEntities() ||
				false
			)
			{
				return false;
			}
		}
		else if (template.hasClass("Market"))
		{ // Docks are done before.
			return this.marketSpot(gameState, template);
		}
		return undefined;
	}

	/** A civic centre where the plan wants it; with none, a dock in a not-enemy island is tried instead */
	private civCentreSpot(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition
	{
		let pos;
		if (this.metadata && this.metadata.room)
		{
			pos = gameState.ai.placement.findEconomicCCLocation(gameState, template, "wood", {
				fromStrategic: true,
				forRoom: true,
			});
		}
		else if (this.metadata && this.metadata.resource)
		{
			const proximity = this.metadata.proximity ? this.metadata.proximity : undefined;
			pos = gameState.ai.placement.findEconomicCCLocation(gameState, template, this.metadata.resource, {
				proximity,
			});
		}
		else
		{
			pos = gameState.ai.placement.findStrategicCCLocation(gameState, template);
		}

		if (pos)
		{
			return { x: pos[0], z: pos[1], angle: 3 * Math.PI / 4, base: NO_BASE };
		}
		// No possible location, try to build instead a dock in a not-enemy island
		const templateName = gameState.applyCiv("structures/{civ}/dock");
		if (gameState.ai.town.canBuild(gameState, templateName) && !gameState.isTemplateDisabled(templateName))
		{
			// canBuild() above already verified that the template exists; a dock is a structure
			const dockTemplate = requireTemplate(gameState, templateName);
			if (
				isStructureTemplate(dockTemplate) &&
				gameState.getResources().canAfford(new ResourcesManager(dockTemplate.cost()))
			)
			{
				buildOverseaDock(gameState, dockTemplate);
			}
		}
		return false;
	}

	/** A market in a base of its own, with the gain expected; undefined to search as for any, false for none */
	private marketSpot(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition | undefined
	{
		const pos = gameState.ai.placement.findMarketLocation(gameState, template);
		const base = pos ? pos[2] : -1;
		// a base of its own (not -1, nor a cell no base claims): there
		if (pos && base !== -1 && base !== NO_BASE)
		{
			if (!this.metadata)
			{
				this.metadata = {};
			}
			this.metadata.expectedGain = pos[3];
			return { x: pos[0], z: pos[1], angle: 3 * Math.PI / 4, base: base };
		}
		else if (!pos)
		{
			return false;
		}
		return undefined;
	}

	/** The placement map's values: near the position asked for, else by what the building wants near it. Whether houses already stand. */
	placeInfluence(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		placement: InfoMap<"territory">,
	): boolean
	{
		const HQ = gameState.ai.town;
		const cellSize = placement.cellSize;
		let alreadyHasHouses = false;

		if (this.position)
		{ // If a position was specified then place the building as close to it as possible
			const x = Math.floor(this.position[0] / cellSize);
			const z = Math.floor(this.position[1] / cellSize);
			placement.addInfluence(x, z, 255);
		}
		// No position was specified so try and find a sensible place to build
		else
		{
			// give a small > 0 level as the result of addInfluence is constrained to be > 0
			// if we really need houses (i.e. Phasing without enough village building), do not apply these constraints
			const base = this.metadata ? this.metadata.base : undefined;
			for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
			{
				const j = cellIndex(placement, jIndex);
				if (inBase(gameState, j, base))
				{
					placement.set(j, 45);
				}
			}

			if (!HQ.requireHouses || !template.hasClass("House"))
			{
				gameState.getOwnStructures().forEach((ent) =>
				{
					if (influenceOf(gameState, template, placement, ent))
					{
						alreadyHasHouses = true;
					}
				});
			}
			if (template.hasClass("Farmstead"))
			{
				awayFromWood(gameState, placement);
			}
		}

		return alreadyHasHouses;
	}

	/** The placement map kept to our territory, our base's when the plan names one, and away from invading armies. */
	restrictPlacement(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		placement: InfoMap<"territory">,
	): void
	{
		const HQ = gameState.ai.town;
		const cellSize = placement.cellSize;
		// Requires to be inside our territory, and inside our base territory if required
		// and if our first market, put it on border if possible to maximize distance with next Market.
		const favorBorder = template.hasClass("Market");
		const disfavorBorder = gameState.currentPhase() > 1 && !template.hasDefensiveFire();
		const favoredBase = this.metadata &&
			(this.metadata.favoredBase ||
				(this.metadata.militaryBase ? gameState.ai.placement.findBestBaseForMilitary(gameState) : undefined));
		const base = this.metadata ? this.metadata.base : undefined;
		for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
		{
			const j = cellIndex(placement, jIndex);
			if (!inBase(gameState, j, base))
			{
				placement.map[j] = 0;
				continue;
			}
			if (!(placement.map[j] > 0))
			{
				continue;
			}
			borderBonus(placement, j, gameState.ai.geography.borderMap.map[j], { favorBorder, disfavorBorder });

			const x = (j % placement.width + 0.5) * cellSize;
			const z = (Math.floor(j / placement.width) + 0.5) * cellSize;
			if (HQ.isNearInvadingArmy(worldPos(x, z)))
			{
				placement.map[j] = 0;
			}
			else if (base === undefined && favoredBase && gameState.ai.bases.baseAtIndex(j) === favoredBase)
			{
				placement.set(j, placement.map[j] + 100);
			}
		}
	}

	isGo(gameState: CommonGameState): boolean
	{
		if (this.goRequirement === "houseNeeded")
		{
			if (
				!gameState.ai.town.canBuild(gameState, "structures/{civ}/house") &&
				!gameState.ai.town.canBuild(gameState, "structures/{civ}/apartment")
			)
			{
				return false;
			}
			return gameState.ai.town.houseNeeded(gameState);
		}
		return true;
	}

	Serialize(): {
		category: "building";
		type: TemplateName;
		ID: number;
		metadata: PlanMetadata | undefined;
		cost: { amounts: Record<string, number>; population: number; };
		number: number;
		position: CommonPosition | 0;
		goRequirement: TechnologyRequirements | "houseNeeded" | undefined;
		queueToReset: PetraRuntime.ConfiguredQueueName | undefined;
	}
	{
		return {
			...this.serializeBase("building"),
			position: this.position,
			goRequirement: this.goRequirement || undefined,
			queueToReset: this.queueToReset || undefined,
		};
	}

	/** A saved plan: its id, metadata and cost from the save */
	static restore(gameState: CommonGameState, data: ReturnType<ConstructionPlan["Serialize"]>): ConstructionPlan
	{
		const plan = new ConstructionPlan(gameState, data.type);
		plan.resume(data);
		return plan;
	}

	private resume(data: ReturnType<ConstructionPlan["Serialize"]>): void
	{
		this.resumeBase(data);
		this.position = data.position;
		this.goRequirement = data.goRequirement;
		this.queueToReset = data.queueToReset;
	}
}
