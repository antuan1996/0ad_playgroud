export const CC_ENEMY_AVOID = 150;

/**
 * Where to build (moved out of decision/headquarters.ts; the scoring helpers are decision/placement.ts): a new
 * civic centre for the economy or for strategy, a market, a defensive structure, a shore tower, the base for a
 * military building. Owned by the headquarters (HQ.placement) and given to the execution layer as
 * execution/services.ts's PlacementService (gameState.ai.placement).
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { GAIA, cellIndex, worldPos } from "../adapter/brands.ts";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { isStructureTemplate } from "../adapter/templateData.ts";
import * as mapMask from "../world/mapMask.ts";
import type { Headquarters } from "./headquarters.ts";
import {
	findDefensiveSpot,
	findEconomicCCTile,
	findMarketSpot,
	findShoreTowerSpot,
	findStrategicCCTile,
	type EconomicCCOptions,
} from "./placement.ts";

export class PlacementSearches
{
	readonly hq: Headquarters;

	constructor(hq: Headquarters)
	{
		this.hq = hq;
	}

	/**
	 * Returns the best position to build a new Civil Center
	 * Whose primary function would be to reach new resources of type "resource".
	 */
	findEconomicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		resource: string,
		options: EconomicCCOptions = {},
	): false | CommonPosition
	{
		const spot = findEconomicCCTile(this.hq, gameState, template, { resource, options, allowContested: false }) ||
			(options.forRoom ?
				findEconomicCCTile(this.hq, gameState, template, { resource, options, allowContested: true }) :
				false);
		return spot ? this.newBaseAt(gameState, spot.bestIdx, spot.obstructions) : false;
	}

	/** A new base's position at an obstruction tile; a minimal number of wanted ships in the seas reaching it */
	private newBaseAt(
		gameState: CommonGameState,
		bestIdx: number,
		obstructions: { width: number; cellSize: number; },
	): CommonPosition
	{
		const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

		const indexIdx = gameState.ai.accessibility.landPassMap[bestIdx];
		for (const base of this.hq.basesManager.baseManagers)
		{
			if (!base.anchor || base.accessIndex === undefined || base.accessIndex === indexIdx)
			{
				continue;
			}
			const sea = this.hq.town.getSeaBetweenIndices(gameState, base.accessIndex, indexIdx);
			if (sea !== undefined)
			{
				this.hq.navalManager.setMinimalTransportShips(gameState, sea, 1);
			}
		}

		return worldPos(x, z);
	}

	/**
	 * Returns the best position to build a new Civil Center
	 * Whose primary function would be to assure territorial continuity with our allies
	 */
	findStrategicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | CommonPosition | undefined
	{
		const spot = findStrategicCCTile(this.hq, gameState, template);
		if (spot === "economic")
		{
			return this.findEconomicCCLocation(gameState, template, "wood", { fromStrategic: true });
		}
		return spot && this.newBaseAt(gameState, spot.bestIdx, spot.obstructions);
	}

	/** [x, z, base, expected gain]; base -1 (and x, z -1) when the market goes where the standard placement puts it */
	findMarketLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | [number, number, BaseId | -1, number]
	{
		return this.hq.tradeManager.minimalGain >= 0 ? findMarketSpot(this.hq, gameState, template) : false;
	}

	/**
	 * Returns the best position to build defensive buildings (fortress and towers)
	 * Whose primary function is to defend our borders
	 */
	findDefensiveLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined
	{
		if (template.hasClass("Tower"))
		{
			const shore = this.findShoreTowerLocation(gameState, template);
			if (shore || this.towersByTrafficOnly(gameState))
			{
				return shore;
			}
		}
		return findDefensiveSpot(this.hq, gameState, template);
	}

	/**
	 * Whether our towers go only where the enemy's ships pass: on a naval map,
	 * no enemy civic centre on a land of one of our bases. A tower stands 60 m
	 * from any other (its template's BuildRestrictions), and on small islands
	 * the early ones, put up facing an enemy town across the sea before any
	 * ship had sailed, left no room for one over the passages (FINDINGS §38).
	 */
	towersByTrafficOnly(gameState: CommonGameState): boolean
	{
		if (!this.hq.shipTraffic)
		{
			return false;
		}
		const ourLands = new Set(this.hq.basesManager.baseManagers.map((base) => base.accessIndex));
		for (const centre of gameState.getEnemyStructures().filter(filters.byClass("CivCentre")).values())
		{
			if (centre.owner() !== GAIA && ourLands.has(getLandAccess(gameState, centre)))
			{
				return false;
			}
		}
		return true;
	}

	/** Whether a civic centre spot is remembered as failed (followCivCentreOrders). */
	isAvoidedCCSpot(pos: CommonPosition): boolean
	{
		return this.hq.ccSpotsAvoided.some((spot) =>
			SquareVectorDistance(spot.pos, pos) < CC_SPOT_AVOID * CC_SPOT_AVOID
		);
	}

	isContestedCCSpot(gameState: CommonGameState, pos: CommonPosition, land: AccessIndex): boolean
	{
		if (this.isAvoidedCCSpot(pos))
		{
			return true;
		}
		const enemies = this.hq.attackManager.enemiesByLand(gameState).get(land);
		if (!enemies)
		{
			return false;
		}
		if (
			enemies.some((enemy) => enemy.hasClass("Structure")) &&
			!this.hq.basesManager.baseManagers.some((base) => base.accessIndex === land && base.anchor)
		)
		{
			return true;
		}
		return enemies.some((enemy) =>
		{
			const at = enemy.position();
			return !enemy.hasClass("Structure") && !!at &&
				SquareVectorDistance(at, pos) < CC_ENEMY_AVOID * CC_ENEMY_AVOID;
		});
	}

	/** Whether a tower of this template has a spot on a shore the enemy's ships pass (findShoreTowerLocation). */
	hasShoreTowerSpot(gameState: CommonGameState, templateName: string): boolean
	{
		const template = gameState.getTemplate(gameState.applyCiv(templateName));
		return !!template && isStructureTemplate(template) &&
			this.findShoreTowerLocation(gameState, template) !== undefined;
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
	findShoreTowerLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined
	{
		return this.hq.shipTraffic ? findShoreTowerSpot(this.hq, this.hq.shipTraffic, gameState, template) : undefined;
	}

	/**
	 *  Find base nearest to ennemies for military buildings.
	 */
	findBestBaseForMilitary(gameState: CommonGameState): number | undefined
	{
		return bestBaseForMilitary(gameState);
	}

	/**
	 * Whether a cell of ours lies on the frontier: narrow, a cell not ours (nor an ally's in an allied victory)
	 * within 45 m, or large, within 80 m
	 */
	frontierAt(
		gameState: CommonGameState,
		j: CellIndex<"territory">,
		ring: { around: number[][]; alliedVictory: boolean; insideSmall: number; insideLarge: number; },
	): { narrow: boolean; onFrontier: boolean; }
	{
		const width = this.hq.geography.territoryMap.width;
		const ix = j % width;
		const iz = Math.floor(j / width);
		const foreignAt = (distance: number, a: number[]): boolean | undefined =>
		{
			const jx = ix + Math.round(distance * a[0]);
			if (jx < 0 || jx >= width)
			{
				return undefined;
			}
			const jz = iz + Math.round(distance * a[1]);
			if (jz < 0 || jz >= width)
			{
				return undefined;
			}
			if (this.hq.geography.borderMap.map[jx + width * jz] & mapMask.outside)
			{
				return undefined;
			}
			const territoryOwner = this.hq.geography.territoryMap.getOwnerIndex(
				cellIndex(this.hq.geography.territoryMap, jx + width * jz),
			);
			return territoryOwner !== PlayerID && !(ring.alliedVictory && gameState.isPlayerAlly(territoryOwner));
		};
		let onFrontier = false;
		for (const a of ring.around)
		{
			const small = foreignAt(ring.insideSmall, a);
			if (small === undefined)
			{
				continue;
			}
			if (small)
			{
				return { narrow: true, onFrontier };
			}
			if (foreignAt(ring.insideLarge, a))
			{
				onFrontier = true;
			}
		}
		return { narrow: false, onFrontier };
	}
}

/** Find the base nearest to an enemy civic centre, for military buildings. */
function bestBaseForMilitary(gameState: CommonGameState): number | undefined
{
	const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")).toEntityArray();
	let bestBase;
	let enemyFound = false;
	let distMin = Math.min();
	for (const cce of ccEnts)
	{
		if (!isPlaced(cce) || gameState.isPlayerAlly(cce.owner()))
		{
			continue;
		}
		if (enemyFound && !gameState.isPlayerEnemy(cce.owner()))
		{
			continue;
		}
		const access = getLandAccess(gameState, cce);
		const isEnemy = gameState.isPlayerEnemy(cce.owner());
		for (const cc of ccEnts)
		{
			if (cc.owner() !== PlayerID || !isPlaced(cc))
			{
				continue;
			}
			if (getLandAccess(gameState, cc) !== access)
			{
				continue;
			}
			const dist = SquareVectorDistance(cc.position(), cce.position());
			if (!enemyFound && isEnemy)
			{
				enemyFound = true;
			}
			else if (dist > distMin)
			{
				continue;
			}
			bestBase = cc.getMetadata(PlayerID, "base");
			distMin = dist;
		}
	}
	return bestBase;
}

/** Metres around such a spot avoided, and around enemy soldiers. */
const CC_SPOT_AVOID = 80;
