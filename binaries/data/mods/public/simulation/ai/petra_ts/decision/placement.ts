import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { GAIA, NO_BASE, NO_LAND, cellIndex, worldPos } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import { getLandAccess, getSeaAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { footprintHalves } from "../adapter/templateData.ts";
import type { Config } from "../world/config.ts";
import type { Geography } from "../world/geography.ts";
import * as mapMask from "../world/mapMask.ts";
import { createObstructionMap, type TerritoryMap } from "../world/mapModule.ts";
import type { ShipTraffic } from "../world/shipTraffic.ts";
import { isLineInsideEnemyTerritory } from "../world/territory.ts";

/** What any free land is worth to a base sought for its room (findEconomicCCLocation's forRoom). */
const ROOM_VALUE = 10;

/** The ship-seconds of enemy traffic, fading, a shore tower must reach (findShoreTowerLocation). */
export const SHORE_TOWER_TRAFFIC = 30;
/** A tower's reach when its template names none. */
const DEFAULT_TOWER_RANGE = 60;

/** How the economic search for a civic centre spot is made: near a position (our first base), for a strategic one, or for room */
export type EconomicCCOptions = { proximity?: CommonPosition; fromStrategic?: boolean; forRoom?: boolean; };

/** A civic centre a new civic centre's spot is weighed against */
type CCSpotCivCentre = { ent: CommonEntity; pos: CommonPosition; ally: boolean; };
/** One of our dropsites a new civic centre's spot is weighed against */
type CCSpotDropsite = { ent: CommonEntity; pos: CommonPosition; };
/** The squared distances that reject or disfavour a new civic centre's spot */
type CCSpotLimits = {
	nearbyRejected: number;
	nearbyAllyRejected: number;
	nearbyAllyDisfavored: number;
	maxAccessRejected: number;
	maxAccessDisfavored: number;
	maxNoAccessDisfavored: number;
};

/** What a civic centre spot's spread is weighed against: the civic centres, our dropsites, and the distance limits */
type CCSpotSpread = { ccList: CCSpotCivCentre[]; dpList: CCSpotDropsite[]; limits: CCSpotLimits; };

/** What the economic search for a civic centre spot reads, the same for every cell */
type EconomicCCSearch = {
	obstructions: ReturnType<typeof createObstructionMap>;
	radius: number;
	scale: number;
	proxyAccess: number | undefined;
	nbShips: number;
	spread: CCSpotSpread;
	cut: number;
};

/** What the placement searches read and call on the headquarters */
interface PlacementHQ
{
	readonly Config: Config;
	readonly geography: Geography;
	readonly navalManager: { readonly transportShips: { readonly length: number; }; };
	readonly tradeManager: { readonly minimalGain: number; };
	readonly basesManager: { baseAtIndex(j: CellIndex<"territory">): BaseId; };
	isAvoidedCCSpot(pos: CommonPosition): boolean;
	isContestedCCSpot(gameState: CommonGameState, pos: CommonPosition, land: AccessIndex): boolean;
	isDangerousLocation(gameState: CommonGameState, pos: CommonPosition, halfSize: number): boolean;
}

/** What a civic centre at cell j would reach: twice the resource and once the others but food (plus ROOM_VALUE for room) */
function ccResourceValue(gameState: CommonGameState, resource: string, j: number, forRoom: boolean): number
{
	let val = (forRoom ? ROOM_VALUE : 0) + 2 * gameState.sharedScript.ccResourceMaps[resource].map[j];
	for (const res in gameState.sharedScript.resourceMaps)
	{
		if (res !== "food")
		{
			val += gameState.sharedScript.ccResourceMaps[res].map[j];
		}
	}
	return val;
}

/**
 * The structures our defenses face: the enemy's civic centres, fortresses and towers; in cease fire mode the
 * neutrals', else our allies' when no allied victory; undefined when there are none
 */
function structuresToFace(gameState: CommonGameState): CommonStructureEntity[] | undefined
{
	const classes = filters.byClasses(["CivCentre", "Fortress", "Tower"]);
	let enemyStructures = gameState.getEnemyStructures().filter(filters.not(filters.byOwner(GAIA))).filter(classes)
		.toEntityArray();
	if (enemyStructures.length)
	{
		return enemyStructures;
	}
	enemyStructures = gameState.getNeutralStructures().filter(filters.not(filters.byOwner(GAIA))).filter(classes)
		.toEntityArray();
	if (!enemyStructures.length && !gameState.getAlliedVictory())
	{
		enemyStructures = gameState.getAllyStructures().filter(filters.not(filters.byOwner(PlayerID))).filter(classes)
			.toEntityArray();
	}
	return enemyStructures.length ? enemyStructures : undefined;
}

/** In a wonder game with a wonder of ours: it, and how near our defenses may stand to it (squared) */
function wonderToGuard(gameState: CommonGameState): { ent: CommonStructureEntity; distmin: number; } | undefined
{
	if (!gameState.getVictoryConditions().has("wonder"))
	{
		return undefined;
	}
	const wonders = gameState.getOwnStructures().filter(filters.byClass("Wonder")).toEntityArray();
	if (wonders.length === 0)
	{
		return undefined;
	}
	// wonders always have a footprint
	const wonderRadius = wonders[0].footprintRadius();
	return { ent: wonders[0], distmin: (50 + wonderRadius) * (50 + wonderRadius) };
}

/**
 * A defensive spot's value, the lower the better: its distance to the nearest enemy civic centre, plus 200 times
 * its distance to our wonder; undefined in range of an enemy defense, too near ours or our wonder, or with no cc
 */
function defenseSpotValue(
	pos: CommonPosition,
	wonder: { ent: CommonStructureEntity; distmin: number; } | undefined,
	enemyStructures: CommonStructureEntity[],
	ownStructures: CommonStructureEntity[],
): number | undefined
{
	let minDist = Math.min();
	let dista = 0;
	if (wonder)
	{
		const wonderPos = wonder.ent.position();
		if (wonderPos)
		{
			dista = SquareVectorDistance(wonderPos, pos);
		}
		if (wonder.distmin !== Infinity && dista < wonder.distmin)
		{
			return undefined;
		}
		dista *= 200; // empirical factor (TODO should depend on map size) to stay near the wonder
	}

	for (const str of enemyStructures)
	{
		if (str.foundationProgress() !== undefined)
		{
			continue;
		}
		const strPos = str.position();
		const dist = SquareVectorDistance(strPos, pos);
		if (dist < 6400)
		{ // TODO check on true attack range instead of this 80×80
			return undefined;
		}
		if (str.hasClass("CivCentre") && dist + dista < minDist)
		{
			minDist = dist + dista;
		}
	}

	const cutDist = 900; // 30×30 TODO maybe increase it
	for (const str of ownStructures)
	{
		if (SquareVectorDistance(str.position(), pos) < cutDist)
		{
			return undefined;
		}
	}
	if (minDist === Math.min())
	{
		return undefined;
	}
	return minDist;
}

/**
 * A spot's value factor from the civic centres: rejected (undefined) too near any, or an ally's, or too far from
 * an accessible ally's; lowered quite near an ally's or quite far from all; and whether one is on its land
 */
function ccSpread(
	gameState: CommonGameState,
	pos: CommonPosition,
	index: number,
	normIn: number,
	spread: CCSpotSpread,
): { norm: number; accessible: boolean; } | undefined
{
	const { ccList, limits } = spread;
	let norm = normIn;
	let minDist = Math.min();
	let accessible = false;

	for (const cc of ccList)
	{
		const dist = SquareVectorDistance(cc.pos, pos);
		if (dist < limits.nearbyRejected)
		{
			return undefined;
		}
		if (!cc.ally)
		{
			continue;
		}
		if (dist < limits.nearbyAllyRejected)
		{
			return undefined;
		}
		if (dist < limits.nearbyAllyDisfavored)
		{
			norm *= 0.5;
		}

		if (dist < minDist)
		{
			minDist = dist;
		}
		accessible = accessible || index === getLandAccess(gameState, cc.ent);
	}
	if (norm === 0)
	{
		return undefined;
	}

	if (accessible && minDist > limits.maxAccessRejected)
	{
		return undefined;
	}

	if (minDist > limits.maxAccessDisfavored)
	{ // Disfavor if quite far from any allied cc
		if (!accessible)
		{
			if (minDist > limits.maxNoAccessDisfavored)
			{
				norm *= 0.5;
			}
			else
			{
				norm *= 0.8;
			}
		}
		else
		{
			norm *= 0.5;
		}
	}
	return { norm, accessible };
}

/** The civic centres and our dropsites a new civic centre's spot is weighed against */
function ccSpotNeighbours(gameState: CommonGameState): { ccList: CCSpotCivCentre[]; dpList: CCSpotDropsite[]; }
{
	const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
	const dpEnts = gameState.getOwnDropsites().filter(filters.not(filters.byClasses(["CivCentre", "Unit"])));
	const ccList: CCSpotCivCentre[] = [];
	for (const cc of ccEnts.values())
	{
		const pos = cc.position();
		if (pos)
		{
			ccList.push({ ent: cc, pos: pos, ally: gameState.isPlayerAlly(cc.owner()) });
		}
	}
	const dpList: CCSpotDropsite[] = [];
	for (const dp of dpEnts.values())
	{
		const pos = dp.position();
		if (pos)
		{
			dpList.push({ ent: dp, pos: pos });
		}
	}
	return { ccList, dpList };
}

/**
 * How far a spot for a later civic centre lies from the other civic centres and our dropsites:
 * norm, the spot's value factor, lowered by them, and whether it is oversea; undefined when it is rejected.
 */
function ccSpotSpread(
	gameState: CommonGameState,
	pos: CommonPosition,
	index: number,
	normIn: number,
	spread: CCSpotSpread,
): { norm: number; oversea: boolean; } | undefined
{
	const { dpList } = spread;
	const fromCCs = ccSpread(gameState, pos, index, normIn, spread);
	if (!fromCCs)
	{
		return undefined;
	}
	const { accessible } = fromCCs;
	let norm = fromCCs.norm;

	// Not near any of our dropsite, except for oversea docks
	const oversea = !accessible && dpList.some((dp) => getLandAccess(gameState, dp.ent) === index);
	if (!oversea)
	{
		for (const dp of dpList)
		{
			const dist = SquareVectorDistance(dp.pos, pos);
			if (dist < 3600)
			{
				norm = 0;
				break;
			}
			else if (dist < 6400)
			{
				norm *= 0.5;
			}
		}
	}
	if (norm === 0)
	{
		return undefined;
	}
	return { norm, oversea };
}

/** Every civic centre on the map, and how many of them are allied. */
function alliedCivCentres(
	gameState: CommonGameState,
): { ccList: Array<{ pos: CommonPosition; ally: boolean; }>; numAllyCC: number; }
{
	const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
	const ccList: Array<{ pos: CommonPosition; ally: boolean; }> = [];
	let numAllyCC = 0;
	for (const cc of ccEnts.values())
	{
		const ally = gameState.isPlayerAlly(cc.owner());
		const pos = cc.position();
		if (pos)
		{
			ccList.push({ pos: pos, ally: ally });
		}
		if (ally)
		{
			++numAllyCC;
		}
	}
	return { ccList, numAllyCC };
}

/**
 * The distance to the nearest allied civic centre (0 when the spot is too near one, or near any), the three
 * nearest kept in nearest (d0 counted again for this spot, d1 and d2 not: as in Petra)
 */
function rankAllyCCs(
	ccList: Array<{ pos: CommonPosition; ally: boolean; }>,
	pos: CommonPosition,
	nearest: { d0: number; d1: number; d2: number; },
): number
{
	let minDist = Math.min();
	nearest.d0 = Infinity;
	for (const cc of ccList)
	{
		const dist = SquareVectorDistance(cc.pos, pos);
		if (dist < 14000)
		{ // Reject if too near from any cc
			return 0;
		}
		if (!cc.ally)
		{
			continue;
		}
		if (dist < 62000)
		{ // Reject if quite near from ally cc
			return 0;
		}
		if (dist < minDist)
		{
			minDist = dist;
		}

		if (dist < nearest.d0)
		{
			nearest.d2 = nearest.d1;
			nearest.d1 = nearest.d0;
			nearest.d0 = dist;
		}
		else if (dist < nearest.d1)
		{
			nearest.d2 = nearest.d1;
			nearest.d1 = dist;
		}
		else if (dist < nearest.d2)
		{
			nearest.d2 = dist;
		}
	}
	return minDist;
}

/** The sum of the squared gaps between the favored distance and the (up to three) nearest allied civic centres */
function strategicValue(nearest: { d0: number; d1: number; d2: number; }, favoredDistance: number): number
{
	let delta = Math.sqrt(nearest.d0) - favoredDistance;
	let currentVal = delta * delta;
	delta = Math.sqrt(nearest.d1) - favoredDistance;
	currentVal += delta * delta;
	if (nearest.d2 !== Infinity)
	{
		delta = Math.sqrt(nearest.d2) - favoredDistance;
		currentVal += delta * delta;
	}
	return currentVal;
}

/** The allied markets, or our own when allies have none. */
function tradeMarkets(gameState: CommonGameState): CommonEntity[]
{
	let markets = gameState.updatingCollection(
		"diplo-ExclusiveAllyMarkets",
		filters.byClass("Trade"),
		gameState.getExclusiveAllyEntities(),
	).toEntityArray();
	if (!markets.length)
	{
		markets = gameState.updatingCollection("OwnMarkets", filters.byClass("Trade"), gameState.getOwnStructures())
			.toEntityArray();
	}
	return markets;
}

/** The market farthest from the spot by its gain (the distance weighted by the trader's gain) on its land or sea */
function farthestMarket(
	gameState: CommonGameState,
	pos: CommonPosition,
	index: number,
	trade: {
		markets: CommonEntity[];
		naval: boolean;
		gains: { landGainMultiplier?: number; navalGainMultiplier?: number; };
	},
): { val: number; distSq: number; gainMult: number; }
{
	let maxVal = 0;
	let maxDistSq = 0;
	let maxGainMult = 0;
	for (const market of trade.markets)
	{
		// a market: on the map
		if (!isPlaced(market))
		{
			continue;
		}
		let gainMultiplier;
		if (trade.naval)
		{
			if (getSeaAccess(gameState, market) !== gameState.ai.accessibility.getAccessValue(pos, true))
			{
				continue;
			}
			gainMultiplier = trade.gains.navalGainMultiplier;
		}
		else if (
			getLandAccess(gameState, market) === index && !isLineInsideEnemyTerritory(gameState, market.position(), pos)
		)
		{
			gainMultiplier = trade.gains.landGainMultiplier;
		}
		else
		{
			continue;
		}
		if (!gainMultiplier)
		{
			continue;
		}
		const distSq = SquareVectorDistance(market.position(), pos);
		if (gainMultiplier * distSq > maxVal)
		{
			maxVal = gainMultiplier * distSq;
			maxDistSq = distSq;
			maxGainMult = gainMultiplier;
		}
	}
	return { val: maxVal, distSq: maxDistSq, gainMult: maxGainMult };
}

/** The tile with room around a cell, of the size given, on a land we know; undefined if none */
function roomyTile(
	geography: Geography,
	gameState: CommonGameState,
	j: CellIndex<"territory">,
	radius: number,
	obstructions: ReturnType<typeof createObstructionMap>,
): { i: number; index: AccessIndex; } | undefined
{
	const i = geography.territoryMap.getNonObstructedTile(j, radius, obstructions);
	if (i < 0)
	{
		return undefined;
	}
	// We require that it is accessible
	const index = gameState.ai.accessibility.landPassMap[i];
	if (!geography.landRegions[index])
	{
		return undefined;
	}
	return { i, index };
}

/** The cells no one owns with a tile with room around (roomyTile) */
function* freeTiles(
	geography: Geography,
	gameState: CommonGameState,
	radius: number,
	obstructions: ReturnType<typeof createObstructionMap>,
): Generator<{ j: CellIndex<"territory">; i: number; index: AccessIndex; }>
{
	for (let jIndex = 0; jIndex < geography.territoryMap.length; ++jIndex)
	{
		const j = cellIndex(geography.territoryMap, jIndex);
		if (geography.territoryMap.getOwnerIndex(j) !== 0)
		{
			continue;
		}
		const tile = roomyTile(geography, gameState, j, radius, obstructions);
		if (tile)
		{
			yield { j, ...tile };
		}
	}
}

/** The centre of a territory cell */
function cellCentre(territoryMap: TerritoryMap, j: number): CommonPosition
{
	const width = territoryMap.width;
	const cellSize = territoryMap.cellSize;
	return worldPos(cellSize * (j % width + 0.5), cellSize * (Math.floor(j / width) + 0.5));
}

/** What the economic search for a civic centre spot reads, the same for every cell */
function economicCCSearch(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	options: EconomicCCOptions,
): EconomicCCSearch
{
	const { proximity, fromStrategic, forRoom } = options;
	// obstruction map
	const obstructions = createObstructionMap(gameState, NO_LAND, template);
	const neighbours = ccSpotNeighbours(gameState);
	const obstructionRadius = template.obstructionRadius();
	let radius = Math.ceil(obstructionRadius.max / obstructions.cellSize);
	let scale = 250 * 250;
	let proxyAccess;
	const nbShips = hq.navalManager.transportShips.length;
	if (proximity)
	{ // this is our first base
		// if our first base, ensure room around
		radius = Math.ceil((obstructionRadius.max + 8) / obstructions.cellSize);
		// scale is the typical scale at which we want to find a location for our first base
		// look for bigger scale if we start from a ship (access < 2) or from a small island
		const cellArea = gameState.getPassabilityMap().cellSize * gameState.getPassabilityMap().cellSize;
		proxyAccess = gameState.ai.accessibility.getAccessValue(proximity);
		if (proxyAccess < 2 || cellArea * gameState.ai.accessibility.regionSize[proxyAccess] < 24000)
		{
			scale = 400 * 400;
		}
	}

	// DistanceSquare cuts to other ccs (bigger or no cuts on inaccessible ccs to allow colonizing other islands).
	const reduce = (template.hasClass("Colony") ? 30 : 0) + 30 * hq.Config.personality.defensive;
	const limits: CCSpotLimits = {
		nearbyRejected: Math.square(120), // Reject if too near from any cc
		nearbyAllyRejected: Math.square(200), // Reject if too near from an allied cc
		nearbyAllyDisfavored: Math.square(250), // Disfavor if quite near an allied cc
		maxAccessRejected: Math.square(410), // Reject if too far from an accessible ally cc
		maxAccessDisfavored: Math.square(360 - reduce), // Disfavor if quite far from an accessible ally cc
		maxNoAccessDisfavored: Math.square(500), // Disfavor if quite far from an inaccessible ally cc
	};

	let cut = 60;
	if (fromStrategic || proximity)
	{ // be less restrictive
		cut = 30;
	}
	// a base for room (FINDINGS §40): any free land we can reach is worth it,
	// its resources a bonus; Dodecanese's free islands scored under the cut
	if (forRoom)
	{
		cut = 1;
	}
	return { obstructions, radius, scale, proxyAccess, nbShips, spread: { ...neighbours, limits }, cut };
}

/**
 * A spot's value factor: for our first cc, nearer our units the better; otherwise its spread from the other
 * civic centres and our dropsites, and whether it is oversea (undefined when rejected)
 */
function economicNorm(
	gameState: CommonGameState,
	search: EconomicCCSearch,
	pos: CommonPosition,
	index: number,
	proximity: CommonPosition | undefined,
): { value: number; oversea: boolean; } | undefined
{
	const norm = 0.5; // TODO adjust it, knowing that we will sum 5 maps
	if (proximity)
	{ // This is our first cc, let's do it near our units
		return { value: norm / (1 + SquareVectorDistance(proximity, pos) / search.scale), oversea: false };
	}
	// We will be more tolerant for cc around our oversea docks
	const spread = ccSpotSpread(gameState, pos, index, norm, search.spread);
	return spread && { value: spread.norm, oversea: spread.oversea };
}

/**
 * Returns the best tile to build a new Civil Center
 * Whose primary function would be to reach new resources of type "resource".
 */
export function findEconomicCCTile(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	query: { resource: string; options: EconomicCCOptions; allowContested: boolean; },
): { bestIdx: number; obstructions: ReturnType<typeof createObstructionMap>; } | false
{
	// This builds a map. The procedure is fairly simple. It adds the resource maps
	// 	(which are dynamically updated and are made so that they will facilitate DP placement)
	// Then look for a good spot.

	Engine.ProfileStart("findEconomicCCLocation");

	const { resource, options, allowContested } = query;
	const search = economicCCSearch(hq, gameState, template, options);
	const halfSize = footprintHalves(template).halfSize;
	const { cut } = search;
	const forRoom = !!options.forRoom;

	let bestIdx = -1;
	let bestVal = -Infinity;
	for (const { j, i, index } of freeTiles(hq.geography, gameState, search.radius, search.obstructions))
	{
		if (search.proxyAccess && search.nbShips === 0 && search.proxyAccess !== index)
		{
			continue;
		}

		const pos = cellCentre(hq.geography.territoryMap, j);
		const norm = economicNorm(gameState, search, pos, index, options.proximity);
		if (norm === undefined)
		{
			continue;
		}

		let val = ccResourceValue(gameState, resource, j, forRoom);
		val *= hq.geography.borderMap.map[j] & mapMask.fullBorder ? norm.value * 0.5 : norm.value; // disfavor the borders of the map

		// If oversea, be just above threshold to be accepted if nothing else
		if (norm.oversea)
		{
			val = Math.max(val, cut + 0.1);
		}

		if (val < bestVal)
		{
			continue;
		}
		if (
			(allowContested ? hq.isAvoidedCCSpot(pos) : hq.isContestedCCSpot(gameState, pos, index)) ||
			hq.isDangerousLocation(gameState, pos, halfSize)
		)
		{
			continue;
		}
		bestVal = val;
		bestIdx = i;
	}

	Engine.ProfileStop();

	debugWarn(hq.Config, 1, () => "we have found a base for " + resource + " with best (cut=" + cut + ") = " + bestVal);
	// not good enough.
	if (bestVal < cut)
	{
		return false;
	}
	return { bestIdx, obstructions: search.obstructions };
}

/**
 * Returns the best tile to build a new Civil Center
 * Whose primary function would be to assure territorial continuity with our allies;
 * "economic" when fewer than 2 allied CCs stand.
 */
export function findStrategicCCTile(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
): { bestIdx: number; obstructions: ReturnType<typeof createObstructionMap>; } | "economic" | undefined
{
	// This builds a map. The procedure is fairly simple.
	// We minimize the Sum((dist - 300)^2) where the sum is on the three nearest allied CC
	// with the constraints that all CC have dist > 200 and at least one have dist < 400
	// This needs at least 2 CC. Otherwise, go back to economic CC.

	const { ccList, numAllyCC } = alliedCivCentres(gameState);
	if (numAllyCC < 2)
	{
		return "economic";
	}

	Engine.ProfileStart("findStrategicCCLocation");

	// obstruction map
	const obstructions = createObstructionMap(gameState, NO_LAND, template);
	const halfSize = footprintHalves(template).halfSize;

	let bestIdx = -1;
	let bestVal = Infinity;
	const obstructionRadius = template.obstructionRadius();
	const radius = Math.ceil(obstructionRadius.max / obstructions.cellSize);

	// the distances to the three nearest allied civic centres (the second and third kept from the last cell, as Petra did)
	const nearest = { d0: Infinity, d1: Infinity, d2: Infinity };
	const favoredDistance = (template.hasClass("Colony") ? 220 : 280) - 40 * hq.Config.personality.defensive;

	// with enough room around to build the cc, accessible
	for (const { j, i, index } of freeTiles(hq.geography, gameState, radius, obstructions))
	{
		// checking distances to other cc
		const pos = cellCentre(hq.geography.territoryMap, j);
		const minDist = rankAllyCCs(ccList, pos, nearest);
		if (minDist < 1 || minDist > 170000 && !hq.geography.navalMap)
		{
			continue;
		}

		let currentVal = strategicValue(nearest, favoredDistance);
		// disfavor border of the map
		if (hq.geography.borderMap.map[j] & mapMask.fullBorder)
		{
			currentVal += 10000;
		}

		if (currentVal > bestVal)
		{
			continue;
		}
		if (hq.isContestedCCSpot(gameState, pos, index) || hq.isDangerousLocation(gameState, pos, halfSize))
		{
			continue;
		}
		bestVal = currentVal;
		bestIdx = i;
	}

	debugWarn(hq.Config, 1, () => "We've found a strategic base with bestVal = " + bestVal);

	Engine.ProfileStop();

	// Empty search: report it like the ref (petra/headquarters.js returns
	// undefined), so the caller's truthiness check (queueplanBuilding.ts:165)
	// falls through to the oversea-dock fallback instead of booking a civ
	// centre at (-1, -1), outside the map.
	if (bestIdx === -1)
	{
		return undefined;
	}
	return { bestIdx, obstructions };
}

/** The best market spot in our territory: its tile and the gain data of the farthest market from it. */
function bestMarketSpot(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
	markets: CommonEntity[],
	obstructions: ReturnType<typeof createObstructionMap>,
): { bestIdx: number; bestJdx: CellIndex<"territory">; bestVal: number; bestDistSq: number; bestGainMult: number; }
{
	const halfSize = footprintHalves(template).halfSize;
	let bestIdx = -1;
	let bestJdx = cellIndex(hq.geography.territoryMap, -1);
	let bestVal = -Infinity;
	let bestDistSq = 0;
	let bestGainMult = 0;
	const obstructionRadius = template.obstructionRadius();
	const radius = Math.ceil(obstructionRadius.max / obstructions.cellSize);
	const trade = {
		markets,
		naval: !!template.hasClasses(["Naval+Trade"]),
		gains: gameState.getTraderTemplatesGains(),
	};

	for (let jIndex = 0; jIndex < hq.geography.territoryMap.length; ++jIndex)
	{
		const j = cellIndex(hq.geography.territoryMap, jIndex);
		// do not try on the narrow border of our territory
		if (hq.geography.borderMap.map[j] & mapMask.narrowFrontier)
		{
			continue;
		}
		if (hq.basesManager.baseAtIndex(j) === NO_BASE)
		{ // only in our territory
			continue;
		}
		// with enough room around to build the market
		const tile = roomyTile(hq.geography, gameState, j, radius, obstructions);
		if (!tile)
		{
			continue;
		}
		const pos = cellCentre(hq.geography.territoryMap, j);
		// checking distances to other markets
		const best = farthestMarket(gameState, pos, tile.index, trade);
		if (best.val === 0)
		{
			continue;
		}
		if (best.val < bestVal)
		{
			continue;
		}
		if (hq.isDangerousLocation(gameState, pos, halfSize))
		{
			continue;
		}
		bestVal = best.val;
		bestDistSq = best.distSq;
		bestGainMult = best.gainMult;
		bestIdx = tile.i;
		bestJdx = j;
	}
	return { bestIdx, bestJdx, bestVal, bestDistSq, bestGainMult };
}

/** The chosen market position and gain, or false when the gain is too small to build one. */
function marketResult(
	hq: PlacementHQ,
	choice: {
		gameState: CommonGameState;
		template: CommonStructureTemplate;
		obstructions: ReturnType<typeof createObstructionMap>;
		bestIdx: number;
		bestJdx: CellIndex<"territory">;
		bestVal: number;
		bestDistSq: number;
		bestGainMult: number;
	},
): false | [number, number, BaseId | -1, number]
{
	const { gameState, template, obstructions, bestIdx, bestJdx, bestVal, bestDistSq, bestGainMult } = choice;
	debugWarn(hq.Config, 1, () => "We found a market position with bestVal = " + bestVal);
	if (bestVal === -Infinity)
	{ // no constraints. For the time being, place it arbitrarily by the ConstructionPlan
		return [-1, -1, -1, 0];
	}
	const expectedGain = Math.round(bestGainMult * TradeGain(bestDistSq, gameState.sharedScript.mapSize));
	debugWarn(hq.Config, 1, () => "this would give a trading gain of " + expectedGain);
	// Do not keep it if gain is too small, except if this is our first Market.
	let idx: BaseId | -1;
	if (expectedGain < hq.tradeManager.minimalGain)
	{
		if (template.hasClass("Market") && !gameState.getOwnEntitiesByClass("Market", true).hasEntities())
		{
			idx = -1; // Needed by queueplanBuilding manager to keep that Market.
		}
		else
		{
			return false;
		}
	}
	else
	{
		idx = hq.basesManager.baseAtIndex(bestJdx);
	}

	const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return [x, z, idx, expectedGain];
}

/**
 * Returns the best position to build a new market: if the allies already have a market, build it as far as possible
 * from it, although not in our border to be able to defend it easily. If no allied market, our second market will
 * follow the same logic.
 * To do so, we suppose that the gain/distance is an increasing function of distance and look for the max distance
 * for performance reasons.
 */
/** [x, z, base, expected gain]; base -1 (and x, z -1) when the market goes where the standard placement puts it */
export function findMarketSpot(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
): false | [number, number, BaseId | -1, number]
{
	const markets = tradeMarkets(gameState);
	if (!markets.length)
	{ // this is the first market. For the time being, place it arbitrarily by the ConstructionPlan
		return [-1, -1, -1, 0];
	}

	// No need for more than one market when we cannot trade.
	if (!Resources.GetTradableCodes().length)
	{
		return false;
	}

	// obstruction map
	const obstructions = createObstructionMap(gameState, NO_LAND, template);

	const { bestIdx, bestJdx, bestVal, bestDistSq, bestGainMult } = bestMarketSpot(
		hq,
		gameState,
		template,
		markets,
		obstructions,
	);
	return marketResult(hq, { gameState, template, obstructions, bestIdx, bestJdx, bestVal, bestDistSq, bestGainMult });
}

/**
 * Whether a cell may hold a defense: one of a base of ours, and on our frontier (do not try if well inside or
 * outside territory; a tower not on the large frontier) unless we guard a wonder
 */
function defensiveCell(hq: PlacementHQ, j: CellIndex<"territory">, guardingWonder: boolean, isTower: boolean): boolean
{
	const border = hq.geography.borderMap.map[j];
	if (!guardingWonder && (!(border & mapMask.fullFrontier) || border & mapMask.largeFrontier && isTower))
	{
		return false;
	}
	return hq.basesManager.baseAtIndex(j) !== NO_BASE; // inaccessible cell
}

/**
 * Returns the best position to build defensive buildings (fortress and towers)
 * Whose primary function is to defend our borders
 */
export function findDefensiveSpot(
	hq: PlacementHQ,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
): [number, number, BaseId] | undefined
{
	// We take the point in our territory which is the nearest to any enemy cc
	// but requiring a minimal distance with our other defensive structures
	// and not in range of any enemy defensive structure to avoid building under fire.

	const ownStructures = gameState.getOwnStructures().filter(filters.byClasses(["Fortress", "Tower"])).toEntityArray();
	const enemyStructures = structuresToFace(gameState);
	if (!enemyStructures)
	{
		return undefined;
	}
	const wonder = wonderToGuard(gameState);

	// obstruction map
	const obstructions = createObstructionMap(gameState, NO_LAND, template);
	const halfSize = footprintHalves(template).halfSize;

	let bestIdx = -1;
	let bestJdx = cellIndex(hq.geography.territoryMap, -1);
	let bestVal = Infinity;

	const isTower = template.hasClass("Tower");
	const obstructionRadius = template.obstructionRadius();
	const radius = template.hasClass("Fortress") ?
		Math.floor((obstructionRadius.max + 8) / obstructions.cellSize) :
		Math.ceil(obstructionRadius.max / obstructions.cellSize);

	for (let jIndex = 0; jIndex < hq.geography.territoryMap.length; ++jIndex)
	{
		const j = cellIndex(hq.geography.territoryMap, jIndex);
		if (!defensiveCell(hq, j, !!wonder, !!isTower))
		{
			continue;
		}
		// with enough room around to build the cc
		const i = hq.geography.territoryMap.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
		{
			continue;
		}

		const pos = cellCentre(hq.geography.territoryMap, j);
		// checking distances to other structures
		const minDist = defenseSpotValue(pos, wonder, enemyStructures, ownStructures);
		if (minDist === undefined)
		{
			continue;
		}
		if (minDist > bestVal)
		{
			continue;
		}
		if (hq.isDangerousLocation(gameState, pos, halfSize))
		{
			continue;
		}
		bestVal = minDist;
		bestIdx = i;
		bestJdx = j;
	}

	if (bestVal === Infinity)
	{
		return undefined;
	}

	const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
	const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;
	return [x, z, hq.basesManager.baseAtIndex(bestJdx)];
}

/**
 * The spot of our territory where a tower would reach the most of the
 * enemy's ship traffic (world/shipTraffic.ts), the stretches our towers
 * already watch counting a third: on naval maps, some passages are used a
 * lot by ships and others barely (FINDINGS §38). Undefined below
 * SHORE_TOWER_TRAFFIC ship-seconds in reach, or off naval maps; a spot
 * keeps the distances of findDefensiveLocation (30 m from our towers and
 * fortresses, 80 m from the enemy's defenses) and is not dangerous.
 */
export function findShoreTowerSpot(
	hq: PlacementHQ,
	traffic: ShipTraffic,
	gameState: CommonGameState,
	template: CommonStructureTemplate,
): [number, number, BaseId] | undefined
{
	const range = template.attackRange("Ranged")?.max ?? DEFAULT_TOWER_RANGE;
	const ownDefenses = gameState.getOwnStructures().filter(filters.byClasses(["Fortress", "Tower"])).toEntityArray()
		.map((ent) => ent.position()).filter((pos) => pos !== undefined);
	const enemyDefenses = gameState.getEnemyStructures().filter(filters.not(filters.byOwner(GAIA))).filter(
		filters.byClasses(["CivCentre", "Fortress", "Tower"]),
	).toEntityArray().map((ent) => ent.position()).filter((pos) => pos !== undefined);
	const map = hq.geography.territoryMap;
	const width = map.width;
	const cellSize = map.cellSize;
	let obstructions: ReturnType<typeof createObstructionMap> | undefined;
	let best = SHORE_TOWER_TRAFFIC;
	let found: [number, number, BaseId] | undefined;
	for (let jIndex = 0; jIndex < map.length; ++jIndex)
	{
		const j = cellIndex(map, jIndex);
		if (map.getOwnerIndex(j) !== PlayerID)
		{
			continue;
		}
		const pos: CommonPosition = worldPos(cellSize * (j % width + 0.5), cellSize * (Math.floor(j / width) + 0.5));
		if (map.isBlinking(pos))
		{
			continue;
		}
		const score = traffic.within(pos, range, ownDefenses);
		if (score <= best)
		{
			continue;
		}
		if (
			ownDefenses.some((other) => SquareVectorDistance(other, pos) < 900) ||
			enemyDefenses.some((other) => SquareVectorDistance(other, pos) < 6400)
		)
		{
			continue;
		}
		const base = hq.basesManager.baseAtIndex(j);
		if (base === NO_BASE)
		{
			continue;
		}
		obstructions ??= createObstructionMap(gameState, NO_LAND, template);
		const radius = Math.ceil(template.obstructionRadius().max / obstructions.cellSize);
		const i = map.getNonObstructedTile(j, radius, obstructions);
		if (i < 0)
		{
			continue;
		}
		// the free tile found may lie off the cell's centre: the traffic counted from where the tower stands
		const spot = worldPos(
			(i % obstructions.width + 0.5) * obstructions.cellSize,
			(Math.floor(i / obstructions.width) + 0.5) * obstructions.cellSize,
		);
		const spotScore = traffic.within(spot, range, ownDefenses);
		if (spotScore <= best || hq.isDangerousLocation(gameState, spot, footprintHalves(template).halfSize))
		{
			continue;
		}
		best = spotScore;
		found = [spot[0], spot[1], base];
	}
	return found;
}
