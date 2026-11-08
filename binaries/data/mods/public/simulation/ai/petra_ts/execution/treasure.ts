/**
 * Treasure: sending a collector to the nearest treasure it may reach (the headquarters' list of treasures and its
 * territory map, through the execution layer's view). Moved from adapter/, which may read no AI state.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { getLandAccess, getSeaAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { hqOf } from "./hq.ts";

export function gatherTreasure(
	gameState: CommonGameState,
	ent: CommonEntity | undefined,
	water: boolean = false,
): boolean
{
	if (!hqOf(gameState).treasures.hasEntities())
	{
		return false;
	}
	if (!ent || !isPlaced(ent))
	{
		return false;
	}
	if (!ent.isTreasureCollector())
	{
		return false;
	}
	let treasureFound;
	let distmin = Math.min();
	const access = water ? getSeaAccess(gameState, ent) : getLandAccess(gameState, ent);
	for (const treasure of hqOf(gameState).treasures.values())
	{
		const dist = treasureDistance(gameState, ent, treasure, access, water);
		if (dist === undefined || dist > distmin)
		{
			continue;
		}
		distmin = dist;
		treasureFound = treasure;
	}
	if (!treasureFound)
	{
		return false;
	}
	treasureFound.setMetadata(PlayerID, "lastGathered", gameState.ai.elapsedTime);
	ent.collectTreasure(treasureFound);
	ent.setMetadata(PlayerID, "treasure", treasureFound.id());
	return true;
}

/** The square distance from ent to a treasure it may go for, or undefined. */
function treasureDistance(
	gameState: CommonGameState,
	ent: CommonPlacedEntity,
	treasure: CommonPlacedEntity,
	access: number | undefined,
	water: boolean,
): number | undefined
{
	// let some time for the previous gatherer to reach the treasure before trying again
	const lastGathered = treasure.getMetadata(PlayerID, "lastGathered");
	if (lastGathered && gameState.ai.elapsedTime - lastGathered < 20)
	{
		return undefined;
	}
	if (!water && access !== getLandAccess(gameState, treasure))
	{
		return undefined;
	}
	if (water && access !== getSeaAccess(gameState, treasure))
	{
		return undefined;
	}
	const territoryOwner = hqOf(gameState).geography.territoryMap.getOwner(treasure.position());
	if (territoryOwner !== 0 && !gameState.isPlayerAlly(territoryOwner))
	{
		return undefined;
	}
	const dist = SquareVectorDistance(ent.position(), treasure.position());
	if (dist > 120000 || territoryOwner !== PlayerID && dist > 14000)
	{ // AI has no LOS, so restrict it a bit
		return undefined;
	}
	return dist;
}
