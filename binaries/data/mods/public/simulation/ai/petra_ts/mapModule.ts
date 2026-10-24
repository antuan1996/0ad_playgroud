import { requireValue } from "./entityExtend.ts";
import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { getMapIndices } from "simulation/ai/common-api/utils.js";
import * as mapMask from "./mapMask.ts";

/** map functions */

/* eslint-disable prefer-const -- Mods should be able to change them */
let TERRITORY_PLAYER_MASK = 0x1F;
let TERRITORY_BLINKING_MASK = 0x40;
/* eslint-enable prefer-const */

export function createObstructionMap(gameState: CommonGameState, accessIndex: number | undefined,
	template?: CommonTemplate): InfoMap
{
	const passabilityMap = gameState.getPassabilityMap();
	const territoryMap = gameState.ai.territoryMap;
	const ratio = territoryMap.cellSize / passabilityMap.cellSize;

	// default values
	let placementType = "land";
	let buildOwn = true;
	let buildAlly = true;
	let buildNeutral = true;
	let buildEnemy = false;
	// If there is a template then replace the defaults
	if (template)
	{
		placementType = template.buildPlacementType() ?? placementType;
		buildOwn = template.hasBuildTerritory("own") ?? buildOwn;
		buildAlly = template.hasBuildTerritory("ally") ?? buildAlly;
		buildNeutral = template.hasBuildTerritory("neutral") ?? buildNeutral;
		buildEnemy = template.hasBuildTerritory("enemy") ?? buildEnemy;
	}
	const obstructionTiles = new Uint8Array(passabilityMap.data.length);

	let passMap;
	let obstructionMask;
	if (placementType == "shore")
	{
		passMap = gameState.ai.accessibility.navalPassMap;
		obstructionMask = gameState.getPassabilityClassMask("building-shore");
	}
	else
	{
		passMap = gameState.ai.accessibility.landPassMap;
		obstructionMask = gameState.getPassabilityClassMask("building-land");
	}

	// See createTerritoryMap: the engine grid's array is `data`, not `map`.
	for (let k = 0; k < territoryMap.data.length; ++k)
	{
		const tilePlayer = territoryMap.data[k] & TERRITORY_PLAYER_MASK;
		const isConnected = (territoryMap.data[k] & TERRITORY_BLINKING_MASK) == 0;
		if (tilePlayer === PlayerID)
		{
			if (!buildOwn || !buildNeutral && !isConnected)
				continue;
		}
		else if (gameState.isPlayerMutualAlly(tilePlayer))
		{
			if (!buildAlly || !buildNeutral && !isConnected)
				continue;
		}
		else if (tilePlayer === 0)
		{
			if (!buildNeutral)
				continue;
		}
		else
		{
			if (!buildEnemy)
				continue;
		}

		const x = ratio * (k % territoryMap.width);
		const y = ratio * Math.floor(k / territoryMap.width);
		for (let ix = 0; ix < ratio; ++ix)
		{
			for (let iy = 0; iy < ratio; ++iy)
			{
				const i = x + ix + (y + iy)*passabilityMap.width;
				if (placementType != "shore" && accessIndex && accessIndex !== passMap[i])
					continue;
				if (!(passabilityMap.data[i] & obstructionMask))
					obstructionTiles[i] = 255;
			}
		}
	}

	const map = new InfoMap(gameState.sharedScript, "passability", obstructionTiles);
	map.setMaxVal(255);

	const distance = template ? template.buildDistance() : undefined;
	if (distance)
	{
		let minDist = distance.MinDistance ? +distance.MinDistance : 0;
		if (minDist)
		{
			// a distance requirement is template data, so a template was necessarily passed
			minDist -= requireValue(template?.obstructionRadius()).min;
			const fromClass = distance.FromClass;
			const cellSize = passabilityMap.cellSize;
			const cellDist = 1 + minDist / cellSize;
			const structures = fromClass !== undefined ?
				gameState.getOwnStructures().filter(filters.byClass(fromClass)) :
				[];
			for (const ent of structures.values())
			{
				if (!ent.position())
					continue;
				const pos = ent.position();
				const x = Math.round(pos[0] / cellSize);
				const z = Math.round(pos[1] / cellSize);
				map.addInfluence(x, z, cellDist, -255, "constant");
			}
		}
	}

	return map;
}


export function createTerritoryMap(gameState: CommonGameState): InfoMap & {
	getOwner: (position: CommonPosition) => number;
	getOwnerIndex: (index: number) => number;
	isBlinking: (position: CommonPosition) => boolean;
}
{
	const map = gameState.ai.territoryMap;

	// BUG: this read `.map` for a while. `gameState.ai.territoryMap` is the
	// engine's grid, whose array is `data` (CCmpAIManager reads the same name
	// back), so `.map` was undefined and InfoMap fell back to an all-zero map:
	// every territory came out unowned, with nothing thrown to say so.
	// (The territory grid is a Grid<uint8_t>, so the data array is a
	// Uint8Array; the narrowing below documents that.)
	const ret = new InfoMap(gameState.sharedScript, "territory", map.data as Uint8Array) as InfoMap & {
		getOwner: (position: CommonPosition) => number;
		getOwnerIndex: (index: number) => number;
		isBlinking: (position: CommonPosition) => boolean;
	};
	ret.getOwner = function(this: InfoMap, p: CommonPosition): number
	{
		return this.point(p) & TERRITORY_PLAYER_MASK;
	};
	ret.getOwnerIndex = function(this: InfoMap, p: number): number
	{
		return this.map[p] & TERRITORY_PLAYER_MASK;
	};
	ret.isBlinking = function(this: InfoMap, p: CommonPosition): boolean
	{
		return (this.point(p) & TERRITORY_BLINKING_MASK) != 0;
	};
	return ret;
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
	if (gameState.circularMap)
	{
		const ic = (width - 1) / 2;
		const radcut = (ic - border) * (ic - border);
		for (let j = 0; j < map.length; ++j)
		{
			const dx = j%width - ic;
			const dy = Math.floor(j/width) - ic;
			const radius = dx*dx + dy*dy;
			if (radius < radcut)
				continue;
			map.map[j] = mapMask.outside;
			const ind = getMapIndices(j, map, passabilityMap);
			for (const k of ind)
			{
				if (passabilityMap.data[k] & obstructionMask)
					continue;
				map.map[j] = mapMask.border;
				break;
			}
		}
	}
	else
	{
		const borderCut = width - border;
		for (let j = 0; j < map.length; ++j)
		{
			const ix = j%width;
			const iy = Math.floor(j/width);
			if (ix < border || ix >= borderCut || iy < border || iy >= borderCut)
			{
				map.map[j] = mapMask.outside;
				const ind = getMapIndices(j, map, passabilityMap);
				for (const k of ind)
				{
					if (passabilityMap.data[k] & obstructionMask)
						continue;
					map.map[j] = mapMask.border;
					break;
				}
			}
		}
	}

	// map.dumpIm("border.png", 5);
	return map;
}

/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
function debugMap(gameState: CommonGameState, map: CommonInfoMap): void
{
	const width = map.width;
	const cell = map.cellSize;
	gameState.getEntities().forEach((ent: import("simulation/ai/common-api/entity.js").Entity): void =>
	{
		const pos = ent.position();
		if (!pos)
			return;
		const x = Math.round(pos[0] / cell);
		const z = Math.round(pos[1] / cell);
		const id = x + width*z;
		if (map.map[id] == 1)
			Engine.PostCommand(PlayerID, { "type": "set-shading-color", "entities": [ent.id()], "rgb": [2, 0, 0] });
		else if (map.map[id] == 2)
			Engine.PostCommand(PlayerID, { "type": "set-shading-color", "entities": [ent.id()], "rgb": [0, 2, 0] });
		else if (map.map[id] == 3)
			Engine.PostCommand(PlayerID, { "type": "set-shading-color", "entities": [ent.id()], "rgb": [0, 0, 2] });
	});
}
