import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { getMapIndices } from "simulation/ai/common-api/utils.js";
import { cellIndex, playerId } from "../adapter/brands.ts";
import { debugShade } from "../adapter/commands.ts";
import { requireValue } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import * as mapMask from "./mapMask.ts";

/** map functions */

const TERRITORY_PLAYER_MASK = 0x1F;
const TERRITORY_BLINKING_MASK = 0x40;

/** Where a template may be built: its placement and the territories it allows (the defaults with none). */
type BuildRules = { placementType: string; own: boolean; ally: boolean; neutral: boolean; enemy: boolean; };

function buildRules(template: CommonTemplate | undefined): BuildRules
{
	if (!template)
	{
		return { placementType: "land", own: true, ally: true, neutral: true, enemy: false };
	}
	// as in the original: a template without BuildRestrictions answers
	// undefined, which allows no territory at all
	return {
		placementType: template.buildPlacementType() ?? "land",
		own: template.hasBuildTerritory("own") === true,
		ally: template.hasBuildTerritory("ally") === true,
		neutral: template.hasBuildTerritory("neutral") === true,
		enemy: template.hasBuildTerritory("enemy") === true,
	};
}

/** Whether the rules allow building on territory cell k (its owner, and whether it is connected). */
function territoryAllows(gameState: CommonGameState, rules: BuildRules, cell: number): boolean
{
	const territoryMap = gameState.ai.territoryMap;
	const tilePlayer = playerId(territoryMap.data[cell] & TERRITORY_PLAYER_MASK);
	const isConnected = (territoryMap.data[cell] & TERRITORY_BLINKING_MASK) === 0;
	if (tilePlayer === PlayerID)
	{
		return rules.own && (rules.neutral || isConnected);
	}
	if (gameState.isPlayerMutualAlly(tilePlayer))
	{
		return rules.ally && (rules.neutral || isConnected);
	}
	if (tilePlayer === 0)
	{
		return rules.neutral;
	}
	return rules.enemy;
}

export function createObstructionMap(
	gameState: CommonGameState,
	accessIndex: AccessIndex | undefined,
	template?: CommonTemplate,
): InfoMap
{
	const passabilityMap = gameState.getPassabilityMap();
	const territoryMap = gameState.ai.territoryMap;
	const ratio = territoryMap.cellSize / passabilityMap.cellSize;
	const rules = buildRules(template);
	const shore = rules.placementType === "shore";
	const obstructionTiles = new Uint8Array(passabilityMap.data.length);
	const passMap = shore ? gameState.ai.accessibility.navalPassMap : gameState.ai.accessibility.landPassMap;
	const obstructionMask = gameState.getPassabilityClassMask(shore ? "building-shore" : "building-land");

	// See createTerritoryMap: the engine grid's array is `data`, not `map`.
	for (let k = 0; k < territoryMap.data.length; ++k)
	{
		if (!territoryAllows(gameState, rules, k))
		{
			continue;
		}
		const x = ratio * (k % territoryMap.width);
		const y = ratio * Math.floor(k / territoryMap.width);
		for (let ix = 0; ix < ratio; ++ix)
		{
			for (let iy = 0; iy < ratio; ++iy)
			{
				const i = x + ix + (y + iy) * passabilityMap.width;
				if (!shore && accessIndex && accessIndex !== passMap[i])
				{
					continue;
				}
				if (!(passabilityMap.data[i] & obstructionMask))
				{
					obstructionTiles[i] = 255;
				}
			}
		}
	}

	const map = new InfoMap(gameState.sharedScript, "passability", obstructionTiles);
	map.setMaxVal(255);
	if (template)
	{
		keepMinDistance(gameState, map, template);
	}
	return map;
}

/** Rules out the cells nearer than the template's minimum distance to our structures of its class. */
function keepMinDistance(gameState: CommonGameState, map: InfoMap, template: CommonTemplate): void
{
	const distance = template.buildDistance();
	if (!distance)
	{
		return;
	}
	let minDist = distance.MinDistance ? +distance.MinDistance : 0;
	if (!minDist)
	{
		return;
	}
	// a distance requirement is template data, so a template was necessarily passed
	minDist -= requireValue(template.obstructionRadius()).min;
	const fromClass = distance.FromClass;
	const cellSize = gameState.getPassabilityMap().cellSize;
	const cellDist = 1 + minDist / cellSize;
	const structures = fromClass !== undefined ? gameState.getOwnStructures().filter(filters.byClass(fromClass)) : [];
	for (const ent of structures.values())
	{
		const pos = ent.position();
		const x = Math.round(pos[0] / cellSize);
		const z = Math.round(pos[1] / cellSize);
		map.addInfluence(x, z, cellDist, -255, "constant");
	}
}

/** The territory grid with its owner and blinking bits read out. */
/** Who owns each territory cell, read from the engine's territory grid. */
export class TerritoryMap extends InfoMap<"territory">
{
	constructor(gameState: CommonGameState)
	{
		// BUG: this read `.map` for a while. `gameState.ai.territoryMap` is the
		// engine's grid, whose array is `data` (CCmpAIManager reads the same name
		// back), so `.map` was undefined and InfoMap fell back to an all-zero map:
		// every territory came out unowned, with nothing thrown to say so.
		super(gameState.sharedScript, "territory", gameState.ai.territoryMap.data);
	}

	getOwner(p: CommonPosition): PlayerId
	{
		return playerId(this.point(p) & TERRITORY_PLAYER_MASK);
	}

	getOwnerIndex(p: CellIndex<"territory">): PlayerId
	{
		return playerId(this.map[p] & TERRITORY_PLAYER_MASK);
	}

	isBlinking(p: CommonPosition): boolean
	{
		return (this.point(p) & TERRITORY_BLINKING_MASK) !== 0;
	}
}

export function createTerritoryMap(gameState: CommonGameState): TerritoryMap
{
	return new TerritoryMap(gameState);
}

/**
 *  The borderMap contains some border and frontier information:
 *  - border of the map filled once:
 *     - all mini-cells (1x1) from the big cell (8x8) inaccessibles => bit 0
 *     - inside a given distance to the border                      => bit 1
 *  - frontier of our territory (updated regularly in updateFrontierMap)
 *     - narrow border (inside our territory)                       => bit 2
 *     - large border (inside our territory, exclusive of narrow)   => bit 3
 */

export function createBorderMap(gameState: CommonGameState): InfoMap
{
	const map = new InfoMap(gameState.sharedScript, "territory");
	const width = map.width;
	const border = Math.round(80 / map.cellSize);
	const passabilityMap = gameState.getPassabilityMap();
	const obstructionMask = gameState.getPassabilityClassMask("unrestricted");
	const ic = (width - 1) / 2;
	const radcut = (ic - border) * (ic - border);
	const borderCut = width - border;
	const nearEdge = gameState.circularMap ?
		(j: number): boolean =>
		{
			const dx = j % width - ic;
			const dy = Math.floor(j / width) - ic;
			return dx * dx + dy * dy >= radcut;
		} :
		(j: number): boolean =>
		{
			const ix = j % width;
			const iy = Math.floor(j / width);
			return ix < border || ix >= borderCut || iy < border || iy >= borderCut;
		};
	for (let jIndex = 0; jIndex < map.length; ++jIndex)
	{
		const j = cellIndex(map, jIndex);
		if (!nearEdge(j))
		{
			continue;
		}
		// outside, unless one of its passability cells is open: then border
		map.map[j] = mapMask.outside;
		for (const k of getMapIndices(j, map, passabilityMap))
		{
			if (passabilityMap.data[k] & obstructionMask)
			{
				continue;
			}
			map.map[j] = mapMask.border;
			break;
		}
	}

	// map.dumpIm("border.png", 5);
	return map;
}

/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
export function debugMap(gameState: CommonGameState, map: CommonInfoMap): void
{
	const width = map.width;
	const cell = map.cellSize;
	gameState.getEntities().forEach((ent) =>
	{
		if (!isPlaced(ent))
		{
			return;
		}
		const pos = ent.position();
		const x = Math.round(pos[0] / cell);
		const z = Math.round(pos[1] / cell);
		const id = x + width * z;
		if (map.map[id] === 1)
		{
			debugShade([ent.id()], [2, 0, 0]);
		}
		else if (map.map[id] === 2)
		{
			debugShade([ent.id()], [0, 2, 0]);
		}
		else if (map.map[id] === 3)
		{
			debugShade([ent.id()], [0, 0, 2]);
		}
	});
}
