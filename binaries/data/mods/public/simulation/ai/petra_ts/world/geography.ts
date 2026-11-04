/**
 * The map as the AI understands it (PLAN.md §3.4, world/): who owns which
 * ground (the territory map, read again from the engine every HQ update), the
 * border and frontier cells (the border map), and the land and sea regions the
 * AI uses (found by analyseMap at the start of a game, kept in saves).
 *
 * A Geography is made whole: analyseMap for a new game, restoreGeography for a
 * saved one. The headquarters owns one and keeps its old property names for it
 * (HQ.territoryMap, HQ.landRegions, ...), so the managers, the save format and
 * the tests see the same fields as before.
 */
import type { InfoMap } from "simulation/ai/common-api/map-module.js";
import * as filters from "simulation/ai/common-api/filters.js";
import { aiWarn } from "simulation/ai/common-api/utils.js";
import { type TerritoryMap, createBorderMap, createTerritoryMap } from "./mapModule.ts";
import { landRegion, seaRegion } from "../adapter/brands.ts";

/** The land and sea regions we use, and whether the map has a sea worth a navy. */
export type MapRegions = {
	landRegions: Record<number, boolean>;
	navalRegions: Record<number, boolean>;
	navalMap: boolean;
};

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

	constructor(territoryMap: TerritoryMap, borderMap: InfoMap, regions: MapRegions)
	{
		this.territoryMap = territoryMap;
		this.borderMap = borderMap;
		this.landRegions = regions.landRegions;
		this.navalRegions = regions.navalRegions;
		this.navalMap = regions.navalMap;
	}
}

/** The map of a new game, analysed; undefined when the AI cannot make sense of it (it then does not play). */
export function analyseMap(gameState: CommonGameState, debug: number): Geography | undefined
{
	const territoryMap = createTerritoryMap(gameState);
	// flags the cells on the border of the map; updateTerritories adds our frontier
	const borderMap = createBorderMap(gameState);
	const regions = analyseRegions(gameState, debug);
	return regions && new Geography(territoryMap, borderMap, regions);
}

/** The map of a saved game: its regions from the save, its maps read again. */
export function restoreGeography(gameState: CommonGameState, regions: MapRegions): Geography
{
	return new Geography(createTerritoryMap(gameState), createBorderMap(gameState), regions);
}

/** The sea between two land regions, when the shortest way from one to the other crosses exactly one. */
export function seaBetween(gameState: CommonGameState, index1: AccessIndex, index2: AccessIndex, debug: number): SeaIndex | undefined
{
	const path = gameState.ai.accessibility.getTrajectToIndex(index1, index2);
	if (path && path.length === 3 && gameState.ai.accessibility.regionType[path[1]] === "water")
		return seaRegion(path[1]);

	if (debug > 1)
	{
		aiWarn("bad path from " + index1 + " to " + index2 + " ??? " + uneval(path));
		aiWarn(" regionLinks start " + uneval(gameState.ai.accessibility.regionLinks[index1]));
		aiWarn(" regionLinks end   " + uneval(gameState.ai.accessibility.regionLinks[index2]));
	}
	return undefined;
}

/**
 * The land regions we can use (ours, and the big ones a sea away) and the
 * seas worth sailing; undefined when we stand on no land and no sea.
 */
function analyseRegions(gameState: CommonGameState, debug: number): MapRegions | undefined
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
			if (!ent.position() || !ent.hasClass("Unit") && !ent.trainableEntities(civ))
				continue;
			const land = accessibility.getAccessValue(ent.position());
			if (land > 1)
			{
				landIndex = land;
				break;
			}
			const sea = accessibility.getAccessValue(ent.position(), true);
			if (!seaIndex && sea > 1)
				seaIndex = sea;
		}
	}
	if (!landIndex && !seaIndex)
	{
		aiWarn("Petra error: it does not know how to interpret this map");
		return undefined;
	}

	const regions: MapRegions = { "landRegions": {}, "navalRegions": {}, "navalMap": false };
	const passabilityMap = gameState.getPassabilityMap();
	const totalSize = passabilityMap.width * passabilityMap.width;
	const minLandSize = Math.floor(0.1*totalSize);
	const minWaterSize = Math.floor(0.2*totalSize);
	const cellArea = passabilityMap.cellSize * passabilityMap.cellSize;
	for (let i = 0; i < accessibility.regionSize.length; ++i)
	{
		if (landIndex && i === landIndex)
			regions.landRegions[i] = true;
		else if (accessibility.regionType[i] === "land" && cellArea*accessibility.regionSize[i] > 320)
		{
			if (landIndex)
			{
				const sea = seaBetween(gameState, landIndex, landRegion(i), debug);
				if (sea && (accessibility.regionSize[i] > minLandSize || accessibility.regionSize[sea] > minWaterSize))
				{
					regions.navalMap = true;
					regions.landRegions[i] = true;
					regions.navalRegions[sea] = true;
				}
			}
			else
			{
				if (seaIndex === undefined)
					continue;
				const traject = accessibility.getTrajectToIndex(seaIndex, landRegion(i));
				if (traject && traject.length === 2)
				{
					regions.navalMap = true;
					regions.landRegions[i] = true;
					regions.navalRegions[seaIndex] = true;
				}
			}
		}
		else if (accessibility.regionType[i] === "water" && accessibility.regionSize[i] > minWaterSize)
		{
			regions.navalMap = true;
			regions.navalRegions[i] = true;
		}
		else if (accessibility.regionType[i] === "water" && cellArea*accessibility.regionSize[i] > 3600)
			regions.navalRegions[i] = true;
	}

	if (debug < 3)
		return regions;
	for (const region in regions.landRegions)
	{
		aiWarn(" >>> zone " + region + " taille " +
			cellArea * gameState.ai.accessibility.regionSize[region]);
	}
	aiWarn(" navalMap " + regions.navalMap);
	aiWarn(" landRegions " + uneval(regions.landRegions));
	aiWarn(" navalRegions " + uneval(regions.navalRegions));
	return regions;
}
