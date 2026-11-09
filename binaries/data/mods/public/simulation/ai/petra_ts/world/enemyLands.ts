/**
 * The enemies on each land (PLAN.md §3.4, world/): each land's enemy soldiers,
 * heroes, siege engines and buildings, counted once a turn, for where our
 * soldiers have enemies beside them (FINDINGS §34). Owned by the headquarters
 * (HQ.enemyLands) and read as `gameState.ai.enemyLands`; not saved, it is
 * counted again on the turn it is asked.
 */
import { GAIA } from "../adapter/brands.ts";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";

export class EnemyLands
{
	/** byLand's answer and the turn it was counted on */
	private enemyLands = new Map<AccessIndex, CommonPlacedEntity[]>();
	private enemyLandsTurn = -1;

	/**
	 * Each land's enemy soldiers, heroes, siege engines and buildings (not
	 * gaia's, no ships), counted once a turn: where our soldiers have enemies
	 * beside them (FINDINGS §34).
	 */
	byLand(gameState: CommonGameState): ReadonlyMap<AccessIndex, readonly CommonPlacedEntity[]>
	{
		if (this.enemyLandsTurn === gameState.ai.playedTurn)
		{
			return this.enemyLands;
		}
		this.enemyLandsTurn = gameState.ai.playedTurn;
		this.enemyLands = new Map();
		for (const enemy of gameState.getEnemyEntities().values())
		{
			if (
				enemy.owner() === GAIA || !isPlaced(enemy) || enemy.hasClass("Ship") ||
				!enemy.hasClasses(["Soldier", "Hero", "Siege", "Structure"])
			)
			{
				continue;
			}
			// 1 marks an impassable cell (a cliff's edge, the map's), no land
			const land = getLandAccess(gameState, enemy);
			if (land === undefined || land <= 1)
			{
				continue;
			}
			const list = this.enemyLands.get(land);
			if (list)
			{
				list.push(enemy);
			}
			else
			{
				this.enemyLands.set(land, [enemy]);
			}
		}
		return this.enemyLands;
	}
}
