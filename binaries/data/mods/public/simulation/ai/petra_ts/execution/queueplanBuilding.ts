import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { getBuiltEntity, getLandAccess, getSeaAccess, requireTemplate, requireValue } from "../adapter/entityExtend.ts";
import * as mapMask from "../world/mapMask.ts";
import { createObstructionMap } from "../world/mapModule.ts";
import { type PlanMetadata, type PlanStart, QueuePlan } from "./queueplan.ts";
import { NEW_ANCHORLESS_BASE, NO_BASE, NO_LAND, cellIndex, landRegion, worldPos } from "../adapter/brands.ts";
import { footprintHalves, isStructureTemplate } from "../adapter/templateData.ts";
import { hqOf } from "./hq.ts";
import { isPlaced } from "../adapter/placed.ts";

export type BuildingPosition = {
	x: number;
	z: number;
	angle: number;
	base: BaseId;
	access?: AccessIndex;
	xx?: number;
	zz?: number;
} | false;

/** res is a measure of the amount of resources around a dock, and MAX_RES the max value taken into account */
const MAX_RES = 10;
/** water is a measure of the water space around a dock, and MAX_WATER the max value checkDockPlacement returns */
const MAX_WATER = 16;

/** The best dock spot so far: its value (the lower the better), cells, angle, land and water */
type DockSpot = { val: number; idx: number; jdx: CellIndex<"territory">; angle: number; land: AccessIndex; water: number };

/** What the dock search reads, the same for every cell */
type DockSearch = {
	dockProximity: CommonPosition | undefined;
	obstructions: ReturnType<typeof createObstructionMap>;
	width: number;
	cellSize: number;
	wantedLand: Record<number, boolean> | undefined;
	wantedSea: SeaIndex | undefined;
	proxyAccess: number | null;
	oversea: boolean | null;
	dropsiteTypes: string[] | undefined;
	radius: number;
	halves: ReturnType<typeof footprintHalves>;
	ccEnts: CommonEntityCollection | null;
	docks: CommonEntityCollection<CommonPlacedEntity> | null;
	factor: number;
};

/** Not much farther to one of our cc than to enemy ones: whether the enemy's nearest is under half as far */
function overseaFromEnemy(gameState: CommonGameState, pos: CommonPosition, ccEnts: CommonEntityCollection): boolean
{
	let enemyDist;
	let ownDist;
	for (const cc of ccEnts.values())
	{
		const owner = cc.owner();
		if (owner !== PlayerID && !gameState.isPlayerEnemy(owner) || !isPlaced(cc))
			continue;
		const dist = SquareVectorDistance(pos, cc.position());
		if (owner === PlayerID && (!ownDist || dist < ownDist))
			ownDist = dist;
		if (gameState.isPlayerEnemy(owner) && (!enemyDist || dist < enemyDist))
			enemyDist = dist;
	}
	return !!ownDist && !!enemyDist && enemyDist < 0.5 * ownDist;
}

/** Whether land i is an oversea dock's: no dock of ours, no civic centre of ours or an enemy's, and a sea to one of ours */
function isOverseaLand(gameState: CommonGameState, i: AccessIndex, docks: CommonEntityCollection, ccEnts: CommonEntityCollection): boolean
{
	for (const dock of docks.values())
		if (getLandAccess(gameState, dock) === i)
			return false;
	let sea;
	for (const cc of ccEnts.values())
	{
		const ccAccess = getLandAccess(gameState, cc);
		if (ccAccess !== undefined && ccAccess !== i)
		{
			if (cc.owner() === PlayerID && !sea)
				sea = hqOf(gameState).getSeaBetweenIndices(gameState, ccAccess, i);
			continue;
		}
		// Docks on island where we have a cc are already done elsewhere
		if (cc.owner() === PlayerID || gameState.isPlayerEnemy(cc.owner()))
			return false;
	}
	return !!sea;
}

/** Whether a naval cell is on the wanted sea, or on any sea when none is wanted */
function isWantedSea(naval: number, wantedSea: SeaIndex | undefined): boolean
{
	return !(wantedSea && naval !== wantedSea || !wantedSea && naval < 2);
}

/** A market's cell on our border gains, and with the town phase another cell inside it, unless it shoots */
function borderBonus(placement: InfoMap<"territory">, j: CellIndex<"territory">, border: number,
	rule: { favorBorder: boolean | undefined; disfavorBorder: boolean }): void
{
	if (rule.favorBorder && border & mapMask.border)
		placement.set(j, placement.map[j] + 50);
	else if (rule.disfavorBorder && !(border & mapMask.fullBorder))
		placement.set(j, placement.map[j] + 10);
}

/** The accessibility cell at a game position, or undefined off the map */
function cellOnMap(accessibility: CommonGameState["ai"]["accessibility"], x: number, z: number): number | undefined
{
	const pos = accessibility.gamePosToMapPos(worldPos(x, z));
	if (pos[0] < 0 || pos[0] >= accessibility.width)
		return undefined;
	if (pos[1] < 0 || pos[1] >= accessibility.height)
		return undefined;
	return pos[0] + pos[1]*accessibility.width;
}

/** Whether a game position is on the map and on open water */
function onOpenWater(accessibility: CommonGameState["ai"]["accessibility"], x: number, z: number): boolean
{
	const j = cellOnMap(accessibility, x, z);
	return j !== undefined && !(accessibility.landPassMap[j] > 1 || accessibility.navalPassMap[j] < 2);
}

/** Adds row ky's resources within dxmax of ix to the sum, weighted by their distance */
function addRow(sum: { total: number; nbcell: number },
	row: { map: ArrayLike<number>; w: number; ix: number; size: number; weigh0: number }, ky: number, dxmax: number): void
{
	const { map, w, ix, size, weigh0 } = row;
	if (ky < 0 || ky >= w)
		return;
	for (let dx = -dxmax; dx <= dxmax; ++dx)
	{
		const kx = ix + dx;
		if (kx < 0 || kx >= w)
			continue;
		const ddx = dx > 0 ? dx : -dx;
		const weight = weigh0 * (dxmax - ddx) / size;
		sum.total += weight * map[kx + w * ky];
		sum.nbcell += weight;
	}
}

/** A dock laid at its spot, and at spots shifted a little along its angle in case that one fails */
function constructOnShore(gameState: CommonGameState, builder: CommonEntity, type: TemplateName,
	pos: Exclude<BuildingPosition, false>, metadata: PlanMetadata): void
{
	// adjust a bit the position if needed
	const cosa = Math.cos(pos.angle);
	const sina = Math.sin(pos.angle);
	const shiftMax = hqOf(gameState).geography.territoryMap.cellSize;
	for (let shift = 0; shift <= shiftMax; shift += 2)
	{
		builder.construct(type, pos.x-shift*sina, pos.z-shift*cosa, pos.angle, metadata);
		if (shift > 0)
			builder.construct(type, pos.x+shift*sina, pos.z+shift*cosa, pos.angle, metadata);
	}
}

/** What one of our structures adds to the placement map of a new building; returns whether it is a house near a house */
function influenceOf(gameState: CommonGameState, template: CommonStructureTemplate, placement: InfoMap<"territory">,
	ent: CommonStructureEntity): boolean
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
			placement.addInfluence(x, z, 80 / cellSize, 50);
		else // If this is not a field add a negative influence because we want to leave this area for fields
			placement.addInfluence(x, z, 80 / cellSize, -20);
	}
	else if (template.hasClass("House"))
	{
		if (ent.hasClass("House"))
		{
			placement.addInfluence(x, z, 60 / cellSize, 40);    // houses are close to other houses
			return true;
		}
		else if (ent.hasClasses(["Gate", "!Wall"]))
			placement.addInfluence(x, z, 60 / cellSize, -40);   // and further away from other stuffs
	}
	else if (template.hasClass("Farmstead") && !ent.hasClasses(["Field", "Corral"]) &&
		ent.hasClasses(["Gate", "!Wall"]))
		placement.addInfluence(x, z, 100 / cellSize, -25);       // move farmsteads away to make room (Wall test needed for iber)
	else if (template.hasClass("GarrisonFortress") && ent.hasClass("House"))
		placement.addInfluence(x, z, 120 / cellSize, -50);
	else if (template.hasClass("Military"))
		placement.addInfluence(x, z, 40 / cellSize, -40);
	else if (template.genericName() === "Rotary Mill" && ent.hasClass("Field"))
		placement.addInfluence(x, z, 60 / cellSize, 40);
	return false;
}

/** A farmstead goes away from the wood, and from the map border: we need space around it */
function awayFromWood(gameState: CommonGameState, placement: InfoMap<"territory">): void
{
	const borderMap = hqOf(gameState).geography.borderMap;
	for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
	{
		const j = cellIndex(placement, jIndex);
		let value = placement.map[j] - gameState.sharedScript.resourceMaps.wood.map[j]/3;
		if (borderMap.map[j] & mapMask.fullBorder)
			value /= 2;	// we need space around farmstead, so disfavor map border
		placement.set(j, value);
	}
}

/**
 * Defines a construction plan, ie a building.
 * We'll try to fing a good position if non has been provided
 */

export class ConstructionPlan extends QueuePlan<CommonStructureTemplate, "building">
{
	position: CommonPosition | 0;

	constructor(gameState: CommonGameState, type: string, metadata?: PlanMetadata,
		position?: CommonPosition | 0)
	{
		const name = gameState.applyCiv(type);
		// a building's template: the base refuses one that is not a structure's as one it cannot find
		const template = gameState.getTemplate(name);
		super(gameState, name, template && isStructureTemplate(template) ? template : null, "building", metadata);

		this.position = position ? position : 0;
	}

	canStart(gameState: CommonGameState): PlanStart | undefined
	{
		if (hqOf(gameState).turnCache.buildingBuilt)   // do not start another building if already one this turn
			return undefined;

		if (!this.isGo(gameState))
			return undefined;

		if (!this.template.available(gameState))
			return undefined;

		if (hqOf(gameState).buildManager.hasBuilder(this.type) !== true)
			return undefined;
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
			hqOf(gameState).navalManager.createTransportIfNeeded(gameState, this.metadata.proximity, worldPos(laid.pos.x, laid.pos.z),
				laid.access);
	}

	/** The foundation laid at the best spot: its spot and land, or undefined when it was not */
	private layFoundation(gameState: CommonGameState): { pos: Exclude<BuildingPosition, false>; access: AccessIndex } | undefined
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
			hqOf(gameState).buildManager.setUnbuildable(gameState, this.type, 90, "room");
			return undefined;
		}

		if (!this.stillWorthBuilding(gameState))
			return undefined;
		hqOf(gameState).markBuildingStarted();

		if (this.metadata === undefined)
			this.metadata = { "base": pos.base };
		else if (this.metadata.base === undefined)
			this.metadata.base = pos.base;

		// needed for Docks whose position is on water
		const access = pos.access ? pos.access : gameState.ai.accessibility.getAccessValue(worldPos(pos.x, pos.z));
		this.metadata.access = access;

		if (this.template.buildPlacementType() === "shore")
			constructOnShore(gameState, builder, this.type, pos, this.metadata);
		else if (pos.xx === undefined || pos.x === pos.xx && pos.z === pos.zz)
		{
			builder.construct(this.type, pos.x, pos.z, pos.angle, this.metadata);
			// followed until it stands: a spot that fails is avoided (FINDINGS §39)
			if (this.template.hasClass("CivCentre"))
				hqOf(gameState).noteCivCentreOrdered(gameState, worldPos(pos.x, pos.z));
		}
		else // try with the lowest, move towards us unless we're same
		{
			for (let step = 0; step <= 1; step += 0.2)
				builder.construct(this.type, step*pos.x + (1-step)*(pos.xx ?? NaN), step*pos.z + (1-step)*(pos.zz ?? NaN),
					pos.angle, this.metadata);
		}
		this.onStart(gameState);
		return { pos, access };
	}

	/** Check if this Market is still worth building (others may have been built making it useless). */
	private stillWorthBuilding(gameState: CommonGameState): boolean
	{
		if (!this.metadata || !this.metadata.expectedGain || this.template.hasClass("Market") &&
		    !gameState.getOwnEntitiesByClass("Market", true).hasEntities())
			return true;
		const tradeManager = hqOf(gameState).tradeManager;
		tradeManager.checkRoutes(gameState);
		return tradeManager.isNewMarketWorth(this.metadata.expectedGain);
	}

	findGoodPosition(gameState: CommonGameState): BuildingPosition
	{
		const template = this.template;

		if (template.buildPlacementType() === "shore")
			return this.findDockPosition(gameState);

		const HQ = hqOf(gameState);
		if (template.hasClass("Storehouse") && this.metadata && this.metadata.base)
		{
			const storehouse = this.storehouseSpot(gameState, this.metadata.base);
			if (storehouse)
				return storehouse;
		}

		if (!this.position)
		{
			const special = this.specialPosition(gameState, template);
			if (special !== undefined)
				return special;
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
			bestTile = placement.findBestTile(3*radius, obstructions);
			if (!bestTile.val)
				bestTile = undefined;
		}

		if (!bestTile)
			bestTile = placement.findBestTile(radius, obstructions);

		if (!bestTile.val)
			return false;

		const bestIdx = requireValue(bestTile.idx);

		const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

		const territorypos = placement.gamePosToMapPos(worldPos(x, z));
		const territoryIndex = cellIndex(placement, territorypos[0] + territorypos[1]*placement.width);
		// default angle = 3*Math.PI/4;
		return { "x": x, "z": z, "angle": 3*Math.PI/4, "base": HQ.baseAtIndex(territoryIndex) };
	}

	/** recompute the best dropsite location in case some conditions have changed */
	private storehouseSpot(gameState: CommonGameState, baseId: BaseId): BuildingPosition | undefined
	{
		const base = requireValue(hqOf(gameState).getBaseByID(baseId));
		const type = this.metadata && this.metadata.type ? this.metadata.type : "wood";
		const newpos = base.findBestDropsiteLocation(gameState, type, this.template.templateName());
		if (!newpos || !(newpos.quality > 0))
			return undefined;
		const pos = newpos.pos;
		return { "x": pos[0], "z": pos[1], "angle": 3*Math.PI/4, "base": baseId };
	}

	/**
	 * The room kept around the building, in cells: more for a fortress, an arsenal or an elephant stable,
	 * less for houses, dropsites, fields and markets
	 */
	private placementRadius(gameState: CommonGameState, cellSize: number): number
	{
		const template = this.template;
		const obstructionRadius = template.obstructionRadius();
		if (template.hasClasses(["Fortress", "Arsenal"]) ||
			this.type === gameState.applyCiv("structures/{civ}/elephant_stable"))
			return Math.floor((obstructionRadius.max + 8) / cellSize);
		if (template.resourceDropsiteTypes() === undefined && !template.hasClasses(["House", "Field", "Market"]))
			return Math.ceil((obstructionRadius.max + 4) / cellSize);
		return Math.ceil(obstructionRadius.max / cellSize);
	}

	/**
	 * The placement of a building with a rule of its own (a civic centre, a tower or
	 * fortress, a market): a position, false for none, or undefined to search as for any.
	 */
	specialPosition(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition | undefined
	{
		const HQ = hqOf(gameState);
		if (template.hasClass("CivCentre"))
			return this.civCentreSpot(gameState, template);
		else if (template.hasClasses(["Tower", "Fortress", "ArmyCamp"]))
		{
			const pos = HQ.findDefensiveLocation(gameState, template);
			if (pos)
				return { "x": pos[0], "z": pos[1], "angle": 3*Math.PI/4, "base": pos[2] };
			// if this fortress is our first one, just try the standard placement
			if (!template.hasClass("Fortress") || gameState.getOwnEntitiesByClass("Fortress", true).hasEntities() || false)
				return false;
		}
		else if (template.hasClass("Market")) // Docks are done before.
			return this.marketSpot(gameState, template);
		return undefined;
	}

	/** A civic centre where the plan wants it; with none, a dock in a not-enemy island is tried instead */
	private civCentreSpot(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition
	{
		const HQ = hqOf(gameState);
		let pos;
		if (this.metadata && this.metadata.room)
			pos = HQ.findEconomicCCLocation(gameState, template, "wood", { "fromStrategic": true, "forRoom": true });
		else if (this.metadata && this.metadata.resource)
		{
			const proximity = this.metadata.proximity ? this.metadata.proximity : undefined;
			pos = HQ.findEconomicCCLocation(gameState, template, this.metadata.resource, { proximity });
		}
		else
			pos = HQ.findStrategicCCLocation(gameState, template);

		if (pos)
			return { "x": pos[0], "z": pos[1], "angle": 3*Math.PI/4, "base": NO_BASE };
		// No possible location, try to build instead a dock in a not-enemy island
		const templateName = gameState.applyCiv("structures/{civ}/dock");
		if (hqOf(gameState).canBuild(gameState, templateName) && !gameState.isTemplateDisabled(templateName))
		{
			// canBuild() above already verified that the template exists; a dock is a structure
			const dockTemplate = requireTemplate(gameState, templateName);
			if (isStructureTemplate(dockTemplate) && gameState.getResources().canAfford(
				new ResourcesManager(dockTemplate.cost())))
			{
				this.buildOverseaDock(gameState, dockTemplate);
			}
		}
		return false;
	}

	/** A market in a base of its own, with the gain expected; undefined to search as for any, false for none */
	private marketSpot(gameState: CommonGameState, template: CommonStructureTemplate): BuildingPosition | undefined
	{
		const pos = hqOf(gameState).findMarketLocation(gameState, template);
		const base = pos ? pos[2] : -1;
		// a base of its own (not -1, nor a cell no base claims): there
		if (pos && base !== -1 && base !== NO_BASE)
		{
			if (!this.metadata)
				this.metadata = {};
			this.metadata.expectedGain = pos[3];
			return { "x": pos[0], "z": pos[1], "angle": 3*Math.PI/4, "base": base };
		}
		else if (!pos)
			return false;
		return undefined;
	}

	/** The placement map's values: near the position asked for, else by what the building wants near it. Whether houses already stand. */
	placeInfluence(gameState: CommonGameState, template: CommonStructureTemplate, placement: InfoMap<"territory">): boolean
	{
		const HQ = hqOf(gameState);
		const cellSize = placement.cellSize;
		let alreadyHasHouses = false;

		if (this.position)	// If a position was specified then place the building as close to it as possible
		{
			const x = Math.floor(this.position[0] / cellSize);
			const z = Math.floor(this.position[1] / cellSize);
			placement.addInfluence(x, z, 255);
		}
		else	// No position was specified so try and find a sensible place to build
		{
			// give a small > 0 level as the result of addInfluence is constrained to be > 0
			// if we really need houses (i.e. Phasing without enough village building), do not apply these constraints
			const base = this.metadata ? this.metadata.base : undefined;
			for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
			{
				const j = cellIndex(placement, jIndex);
				if (base !== undefined ? HQ.baseAtIndex(j) === base : HQ.baseAtIndex(j) !== 0)
					placement.set(j, 45);
			}

			if (!HQ.requireHouses || !template.hasClass("House"))
			{
				gameState.getOwnStructures().forEach((ent) =>
				{
					if (influenceOf(gameState, template, placement, ent))
						alreadyHasHouses = true;
				});
			}
			if (template.hasClass("Farmstead"))
				awayFromWood(gameState, placement);
		}

		return alreadyHasHouses;
	}

	/** The placement map kept to our territory, our base's when the plan names one, and away from invading armies. */
	restrictPlacement(gameState: CommonGameState, template: CommonStructureTemplate, placement: InfoMap<"territory">): void
	{
		const HQ = hqOf(gameState);
		const cellSize = placement.cellSize;
		// Requires to be inside our territory, and inside our base territory if required
		// and if our first market, put it on border if possible to maximize distance with next Market.
		const favorBorder = template.hasClass("Market");
		const disfavorBorder = gameState.currentPhase() > 1 && !template.hasDefensiveFire();
		const favoredBase = this.metadata && (this.metadata.favoredBase ||
				   (this.metadata.militaryBase ? HQ.findBestBaseForMilitary(gameState) : undefined));
		const base = this.metadata ? this.metadata.base : undefined;
		for (let jIndex = 0; jIndex < placement.map.length; ++jIndex)
		{
			const j = cellIndex(placement, jIndex);
			if (base !== undefined ? HQ.baseAtIndex(j) !== base : HQ.baseAtIndex(j) === 0)
			{
				placement.map[j] = 0;
				continue;
			}
			if (!(placement.map[j] > 0))
				continue;
			borderBonus(placement, j, HQ.geography.borderMap.map[j], { favorBorder, disfavorBorder });

			const x = (j % placement.width + 0.5) * cellSize;
			const z = (Math.floor(j / placement.width) + 0.5) * cellSize;
			if (HQ.isNearInvadingArmy(worldPos(x, z)))
				placement.map[j] = 0;
			else if (base === undefined && favoredBase && HQ.baseAtIndex(j) === favoredBase)
				placement.set(j, placement.map[j] + 100);
		}
	}

	/**
	 * Placement of buildings with Dock build category
	 * metadata.proximity is defined when first dock without any territory
	 * => we try to minimize distance from our current point
	 * metadata.oversea is defined for dock in oversea islands
	 * => we try to maximize distance to our current docks (for trade)
	 * otherwise standard dock on an island where we already have a cc
	 * => we try not to be too far from our territory
	 * In all cases, we add a bonus for nearby resources, and when a large extend of water in front ot it.
	 */
	findDockPosition(gameState: CommonGameState): BuildingPosition
	{
		const search = this.dockSearch(gameState);
		const territoryMap = hqOf(gameState).geography.territoryMap;
		let best: DockSpot | undefined;
		for (let jIndex = 0; jIndex < territoryMap.length; ++jIndex)
		{
			const spot = this.dockSpotAt(gameState, search, cellIndex(territoryMap, jIndex), best);
			if (spot)
				best = spot;
		}
		if (!best || best.val < 0)
			return false;

		// if no good place with enough water around and still in first phase, wait for expansion at the next phase
		if (!search.dockProximity && best.water < 10 && gameState.currentPhase() === 1)
			return false;

		const obstructions = search.obstructions;
		const x = (best.idx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(best.idx / obstructions.width) + 0.5) * obstructions.cellSize;

		// Assign this dock to a base
		let baseIndex = hqOf(gameState).baseAtIndex(best.jdx);
		if (!baseIndex)
			baseIndex = NEW_ANCHORLESS_BASE;	// We'll do an anchorless base around it

		return { "x": x, "z": z, "angle": best.angle, "base": baseIndex, "access": best.land };
	}

	/** What the dock search reads, the same for every cell */
	private dockSearch(gameState: CommonGameState): DockSearch
	{
		const template = this.template;
		const obstructions = createObstructionMap(gameState, NO_LAND, template);
		// obstructions.dumpIm(template.buildPlacementType() + "_obstructions.png");
		const nbShips = hqOf(gameState).navalManager.transportShips.length;
		const metadata: PlanMetadata = this.metadata ?? {};
		let wantedLand = metadata.land ? metadata.land : undefined;
		const wantedSea = metadata.sea ? metadata.sea : undefined;
		const proxyAccess = metadata.proximity ? gameState.ai.accessibility.getAccessValue(metadata.proximity) : null;
		const oversea = metadata.oversea ? metadata.oversea : null;
		if (nbShips === 0 && proxyAccess && proxyAccess > 1)
		{
			wantedLand = {};
			wantedLand[proxyAccess] = true;
		}
		return {
			"dockProximity": metadata.proximity,
			obstructions,
			"width": hqOf(gameState).geography.territoryMap.width,
			"cellSize": hqOf(gameState).geography.territoryMap.cellSize,
			wantedLand,
			wantedSea,
			proxyAccess,
			oversea,
			"dropsiteTypes": template.resourceDropsiteTypes(),
			"radius": Math.ceil(template.obstructionRadius().max / obstructions.cellSize),
			// halfSize for the dock angle, halfDepth and halfWidth for checkPlacement
			"halves": footprintHalves(template),
			"ccEnts": oversea ? gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")) : null,
			"docks": oversea ? gameState.getOwnStructures().filter(filters.byClass("Dock")) : null,
			// Normalisation factors (only guessed, no attempt to optimize them)
			"factor": proxyAccess ? 1 : oversea ? 0.2 : 40
		};
	}

	/** The dock spot at cell j if it is one and beats best (the lower the better), else undefined */
	private dockSpotAt(gameState: CommonGameState, search: DockSearch, j: CellIndex<"territory">, best: DockSpot | undefined):
		DockSpot | undefined
	{
		if (!this.isDockLocation(gameState, j, search.halves.halfDepth, search.wantedLand, search.wantedSea))
			return undefined;
		let score = 0;
		if (!search.proxyAccess && !search.oversea)
		{
			// if not in our (or allied) territory, we do not want it too far to be able to defend it
			score = this.getFrontierProximity(gameState, j);
			if (score > 4)
				return undefined;
			score *= search.factor;
		}
		const territoryMap = hqOf(gameState).geography.territoryMap;
		const i = territoryMap.getNonObstructedTile(j, search.radius, search.obstructions);
		if (i < 0)
			return undefined;
		const navalPassMap = gameState.ai.accessibility.navalPassMap;
		if (search.wantedSea && navalPassMap[i] !== search.wantedSea)
			return undefined;

		const pos: CommonPosition = worldPos(search.cellSize * (j%search.width+0.5), search.cellSize * (Math.floor(j/search.width)+0.5));
		const scored = this.dockCellScore(gameState, search, { j, i, pos }, score);
		if (scored === undefined)
			return undefined;
		return this.placeDock(gameState, search, { j, i, pos }, scored, best);
	}

	/** The dock spot at a cell scored so: if it beats best with the water there, has a shore angle and room, and is safe */
	private placeDock(gameState: CommonGameState, search: DockSearch, cell: { j: CellIndex<"territory">; i: number; pos: CommonPosition },
		score: number, best: DockSpot | undefined): DockSpot | undefined
	{
		const { j, i, pos } = cell;
		const { halfSize, halfDepth, halfWidth } = search.halves;
		// Do a pre-selection, supposing we will have the best possible water
		if (best !== undefined && score > best.val + 5 * MAX_WATER)
			return undefined;

		const obstructions = search.obstructions;
		const x = (i % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(i / obstructions.width) + 0.5) * obstructions.cellSize;
		const angle = this.getDockAngle(gameState, x, z, halfSize);
		// as the original's `angle == false`: an angle of exactly 0 counts as none (FINDINGS §4)
		if (angle === false || angle === 0)
			return undefined;
		const ret = this.checkDockPlacement(gameState, { x, z, angle }, { halfDepth, halfWidth });
		if (!ret || !hqOf(gameState).geography.landRegions[ret.land] || search.wantedLand && !search.wantedLand[ret.land])
			return undefined;
		// Final selection now that the checkDockPlacement water is known
		if (best !== undefined && score + 5 * (MAX_WATER - ret.water) > best.val)
			return undefined;
		if (search.dockProximity && gameState.ai.accessibility.regionSize[ret.land] < 4000)
			return undefined;
		if (hqOf(gameState).isDangerousLocation(gameState, pos, halfSize))
			return undefined;

		return { "val": score + MAX_WATER - ret.water, "idx": i, "jdx": j, angle, "land": ret.land, "water": ret.water };
	}

	/**
	 * A dock cell's score from the frontier's: plus the distance to the proximity point when given, a bonus for
	 * resources, the oversea score (undefined when not oversea material) and a penalty on the map border
	 */
	private dockCellScore(gameState: CommonGameState, search: DockSearch, cell: { j: number; i: number; pos: CommonPosition },
		score: number): number | undefined
	{
		const res = search.dropsiteTypes ?
			Math.min(MAX_RES, this.getResourcesAround(gameState, search.dropsiteTypes, cell.j, 80)) : MAX_RES;

		// If proximity is given, we look for the nearest point
		if (search.proxyAccess && search.dockProximity)
			score = VectorDistance(search.dockProximity, cell.pos);

		// Bonus for resources
		score += 20 * (MAX_RES - res);

		if (search.oversea)
		{
			const overseaScore = this.overseaDockScore(gameState, cell.pos, gameState.ai.accessibility.navalPassMap[cell.i], search);
			if (overseaScore === undefined)
				return undefined;
			score += overseaScore;
		}

		// Add a penalty if on the map border as ship movement will be difficult
		if (hqOf(gameState).geography.borderMap.map[cell.j] & mapMask.fullBorder)
			score += 20;
		return score;
	}

	/**
	 * An oversea dock's spot: not much farther from our civic centres than from the enemy's (else undefined),
	 * and far from our docks on its sea, for trade: its added score
	 */
	overseaDockScore(gameState: CommonGameState, pos: CommonPosition, sea: number,
		search: Pick<DockSearch, "ccEnts" | "docks" | "width" | "cellSize" | "factor">): number | undefined
	{
		const { ccEnts, docks, width, cellSize, factor } = search;
		if (ccEnts && overseaFromEnemy(gameState, pos, ccEnts))
			return undefined;

		// And maximize distance for trade.
		let dockDist = 0;
		if (docks)
			for (const dock of docks.values())
			{
				if (getSeaAccess(gameState, dock) !== sea)
					continue;
				const dist = SquareVectorDistance(pos, dock.position());
				if (dist > dockDist)
					dockDist = dist;
			}
		if (dockDist > 0)
		{
			dockDist = Math.sqrt(dockDist);
			if (dockDist > width * cellSize) // Could happen only on square maps, but anyway we don't want to be too far away
				return undefined;
			return factor * (width * cellSize - dockDist);
		}
		return 0;
	}

	/**
	 * Find a good island to build a dock.
	 */
	buildOverseaDock(gameState: CommonGameState, template: CommonStructureTemplate): void
	{
		const docks = gameState.getOwnStructures().filter(filters.byClass("Dock"));
		if (!docks.hasEntities())
			return;

		const passabilityMap = gameState.getPassabilityMap();
		const cellArea = passabilityMap.cellSize * passabilityMap.cellSize;
		const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));

		const land: Record<number, boolean> = {};
		let found;
		for (let i = 0; i < gameState.ai.accessibility.regionSize.length; ++i)
		{
			if (gameState.ai.accessibility.regionType[i] !== "land" ||
			    cellArea * gameState.ai.accessibility.regionSize[i] < 3600)
				continue;
			if (!isOverseaLand(gameState, landRegion(i), docks, ccEnts))
				continue;
			land[i] = true;
			found = true;
		}
		if (!found)
			return;
		if (!hqOf(gameState).geography.navalMap)
			aiWarn("petra.findOverseaLand on a non-naval map??? we should never go there ");

		const oldTemplate = this.template;
		const oldMetadata = this.metadata;
		this.template = template;
		this.metadata = { "land": land, "oversea": true };
		const pos = this.findDockPosition(gameState);
		const type = template.templateName();
		// the builder registry may still list a builder whose last unit died this turn
		const builder = pos ? gameState.findBuilder(type) : undefined;
		if (pos && builder)
		{
			this.metadata.base = pos.base;
			constructOnShore(gameState, builder, type, pos, this.metadata);
		}
		this.template = oldTemplate;
		this.metadata = oldMetadata;
	}

	/** Algorithm taken from the function GetDockAngle in simulation/helpers/Commands.js */
	getDockAngle(gameState: CommonGameState, x: number, z: number, size: number): number | false
	{
		let pos = gameState.ai.accessibility.gamePosToMapPos(worldPos(x, z));
		const k = pos[0] + pos[1]*gameState.ai.accessibility.width;
		const seaRef = gameState.ai.accessibility.navalPassMap[k];
		if (seaRef < 2)
			return false;
		const numPoints = 16;
		for (let dist = 0; dist < 4; ++dist)
		{
			const waterPoints = [];
			for (let i = 0; i < numPoints; ++i)
			{
				const angle = 2 * Math.PI * i / numPoints;
				pos = gameState.ai.accessibility.gamePosToMapPos(
					worldPos(x - (1+dist)*size*Math.sin(angle), z + (1+dist)*size*Math.cos(angle)));
				if (pos[0] < 0 || pos[0] >= gameState.ai.accessibility.width ||
				    pos[1] < 0 || pos[1] >= gameState.ai.accessibility.height)
					continue;
				const j = pos[0] + pos[1]*gameState.ai.accessibility.width;
				if (gameState.ai.accessibility.navalPassMap[j] === seaRef)
					waterPoints.push(i);
			}
			const length = waterPoints.length;
			if (!length)
				continue;
			const consec = [];
			for (let i = 0; i < length; ++i)
			{
				let count = 0;
				for (let j = 0; j < length-1; ++j)
				{
					if ((waterPoints[(i + j) % length]+1) % numPoints === waterPoints[(i + j + 1) % length])
						++count;
					else
						break;
				}
				consec[i] = count;
			}
			let start = 0;
			let count = 0;
			consec.forEach((run, c) =>
			{
				// a sparse array: forEach, as for...in did, visits only the runs set
				if (run > count)
				{
					start = c;
					count = run;
				}
			});

			// If we've found a shoreline, stop searching
			if (count !== numPoints-1)
				return -((waterPoints[start] + consec[start]/2) % numPoints)/numPoints*2*Math.PI;
		}
		return false;
	}

	/**
	 * Algorithm taken from checkPlacement in simulation/components/BuildRestriction.js
	 * to determine the special dock requirements
	 * returns {"land": land index for this dock, "water": amount of water around this spot}
	 */
	checkDockPlacement(gameState: CommonGameState, spot: { x: number; z: number; angle: number },
		half: { halfDepth: number; halfWidth: number }): { land: AccessIndex; water: number } | undefined
	{
		const { x, z, angle } = spot;
		const accessibility = gameState.ai.accessibility;
		const sz = half.halfDepth * Math.sin(angle);
		const cz = half.halfDepth * Math.cos(angle);
		// center back position
		let pos = accessibility.gamePosToMapPos(worldPos(x - sz, z - cz));
		let j = pos[0] + pos[1]*accessibility.width;
		const land = accessibility.landPassMap[j];
		if (land < 2)
			return undefined;
		// center front position
		pos = accessibility.gamePosToMapPos(worldPos(x + sz, z + cz));
		j = pos[0] + pos[1]*accessibility.width;
		if (accessibility.landPassMap[j] > 1 || accessibility.navalPassMap[j] < 2)
			return undefined;
		// additional constraints compared to BuildRestriction.js to assure we have enough place to build
		const sw = half.halfWidth * Math.cos(angle) * 3 / 4;
		const cw = half.halfWidth * Math.sin(angle) * 3 / 4;
		pos = accessibility.gamePosToMapPos(worldPos(x - sz + sw, z - cz - cw));
		j = pos[0] + pos[1]*accessibility.width;
		if (accessibility.landPassMap[j] !== land)
			return undefined;
		pos = accessibility.gamePosToMapPos(worldPos(x - sz - sw, z - cz + cw));
		j = pos[0] + pos[1]*accessibility.width;
		if (accessibility.landPassMap[j] !== land)
			return undefined;
		let water = 0;
		const sp = 15 * Math.sin(angle);
		const cp = 15 * Math.cos(angle);
		for (let i = 1; i < 5; ++i)
		{
			if (!onOpenWater(accessibility, x + sz + i*(sp+sw), z + cz + i*(cp-cw)) ||
			    !onOpenWater(accessibility, x + sz + i*sp, z + cz + i*cp) ||
			    !onOpenWater(accessibility, x + sz + i*(sp-sw), z + cz + i*(cp+cw)))
				break;
			water += 4;
		}
		return { "land": land, "water": water };
	}

	/**
	 * fast check if we can build a dock: returns false if nearest land is farther than the dock dimension
	 * if the (object) wantedLand is given, this nearest land should have one of these accessibility
	 * if wantedSea is given, this tile should be inside this sea
	 */
	static around = [[ 1.0, 0.0], [ 0.87, 0.50], [ 0.50, 0.87], [ 0.0, 1.0], [-0.50, 0.87], [-0.87, 0.50],
		[-1.0, 0.0], [-0.87, -0.50], [-0.50, -0.87], [ 0.0, -1.0], [ 0.50, -0.87], [ 0.87, -0.50]];

	isDockLocation(gameState: CommonGameState, j: number, dimension: number,
		wantedLand: Record<number, boolean> | undefined, wantedSea: SeaIndex | undefined): boolean
	{
		const width = hqOf(gameState).geography.territoryMap.width;
		const cellSize = hqOf(gameState).geography.territoryMap.cellSize;
		const dimLand = dimension + 1.5 * cellSize;
		const dimSea = dimension + 2 * cellSize;

		const accessibility = gameState.ai.accessibility;
		const x = (j%width + 0.5) * cellSize;
		const z = (Math.floor(j/width) + 0.5) * cellSize;
		const pos = accessibility.gamePosToMapPos(worldPos(x, z));
		const k = pos[0] + pos[1]*accessibility.width;
		let landPass = accessibility.landPassMap[k];
		if (landPass > 1 && wantedLand && !wantedLand[landPass] ||
		    landPass < 2 && accessibility.navalPassMap[k] < 2)
			return false;

		for (const a of ConstructionPlan.around)
		{
			const landCell = cellOnMap(accessibility, x + dimLand*a[0], z + dimLand*a[1]);
			if (landCell === undefined)
				continue;
			landPass = accessibility.landPassMap[landCell];
			if (landPass < 2 || wantedLand && !wantedLand[landPass])
				continue;
			const seaCell = cellOnMap(accessibility, x - dimSea*a[0], z - dimSea*a[1]);
			if (seaCell !== undefined && isWantedSea(accessibility.navalPassMap[seaCell], wantedSea))
				return true;
		}

		return false;
	}

	/**
	 * return a measure of the proximity to our frontier (including our allies)
	 * 0=inside, 1=less than 24m, 2= less than 48m, 3= less than 72m, 4=less than 96m, 5=above 96m
	 */
	getFrontierProximity(gameState: CommonGameState, j: CellIndex<"territory">): number
	{
		const alliedVictory = gameState.getAlliedVictory();
		const territoryMap = hqOf(gameState).geography.territoryMap;
		let territoryOwner = territoryMap.getOwnerIndex(j);
		if (territoryOwner === PlayerID || alliedVictory && gameState.isPlayerAlly(territoryOwner))
			return 0;

		const borderMap = hqOf(gameState).geography.borderMap;
		const width = territoryMap.width;
		const step = Math.round(24 / territoryMap.cellSize);
		const ix = j % width;
		const iz = Math.floor(j / width);
		let best = 5;
		for (const a of ConstructionPlan.around)
		{
			for (let i = 1; i < 5; ++i)
			{
				const jx = ix + Math.round(i*step*a[0]);
				if (jx < 0 || jx >= width)
					continue;
				const jz = iz + Math.round(i*step*a[1]);
				if (jz < 0 || jz >= width)
					continue;
				if (borderMap.map[jx+width*jz] & mapMask.outside)
					continue;
				territoryOwner = territoryMap.getOwnerIndex(cellIndex(territoryMap, jx+width*jz));
				if (alliedVictory && gameState.isPlayerAlly(territoryOwner) || territoryOwner === PlayerID)
				{
					best = Math.min(best, i);
					break;
				}
			}
			if (best === 1)
				break;
		}

		return best;
	}

	/**
	 * get the sum of the resources (except food) around, inside a given radius
	 * resources have a weight (1 if dist=0 and 0 if dist=size) doubled for wood
	 */
	getResourcesAround(gameState: CommonGameState, types: string[], i: number, radius: number): number
	{
		const resourceMaps = gameState.sharedScript.resourceMaps;
		const w = resourceMaps.wood.width;
		const cellSize = resourceMaps.wood.cellSize;
		const size = Math.floor(radius / cellSize);
		const ix = i % w;
		const iy = Math.floor(i / w);
		const sum = { "total": 0, "nbcell": 0 };
		for (const k of types)
		{
			if (k === "food" || !resourceMaps[k])
				continue;
			const row = { "map": resourceMaps[k].map, w, ix, size, "weigh0": k === "wood" ? 2 : 1 };
			for (let dy = 0; dy <= size; ++dy)
			{
				addRow(sum, row, iy + dy, size - dy);
				if (dy !== 0)
					addRow(sum, row, iy - dy, size - dy);
			}
		}
		return sum.nbcell ? sum.total / sum.nbcell : 0;
	}

	isGo(gameState: CommonGameState): boolean
	{
		if (this.goRequirement === "houseNeeded")
		{
			if (!hqOf(gameState).canBuild(gameState, "structures/{civ}/house") &&
			    !hqOf(gameState).canBuild(gameState, "structures/{civ}/apartment"))
				return false;
			return hqOf(gameState).houseNeeded(gameState);
		}
		return true;
	}

	onStart(gameState: CommonGameState): void
	{
		if (this.queueToReset)
			gameState.ai.queueManager.changePriority(this.queueToReset, gameState.ai.Config.priorities[this.queueToReset]);
	}

	Serialize(): {
		category: "building";
		type: TemplateName;
		ID: number;
		metadata: PlanMetadata | undefined;
		cost: { amounts: Record<string, number>; population: number };
		number: number;
		position: CommonPosition | 0;
		goRequirement: TechnologyRequirements | "houseNeeded" | undefined;
		queueToReset: PetraRuntime.ConfiguredQueueName | undefined;
	}
	{
		return {
			"category": "building",
			"type": this.type,
			"ID": this.ID,
			"metadata": this.metadata,
			"cost": this.cost.Serialize(),
			"number": this.number,
			"position": this.position,
			"goRequirement": this.goRequirement || undefined,
			"queueToReset": this.queueToReset || undefined
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
		this.type = data.type;
		this.ID = data.ID;
		this.metadata = data.metadata;
		this.number = data.number;
		this.position = data.position;
		this.goRequirement = data.goRequirement;
		this.queueToReset = data.queueToReset;

		this.cost = new ResourcesManager();
		this.cost.Deserialize(data.cost);
	}
}
