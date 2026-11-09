/**
 * The map as the AI understands it (PLAN.md §3.4, world/): who owns which
 * ground (the territory map, read again from the engine every HQ update), the
 * border and frontier cells (the border map), the land and sea regions the
 * AI uses (found by analyseMap at the start of a game, kept in saves), and
 * where ships may land on each land from each sea (worked out again from the
 * passability maps on a load, as they do not change).
 *
 * A Geography is made whole: analyseMap for a new game, restoreGeography for a
 * saved one. The headquarters owns one and keeps its old property names for it
 * (HQ.territoryMap, HQ.landRegions, ...), so the managers, the save format and
 * the tests see the same fields as before.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import type { InfoMap } from "simulation/ai/common-api/map-module.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { landRegion, seaRegion } from "../adapter/brands.ts";
import { isPlaced } from "../adapter/placed.ts";
import { createBorderMap, createTerritoryMap, type TerritoryMap } from "./mapModule.ts";

/** The land and sea regions we use, and whether the map has a sea worth a navy. */
type MapRegions = { landRegions: Record<number, boolean>; navalRegions: Record<number, boolean>; navalMap: boolean; };

/** Where a ship may land on a land from a sea: the passability cells, by land, then by sea */
export type LandingZones = Record<number, Record<number, Set<number>>>;

export class Geography
{
	/** Who owns each territory cell, and whether it is blinking (cut off). Made again by each HQ update. */
	territoryMap: TerritoryMap;
	/** The map's border and our frontier, cell flags (mapMask.ts). */
	borderMap: InfoMap;
	/** The land regions we use. */
	landRegions: Record<number, boolean>;
	/** The sea regions we use. */
	navalRegions: Record<number, boolean>;
	/** Whether the map has a sea worth a navy. */
	navalMap: boolean;
	/** Where a ship may land on a land from a sea (findLandingZones). */
	readonly landingZones: Readonly<LandingZones>;

	constructor(territoryMap: TerritoryMap, borderMap: InfoMap, regions: MapRegions, landingZones: LandingZones)
	{
		this.territoryMap = territoryMap;
		this.borderMap = borderMap;
		this.landRegions = regions.landRegions;
		this.navalRegions = regions.navalRegions;
		this.navalMap = regions.navalMap;
		this.landingZones = landingZones;
	}
}

/** The map of a new game, analysed; undefined when the AI cannot make sense of it (it then does not play). */
export function analyseMap(gameState: CommonGameState, debug: number): Geography | undefined
{
	const territoryMap = createTerritoryMap(gameState);
	// flags the cells on the border of the map; updateTerritories adds our frontier
	const borderMap = createBorderMap(gameState);
	const regions = analyseRegions(gameState, debug);
	return regions && new Geography(territoryMap, borderMap, regions, findLandingZones(gameState));
}

/** The map of a saved game: its regions from the save, its maps and landing zones worked out again. */
export function restoreGeography(gameState: CommonGameState, regions: MapRegions): Geography
{
	return new Geography(
		createTerritoryMap(gameState),
		createBorderMap(gameState),
		regions,
		findLandingZones(gameState),
	);
}

/**
 * The possible landing zones: the shore cells of each land on each sea (a
 * cell of both a land region and a sea region), those with room around when
 * possible.
 */
export function findLandingZones(gameState: CommonGameState): LandingZones
{
	const landingZones: LandingZones = {};
	const width = gameState.getPassabilityMap().width;
	const length = width * gameState.getPassabilityMap().height;
	for (let i = 0; i < length; ++i)
	{
		const land = gameState.ai.accessibility.landPassMap[i];
		if (land < 2)
		{
			continue;
		}
		const naval = gameState.ai.accessibility.navalPassMap[i];
		if (naval < 2)
		{
			continue;
		}
		if (!landingZones[land])
		{
			landingZones[land] = {};
		}
		if (!landingZones[land][naval])
		{
			landingZones[land][naval] = new Set();
		}
		landingZones[land][naval].add(i);
	}
	// and keep only those with enough room around when possible
	for (const land in landingZones)
	{
		for (const sea in landingZones[land])
		{
			keepRoomyCells(landingZones[land][sea], width);
		}
	}
	return landingZones;
}

/** Keeps the cells of a landing zone with the most neighbours in it, up to 2 */
function keepRoomyCells(landing: Set<number>, width: number): void
{
	const nbaround: Record<number, number> = {};
	let nbcut = 0;
	for (const i of landing)
	{
		let nb = 0;
		if (landing.has(i - 1))
		{
			nb++;
		}
		if (landing.has(i + 1))
		{
			nb++;
		}
		if (landing.has(i + width))
		{
			nb++;
		}
		if (landing.has(i - width))
		{
			nb++;
		}
		nbaround[i] = nb;
		nbcut = Math.max(nb, nbcut);
	}
	nbcut = Math.min(2, nbcut);
	for (const i of landing)
	{
		if (nbaround[i] < nbcut)
		{
			landing.delete(i);
		}
	}
}

/** The sea between two land regions, when the shortest way from one to the other crosses exactly one. */
export function seaBetween(
	gameState: CommonGameState,
	index1: AccessIndex,
	index2: AccessIndex,
	debug: number,
): SeaIndex | undefined
{
	const path = gameState.ai.accessibility.getTrajectToIndex(index1, index2);
	if (path && path.length === 3 && gameState.ai.accessibility.regionType[path[1]] === "water")
	{
		return seaRegion(path[1]);
	}

	if (debug > 1)
	{
		aiWarn("bad path from " + index1 + " to " + index2 + " ??? " + uneval(path));
		aiWarn(" regionLinks start " + uneval(gameState.ai.accessibility.regionLinks[index1]));
		aiWarn(" regionLinks end   " + uneval(gameState.ai.accessibility.regionLinks[index2]));
	}
	return undefined;
}

/** The sizes a region must pass, in passability cells (cellArea: the area of one). */
type RegionSizes = { minLand: number; minWater: number; cellArea: number; };
/** Where we stand, the sizes and the debug level, as the regions are classed. */
type RegionAnalysis = {
	landIndex: AccessIndex | undefined;
	seaIndex: SeaIndex | undefined;
	sizes: RegionSizes;
	debug: number;
};

/** Where we stand: the land of a civic centre, else of a unit or trainer, else the sea one of them is on. */
function homeRegions(
	gameState: CommonGameState,
): { landIndex: AccessIndex | undefined; seaIndex: SeaIndex | undefined; }
{
	const accessibility = gameState.ai.accessibility;
	let landIndex;
	let seaIndex;
	const ccEnts = gameState.getOwnStructures().filter(filters.byClass("CivCentre"));
	for (const cc of ccEnts.values())
	{
		const land = accessibility.getAccessValue(cc.position());
		if (land > 1)
		{
			landIndex = land;
			break;
		}
	}
	if (!landIndex)
	{
		const civ = gameState.getPlayerCiv();
		for (const ent of gameState.getOwnEntities().values())
		{
			if (!isPlaced(ent) || !ent.hasClass("Unit") && !ent.trainableEntities(civ))
			{
				continue;
			}
			const land = accessibility.getAccessValue(ent.position());
			if (land > 1)
			{
				landIndex = land;
				break;
			}
			const sea = accessibility.getAccessValue(ent.position(), true);
			if (!seaIndex && sea > 1)
			{
				seaIndex = sea;
			}
		}
	}
	return { landIndex, seaIndex };
}

/**
 * The land regions we can use (ours, and the big ones a sea away) and the
 * seas worth sailing; undefined when we stand on no land and no sea.
 */
function analyseRegions(gameState: CommonGameState, debug: number): MapRegions | undefined
{
	const home = homeRegions(gameState);
	const { landIndex, seaIndex } = home;
	if (!landIndex && !seaIndex)
	{
		aiWarn("Petra error: it does not know how to interpret this map");
		return undefined;
	}

	const regions: MapRegions = { landRegions: {}, navalRegions: {}, navalMap: false };
	const accessibility = gameState.ai.accessibility;
	const passabilityMap = gameState.getPassabilityMap();
	const totalSize = passabilityMap.width * passabilityMap.width;
	const sizes: RegionSizes = {
		minLand: Math.floor(0.1 * totalSize),
		minWater: Math.floor(0.2 * totalSize),
		cellArea: passabilityMap.cellSize * passabilityMap.cellSize,
	};
	for (let i = 0; i < accessibility.regionSize.length; ++i)
	{
		if (landIndex && i === landIndex)
		{
			regions.landRegions[i] = true;
		}
		else if (accessibility.regionType[i] === "land" && sizes.cellArea * accessibility.regionSize[i] > 320)
		{
			addLandOverseas(gameState, regions, landRegion(i), { ...home, sizes, debug });
		}
		else if (accessibility.regionType[i] === "water" && accessibility.regionSize[i] > sizes.minWater)
		{
			regions.navalMap = true;
			regions.navalRegions[i] = true;
		}
		else if (accessibility.regionType[i] === "water" && sizes.cellArea * accessibility.regionSize[i] > 3600)
		{
			regions.navalRegions[i] = true;
		}
	}

	if (debug >= 3)
	{
		warnRegions(gameState, regions, sizes.cellArea);
	}
	return regions;
}

/**
 * Another land: ours, with the sea to it, when a sea joins it to our land and
 * either is big; or, standing on a sea, when the sea touches it.
 */
function addLandOverseas(
	gameState: CommonGameState,
	regions: MapRegions,
	land: AccessIndex,
	analysis: RegionAnalysis,
): void
{
	const { landIndex, seaIndex, sizes, debug } = analysis;
	const accessibility = gameState.ai.accessibility;
	if (landIndex)
	{
		const sea = seaBetween(gameState, landIndex, land, debug);
		if (sea && (accessibility.regionSize[land] > sizes.minLand || accessibility.regionSize[sea] > sizes.minWater))
		{
			regions.navalMap = true;
			regions.landRegions[land] = true;
			regions.navalRegions[sea] = true;
		}
		return;
	}
	if (seaIndex === undefined)
	{
		return;
	}
	const traject = accessibility.getTrajectToIndex(seaIndex, land);
	if (traject && traject.length === 2)
	{
		regions.navalMap = true;
		regions.landRegions[land] = true;
		regions.navalRegions[seaIndex] = true;
	}
}

function warnRegions(gameState: CommonGameState, regions: MapRegions, cellArea: number): void
{
	for (const region in regions.landRegions)
	{
		aiWarn(" >>> zone " + region + " taille " + cellArea * gameState.ai.accessibility.regionSize[region]);
	}
	aiWarn(" navalMap " + regions.navalMap);
	aiWarn(" landRegions " + uneval(regions.landRegions));
	aiWarn(" navalRegions " + uneval(regions.navalRegions));
}
