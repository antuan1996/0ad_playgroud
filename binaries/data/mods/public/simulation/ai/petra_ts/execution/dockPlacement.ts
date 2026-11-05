import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance, VectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { NEW_ANCHORLESS_BASE, NO_LAND, cellIndex, landRegion, worldPos } from "../adapter/brands.ts";
import { getLandAccess, getSeaAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { footprintHalves } from "../adapter/templateData.ts";
import * as mapMask from "../world/mapMask.ts";
import { createObstructionMap } from "../world/mapModule.ts";
import { hqOf } from "./hq.ts";
import type { PlanMetadata } from "./queueplan.ts";
import type { BuildingPosition } from "./queueplanBuilding.ts";

/** res is a measure of the amount of resources around a dock, and MAX_RES the max value taken into account */
const MAX_RES = 10;
/** water is a measure of the water space around a dock, and MAX_WATER the max value checkDockPlacement returns */
const MAX_WATER = 16;

const AROUND = [
	[1.0, 0.0],
	[0.87, 0.50],
	[0.50, 0.87],
	[0.0, 1.0],
	[-0.50, 0.87],
	[-0.87, 0.50],
	[-1.0, 0.0],
	[-0.87, -0.50],
	[-0.50, -0.87],
	[0.0, -1.0],
	[0.50, -0.87],
	[0.87, -0.50],
];

/** The best dock spot so far: its value (the lower the better), cells, angle, land and water */
type DockSpot = {
	val: number;
	idx: number;
	jdx: CellIndex<"territory">;
	angle: number;
	land: AccessIndex;
	water: number;
};

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
		{
			continue;
		}
		const dist = SquareVectorDistance(pos, cc.position());
		if (owner === PlayerID && (!ownDist || dist < ownDist))
		{
			ownDist = dist;
		}
		if (gameState.isPlayerEnemy(owner) && (!enemyDist || dist < enemyDist))
		{
			enemyDist = dist;
		}
	}
	return !!ownDist && !!enemyDist && enemyDist < 0.5 * ownDist;
}

/** Whether land i is an oversea dock's: no dock of ours, no civic centre of ours or an enemy's, and a sea to one of ours */
function isOverseaLand(
	gameState: CommonGameState,
	i: AccessIndex,
	docks: CommonEntityCollection,
	ccEnts: CommonEntityCollection,
): boolean
{
	for (const dock of docks.values())
	{
		if (getLandAccess(gameState, dock) === i)
		{
			return false;
		}
	}
	let sea;
	for (const cc of ccEnts.values())
	{
		const ccAccess = getLandAccess(gameState, cc);
		if (ccAccess !== undefined && ccAccess !== i)
		{
			if (cc.owner() === PlayerID && !sea)
			{
				sea = hqOf(gameState).getSeaBetweenIndices(gameState, ccAccess, i);
			}
			continue;
		}
		// Docks on island where we have a cc are already done elsewhere
		if (cc.owner() === PlayerID || gameState.isPlayerEnemy(cc.owner()))
		{
			return false;
		}
	}
	return !!sea;
}

/** Whether a naval cell is on the wanted sea, or on any sea when none is wanted */
function isWantedSea(naval: number, wantedSea: SeaIndex | undefined): boolean
{
	return !(wantedSea && naval !== wantedSea || !wantedSea && naval < 2);
}

/** The accessibility cell at a game position, or undefined off the map */
function cellOnMap(accessibility: CommonGameState["ai"]["accessibility"], x: number, z: number): number | undefined
{
	const pos = accessibility.gamePosToMapPos(worldPos(x, z));
	if (pos[0] < 0 || pos[0] >= accessibility.width)
	{
		return undefined;
	}
	if (pos[1] < 0 || pos[1] >= accessibility.height)
	{
		return undefined;
	}
	return pos[0] + pos[1] * accessibility.width;
}

/** Whether a game position is on the map and on open water */
function onOpenWater(accessibility: CommonGameState["ai"]["accessibility"], x: number, z: number): boolean
{
	const j = cellOnMap(accessibility, x, z);
	return j !== undefined && !(accessibility.landPassMap[j] > 1 || accessibility.navalPassMap[j] < 2);
}

/** Adds row ky's resources within dxmax of ix to the sum, weighted by their distance */
function addRow(
	sum: { total: number; nbcell: number; },
	row: { map: ArrayLike<number>; w: number; ix: number; size: number; weigh0: number; },
	ky: number,
	dxmax: number,
): void
{
	const { map, w, ix, size, weigh0 } = row;
	if (ky < 0 || ky >= w)
	{
		return;
	}
	for (let dx = -dxmax; dx <= dxmax; ++dx)
	{
		const kx = ix + dx;
		if (kx < 0 || kx >= w)
		{
			continue;
		}
		const ddx = dx > 0 ? dx : -dx;
		const weight = weigh0 * (dxmax - ddx) / size;
		sum.total += weight * map[kx + w * ky];
		sum.nbcell += weight;
	}
}

/** A dock laid at its spot, and at spots shifted a little along its angle in case that one fails */
export function constructOnShore(
	gameState: CommonGameState,
	builder: CommonEntity,
	type: TemplateName,
	pos: Exclude<BuildingPosition, false>,
	metadata: PlanMetadata,
): void
{
	// adjust a bit the position if needed
	const cosa = Math.cos(pos.angle);
	const sina = Math.sin(pos.angle);
	const shiftMax = hqOf(gameState).geography.territoryMap.cellSize;
	for (let shift = 0; shift <= shiftMax; shift += 2)
	{
		builder.construct(type, pos.x - shift * sina, pos.z - shift * cosa, pos.angle, metadata);
		if (shift > 0)
		{
			builder.construct(type, pos.x + shift * sina, pos.z + shift * cosa, pos.angle, metadata);
		}
	}
}

/** What the dock search reads, the same for every cell */
function dockSearch(
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	metadata: PlanMetadata = {},
): DockSearch
{
	const obstructions = createObstructionMap(gameState, NO_LAND, template);
	// obstructions.dumpIm(template.buildPlacementType() + "_obstructions.png");
	const nbShips = hqOf(gameState).navalManager.transportShips.length;
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
		dockProximity: metadata.proximity,
		obstructions,
		width: hqOf(gameState).geography.territoryMap.width,
		cellSize: hqOf(gameState).geography.territoryMap.cellSize,
		wantedLand,
		wantedSea,
		proxyAccess,
		oversea,
		dropsiteTypes: template.resourceDropsiteTypes(),
		radius: Math.ceil(template.obstructionRadius().max / obstructions.cellSize),
		// halfSize for the dock angle, halfDepth and halfWidth for checkPlacement
		halves: footprintHalves(template),
		ccEnts: oversea ? gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")) : null,
		docks: oversea ? gameState.getOwnStructures().filter(filters.byClass("Dock")) : null,
		// Normalisation factors (only guessed, no attempt to optimize them)
		factor: proxyAccess ? 1 : oversea ? 0.2 : 40,
	};
}

/**
 * fast check if we can build a dock: returns false if nearest land is farther than the dock dimension
 * if the (object) wantedLand is given, this nearest land should have one of these accessibility
 * if wantedSea is given, this tile should be inside this sea
 */
function isDockLocation(
	gameState: CommonGameState,
	j: number,
	dimension: number,
	wantedLand: Record<number, boolean> | undefined,
	wantedSea: SeaIndex | undefined,
): boolean
{
	const width = hqOf(gameState).geography.territoryMap.width;
	const cellSize = hqOf(gameState).geography.territoryMap.cellSize;
	const dimLand = dimension + 1.5 * cellSize;
	const dimSea = dimension + 2 * cellSize;

	const accessibility = gameState.ai.accessibility;
	const x = (j % width + 0.5) * cellSize;
	const z = (Math.floor(j / width) + 0.5) * cellSize;
	const pos = accessibility.gamePosToMapPos(worldPos(x, z));
	const k = pos[0] + pos[1] * accessibility.width;
	let landPass = accessibility.landPassMap[k];
	if (landPass > 1 && wantedLand && !wantedLand[landPass] || landPass < 2 && accessibility.navalPassMap[k] < 2)
	{
		return false;
	}

	for (const a of AROUND)
	{
		const landCell = cellOnMap(accessibility, x + dimLand * a[0], z + dimLand * a[1]);
		if (landCell === undefined)
		{
			continue;
		}
		landPass = accessibility.landPassMap[landCell];
		if (landPass < 2 || wantedLand && !wantedLand[landPass])
		{
			continue;
		}
		const seaCell = cellOnMap(accessibility, x - dimSea * a[0], z - dimSea * a[1]);
		if (seaCell !== undefined && isWantedSea(accessibility.navalPassMap[seaCell], wantedSea))
		{
			return true;
		}
	}

	return false;
}

/**
 * return a measure of the proximity to our frontier (including our allies)
 * 0=inside, 1=less than 24m, 2= less than 48m, 3= less than 72m, 4=less than 96m, 5=above 96m
 */
function getFrontierProximity(gameState: CommonGameState, j: CellIndex<"territory">): number
{
	const alliedVictory = gameState.getAlliedVictory();
	const territoryMap = hqOf(gameState).geography.territoryMap;
	let territoryOwner = territoryMap.getOwnerIndex(j);
	if (territoryOwner === PlayerID || alliedVictory && gameState.isPlayerAlly(territoryOwner))
	{
		return 0;
	}

	const borderMap = hqOf(gameState).geography.borderMap;
	const width = territoryMap.width;
	const step = Math.round(24 / territoryMap.cellSize);
	const ix = j % width;
	const iz = Math.floor(j / width);
	let best = 5;
	for (const a of AROUND)
	{
		for (let i = 1; i < 5; ++i)
		{
			const jx = ix + Math.round(i * step * a[0]);
			if (jx < 0 || jx >= width)
			{
				continue;
			}
			const jz = iz + Math.round(i * step * a[1]);
			if (jz < 0 || jz >= width)
			{
				continue;
			}
			if (borderMap.map[jx + width * jz] & mapMask.outside)
			{
				continue;
			}
			territoryOwner = territoryMap.getOwnerIndex(cellIndex(territoryMap, jx + width * jz));
			if (alliedVictory && gameState.isPlayerAlly(territoryOwner) || territoryOwner === PlayerID)
			{
				best = Math.min(best, i);
				break;
			}
		}
		if (best === 1)
		{
			break;
		}
	}

	return best;
}

/**
 * get the sum of the resources (except food) around, inside a given radius
 * resources have a weight (1 if dist=0 and 0 if dist=size) doubled for wood
 */
function getResourcesAround(gameState: CommonGameState, types: string[], i: number, radius: number): number
{
	const resourceMaps = gameState.sharedScript.resourceMaps;
	const w = resourceMaps.wood.width;
	const cellSize = resourceMaps.wood.cellSize;
	const size = Math.floor(radius / cellSize);
	const ix = i % w;
	const iy = Math.floor(i / w);
	const sum = { total: 0, nbcell: 0 };
	for (const k of types)
	{
		if (k === "food" || !resourceMaps[k])
		{
			continue;
		}
		const row = { map: resourceMaps[k].map, w, ix, size, weigh0: k === "wood" ? 2 : 1 };
		for (let dy = 0; dy <= size; ++dy)
		{
			addRow(sum, row, iy + dy, size - dy);
			if (dy !== 0)
			{
				addRow(sum, row, iy - dy, size - dy);
			}
		}
	}
	return sum.nbcell ? sum.total / sum.nbcell : 0;
}

/**
 * An oversea dock's spot: not much farther from our civic centres than from the enemy's (else undefined),
 * and far from our docks on its sea, for trade: its added score
 */
function overseaDockScore(
	gameState: CommonGameState,
	pos: CommonPosition,
	sea: number,
	search: Pick<DockSearch, "ccEnts" | "docks" | "width" | "cellSize" | "factor">,
): number | undefined
{
	const { ccEnts, docks, width, cellSize, factor } = search;
	if (ccEnts && overseaFromEnemy(gameState, pos, ccEnts))
	{
		return undefined;
	}

	// And maximize distance for trade.
	let dockDist = 0;
	if (docks)
	{
		for (const dock of docks.values())
		{
			if (getSeaAccess(gameState, dock) !== sea)
			{
				continue;
			}
			const dist = SquareVectorDistance(pos, dock.position());
			if (dist > dockDist)
			{
				dockDist = dist;
			}
		}
	}
	if (dockDist > 0)
	{
		dockDist = Math.sqrt(dockDist);
		if (dockDist > width * cellSize)
		{ // Could happen only on square maps, but anyway we don't want to be too far away
			return undefined;
		}
		return factor * (width * cellSize - dockDist);
	}
	return 0;
}

/**
 * A dock cell's score from the frontier's: plus the distance to the proximity point when given, a bonus for
 * resources, the oversea score (undefined when not oversea material) and a penalty on the map border
 */
function dockCellScore(
	gameState: CommonGameState,
	search: DockSearch,
	cell: { j: number; i: number; pos: CommonPosition; },
	score: number,
): number | undefined
{
	const res = search.dropsiteTypes ?
		Math.min(MAX_RES, getResourcesAround(gameState, search.dropsiteTypes, cell.j, 80)) :
		MAX_RES;

	// If proximity is given, we look for the nearest point
	if (search.proxyAccess && search.dockProximity)
	{
		score = VectorDistance(search.dockProximity, cell.pos);
	}

	// Bonus for resources
	score += 20 * (MAX_RES - res);

	if (search.oversea)
	{
		const overseaScore = overseaDockScore(
			gameState,
			cell.pos,
			gameState.ai.accessibility.navalPassMap[cell.i],
			search,
		);
		if (overseaScore === undefined)
		{
			return undefined;
		}
		score += overseaScore;
	}

	// Add a penalty if on the map border as ship movement will be difficult
	if (hqOf(gameState).geography.borderMap.map[cell.j] & mapMask.fullBorder)
	{
		score += 20;
	}
	return score;
}

/** Algorithm taken from the function GetDockAngle in simulation/helpers/Commands.js */
export function getDockAngle(gameState: CommonGameState, x: number, z: number, size: number): number | false
{
	let pos = gameState.ai.accessibility.gamePosToMapPos(worldPos(x, z));
	const k = pos[0] + pos[1] * gameState.ai.accessibility.width;
	const seaRef = gameState.ai.accessibility.navalPassMap[k];
	if (seaRef < 2)
	{
		return false;
	}
	const numPoints = 16;
	for (let dist = 0; dist < 4; ++dist)
	{
		const waterPoints = [];
		for (let i = 0; i < numPoints; ++i)
		{
			const angle = 2 * Math.PI * i / numPoints;
			pos = gameState.ai.accessibility.gamePosToMapPos(
				worldPos(x - (1 + dist) * size * Math.sin(angle), z + (1 + dist) * size * Math.cos(angle)),
			);
			if (
				pos[0] < 0 || pos[0] >= gameState.ai.accessibility.width ||
				pos[1] < 0 || pos[1] >= gameState.ai.accessibility.height
			)
			{
				continue;
			}
			const j = pos[0] + pos[1] * gameState.ai.accessibility.width;
			if (gameState.ai.accessibility.navalPassMap[j] === seaRef)
			{
				waterPoints.push(i);
			}
		}
		const length = waterPoints.length;
		if (!length)
		{
			continue;
		}
		const consec = [];
		for (let i = 0; i < length; ++i)
		{
			let count = 0;
			for (let j = 0; j < length - 1; ++j)
			{
				if ((waterPoints[(i + j) % length] + 1) % numPoints === waterPoints[(i + j + 1) % length])
				{
					++count;
				}
				else
				{
					break;
				}
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
		if (count !== numPoints - 1)
		{
			return -((waterPoints[start] + consec[start] / 2) % numPoints) / numPoints * 2 * Math.PI;
		}
	}
	return false;
}

/**
 * Algorithm taken from checkPlacement in simulation/components/BuildRestriction.js
 * to determine the special dock requirements
 * returns {"land": land index for this dock, "water": amount of water around this spot}
 */
function checkDockPlacement(
	gameState: CommonGameState,
	spot: { x: number; z: number; angle: number; },
	half: { halfDepth: number; halfWidth: number; },
): { land: AccessIndex; water: number; } | undefined
{
	const { x, z, angle } = spot;
	const accessibility = gameState.ai.accessibility;
	const sz = half.halfDepth * Math.sin(angle);
	const cz = half.halfDepth * Math.cos(angle);
	// center back position
	let pos = accessibility.gamePosToMapPos(worldPos(x - sz, z - cz));
	let j = pos[0] + pos[1] * accessibility.width;
	const land = accessibility.landPassMap[j];
	if (land < 2)
	{
		return undefined;
	}
	// center front position
	pos = accessibility.gamePosToMapPos(worldPos(x + sz, z + cz));
	j = pos[0] + pos[1] * accessibility.width;
	if (accessibility.landPassMap[j] > 1 || accessibility.navalPassMap[j] < 2)
	{
		return undefined;
	}
	// additional constraints compared to BuildRestriction.js to assure we have enough place to build
	const sw = half.halfWidth * Math.cos(angle) * 3 / 4;
	const cw = half.halfWidth * Math.sin(angle) * 3 / 4;
	pos = accessibility.gamePosToMapPos(worldPos(x - sz + sw, z - cz - cw));
	j = pos[0] + pos[1] * accessibility.width;
	if (accessibility.landPassMap[j] !== land)
	{
		return undefined;
	}
	pos = accessibility.gamePosToMapPos(worldPos(x - sz - sw, z - cz + cw));
	j = pos[0] + pos[1] * accessibility.width;
	if (accessibility.landPassMap[j] !== land)
	{
		return undefined;
	}
	let water = 0;
	const sp = 15 * Math.sin(angle);
	const cp = 15 * Math.cos(angle);
	for (let i = 1; i < 5; ++i)
	{
		if (
			!onOpenWater(accessibility, x + sz + i * (sp + sw), z + cz + i * (cp - cw)) ||
			!onOpenWater(accessibility, x + sz + i * sp, z + cz + i * cp) ||
			!onOpenWater(accessibility, x + sz + i * (sp - sw), z + cz + i * (cp + cw))
		)
		{
			break;
		}
		water += 4;
	}
	return { land: land, water: water };
}

/** The dock spot at a cell scored so: if it beats best with the water there, has a shore angle and room, and is safe */
function placeDock(
	gameState: CommonGameState,
	search: DockSearch,
	cell: { j: CellIndex<"territory">; i: number; pos: CommonPosition; },
	score: number,
	best: DockSpot | undefined,
): DockSpot | undefined
{
	const { j, i, pos } = cell;
	const { halfSize, halfDepth, halfWidth } = search.halves;
	// Do a pre-selection, supposing we will have the best possible water
	if (best !== undefined && score > best.val + 5 * MAX_WATER)
	{
		return undefined;
	}

	const obstructions = search.obstructions;
	const x = (i % obstructions.width + 0.5) * obstructions.cellSize;
	const z = (Math.floor(i / obstructions.width) + 0.5) * obstructions.cellSize;
	const angle = getDockAngle(gameState, x, z, halfSize);
	// as the original's `angle == false`: an angle of exactly 0 counts as none (FINDINGS §4)
	if (angle === false || angle === 0)
	{
		return undefined;
	}
	const ret = checkDockPlacement(gameState, { x, z, angle }, { halfDepth, halfWidth });
	if (!ret || !hqOf(gameState).geography.landRegions[ret.land] || search.wantedLand && !search.wantedLand[ret.land])
	{
		return undefined;
	}
	// Final selection now that the checkDockPlacement water is known
	if (best !== undefined && score + 5 * (MAX_WATER - ret.water) > best.val)
	{
		return undefined;
	}
	if (search.dockProximity && gameState.ai.accessibility.regionSize[ret.land] < 4000)
	{
		return undefined;
	}
	if (hqOf(gameState).isDangerousLocation(gameState, pos, halfSize))
	{
		return undefined;
	}

	return { val: score + MAX_WATER - ret.water, idx: i, jdx: j, angle, land: ret.land, water: ret.water };
}

/** The dock spot at cell j if it is one and beats best (the lower the better), else undefined */
function dockSpotAt(
	gameState: CommonGameState,
	search: DockSearch,
	j: CellIndex<"territory">,
	best: DockSpot | undefined,
): DockSpot | undefined
{
	if (!isDockLocation(gameState, j, search.halves.halfDepth, search.wantedLand, search.wantedSea))
	{
		return undefined;
	}
	let score = 0;
	if (!search.proxyAccess && !search.oversea)
	{
		// if not in our (or allied) territory, we do not want it too far to be able to defend it
		score = getFrontierProximity(gameState, j);
		if (score > 4)
		{
			return undefined;
		}
		score *= search.factor;
	}
	const territoryMap = hqOf(gameState).geography.territoryMap;
	const i = territoryMap.getNonObstructedTile(j, search.radius, search.obstructions);
	if (i < 0)
	{
		return undefined;
	}
	const navalPassMap = gameState.ai.accessibility.navalPassMap;
	if (search.wantedSea && navalPassMap[i] !== search.wantedSea)
	{
		return undefined;
	}

	const pos: CommonPosition = worldPos(
		search.cellSize * (j % search.width + 0.5),
		search.cellSize * (Math.floor(j / search.width) + 0.5),
	);
	const scored = dockCellScore(gameState, search, { j, i, pos }, score);
	if (scored === undefined)
	{
		return undefined;
	}
	return placeDock(gameState, search, { j, i, pos }, scored, best);
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
export function findDockPosition(
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	metadata: PlanMetadata | undefined,
): BuildingPosition
{
	const search = dockSearch(gameState, template, metadata);
	const territoryMap = hqOf(gameState).geography.territoryMap;
	let best: DockSpot | undefined;
	for (let jIndex = 0; jIndex < territoryMap.length; ++jIndex)
	{
		const spot = dockSpotAt(gameState, search, cellIndex(territoryMap, jIndex), best);
		if (spot)
		{
			best = spot;
		}
	}
	if (!best || best.val < 0)
	{
		return false;
	}

	// if no good place with enough water around and still in first phase, wait for expansion at the next phase
	if (!search.dockProximity && best.water < 10 && gameState.currentPhase() === 1)
	{
		return false;
	}

	const obstructions = search.obstructions;
	const x = (best.idx % obstructions.width + 0.5) * obstructions.cellSize;
	const z = (Math.floor(best.idx / obstructions.width) + 0.5) * obstructions.cellSize;

	// Assign this dock to a base
	let baseIndex = hqOf(gameState).baseAtIndex(best.jdx);
	if (!baseIndex)
	{
		baseIndex = NEW_ANCHORLESS_BASE; // We'll do an anchorless base around it
	}

	return { x: x, z: z, angle: best.angle, base: baseIndex, access: best.land };
}

/**
 * Find a good island to build a dock.
 */
export function buildOverseaDock(gameState: CommonGameState, template: CommonStructureTemplate): void
{
	const docks = gameState.getOwnStructures().filter(filters.byClass("Dock"));
	if (!docks.hasEntities())
	{
		return;
	}

	const passabilityMap = gameState.getPassabilityMap();
	const cellArea = passabilityMap.cellSize * passabilityMap.cellSize;
	const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));

	const land: Record<number, boolean> = {};
	let found;
	for (let i = 0; i < gameState.ai.accessibility.regionSize.length; ++i)
	{
		if (
			gameState.ai.accessibility.regionType[i] !== "land" ||
			cellArea * gameState.ai.accessibility.regionSize[i] < 3600
		)
		{
			continue;
		}
		if (!isOverseaLand(gameState, landRegion(i), docks, ccEnts))
		{
			continue;
		}
		land[i] = true;
		found = true;
	}
	if (!found)
	{
		return;
	}
	if (!hqOf(gameState).geography.navalMap)
	{
		aiWarn("petra.findOverseaLand on a non-naval map??? we should never go there ");
	}

	const metadata: PlanMetadata = { land: land, oversea: true };
	const pos = findDockPosition(gameState, template, metadata);
	const type = template.templateName();
	// the builder registry may still list a builder whose last unit died this turn
	const builder = pos ? gameState.findBuilder(type) : undefined;
	if (pos && builder)
	{
		metadata.base = pos.base;
		constructOnShore(gameState, builder, type, pos, metadata);
	}
}
