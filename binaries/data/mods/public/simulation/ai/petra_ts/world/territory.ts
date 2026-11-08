/**
 * Our territory and the enemies' as the AI's model reads them (world/geography.ts's territory map, through
 * `gameState.ai.geography`). Moved from adapter/, which may read no AI state.
 */
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { worldPos } from "../adapter/brands.ts";

/**
 * return true if it is not worth finishing this building (it would surely decay)
 * TODO implement the other conditions
 */
export function isNotWorthBuilding(gameState: CommonGameState, ent: CommonPlacedEntity): boolean
{
	if (gameState.ai.geography.territoryMap.getOwner(ent.position()) !== PlayerID)
	{
		const buildTerritories = ent.buildTerritories();
		if (
			buildTerritories &&
			(!buildTerritories.length || buildTerritories.length === 1 && buildTerritories[0] === "own")
		)
		{
			return true;
		}
	}
	return false;
}

/**
 * Check if the straight line between the two positions crosses an enemy territory
 */
export function isLineInsideEnemyTerritory(
	gameState: CommonGameState,
	pos1: CommonPosition,
	pos2: CommonPosition,
	step: number = 70,
): boolean
{
	const n = Math.floor(Math.sqrt(SquareVectorDistance(pos1, pos2)) / step) + 1;
	const stepx = (pos2[0] - pos1[0]) / n;
	const stepy = (pos2[1] - pos1[1]) / n;
	for (let i = 1; i < n; ++i)
	{
		const pos: CommonPosition = worldPos(pos1[0] + i * stepx, pos1[1] + i * stepy);
		const owner = gameState.ai.geography.territoryMap.getOwner(pos);
		if (owner && gameState.isPlayerEnemy(owner))
		{
			return true;
		}
	}
	return false;
}
