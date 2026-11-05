import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import { playerId } from "../adapter/brands.ts";
import { getLandAccess } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { AttackPlan } from "../execution/attackPlan.ts";

/** The attack manager's memory of whom it fights: the defeated, and the foe it last chose. */
export type EnemyTargeting = { defeated: Record<number, boolean>; currentEnemyPlayer: PlayerId | undefined; };

/** The enemy civic centre nearest to one of ours on its land, of a player not vetoed */
function nearestEnemyCivCentre(gameState: CommonGameState, veto: Record<number, boolean>): CommonEntity | undefined
{
	let distmin;
	let ccmin;
	const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre"));
	for (const ourcc of ccEnts.values())
	{
		if (ourcc.owner() !== PlayerID || !isPlaced(ourcc))
		{
			continue;
		}
		const ourPos = ourcc.position();
		const access = getLandAccess(gameState, ourcc);
		for (const enemycc of ccEnts.values())
		{
			if (veto[enemycc.owner()])
			{
				continue;
			}
			if (!gameState.isPlayerEnemy(enemycc.owner()))
			{
				continue;
			}
			if (!isPlaced(enemycc) || access !== getLandAccess(gameState, enemycc))
			{
				continue;
			}
			const dist = SquareVectorDistance(ourPos, enemycc.position());
			if (distmin && dist > distmin)
			{
				continue;
			}
			ccmin = enemycc;
			distmin = dist;
		}
	}
	return ccmin;
}

/** The enemy not vetoed with the most entities, one with a civic centre first */
function strongestEnemy(gameState: CommonGameState, veto: Record<number, boolean>): PlayerId | undefined
{
	let enemyPlayer;
	let max = 0;
	for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (veto[i])
		{
			continue;
		}
		if (!gameState.isPlayerEnemy(i))
		{
			continue;
		}
		let enemyCount = 0;
		let enemyCivCentre = false;
		for (const ent of gameState.getEntities(i).values())
		{
			enemyCount++;
			if (ent.hasClass("CivCentre"))
			{
				enemyCivCentre = true;
			}
		}
		if (enemyCivCentre)
		{
			enemyCount += 500;
		}
		if (!enemyCount || enemyCount < max)
		{
			continue;
		}
		max = enemyCount;
		enemyPlayer = i;
	}
	return enemyPlayer;
}

/** Whether a player is still an enemy, not defeated, with entities left */
function stillToFight(gameState: CommonGameState, targeting: EnemyTargeting, player: PlayerId): boolean
{
	return !targeting.defeated[player] && gameState.isPlayerEnemy(player) &&
		gameState.getEntities(player).hasEntities();
}

/** The players not to attack: the defeated, and for a rush those too well defended (i.e. iberians) */
function vetoedPlayers(
	gameState: CommonGameState,
	attack: AttackPlan,
	targeting: EnemyTargeting,
): Record<number, boolean>
{
	const veto: Record<number, boolean> = {};
	for (const i in targeting.defeated)
	{
		veto[i] = true;
	}
	if (attack.type !== AttackPlan.TYPE_RUSH)
	{
		return veto;
	}
	for (let iIndex = 1; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (!gameState.isPlayerEnemy(i) || veto[i])
		{
			continue;
		}
		if (targeting.defeated[i])
		{
			continue;
		}
		let enemyDefense = 0;
		for (const ent of gameState.getEnemyStructures(i).values())
		{
			if (ent.hasClasses(["Tower", "WallTower", "Fortress"]))
			{
				enemyDefense++;
			}
		}
		if (enemyDefense > 6)
		{
			veto[i] = true;
		}
	}
	return veto;
}

/**
 * Target the player with the most advanced wonder.
 * TODO currently the first built wonder is kept, should chek on the minimum wonderDuration left instead.
 */
function wonderEnemyPlayer(
	gameState: CommonGameState,
	attack: AttackPlan,
	targeting: EnemyTargeting,
): PlayerId | undefined
{
	let enemyPlayer;
	let enemyWonder;
	let moreAdvanced;
	for (const wonder of gameState.getEnemyStructures().filter(filters.byClass("Wonder")).values())
	{
		if (wonder.owner() === 0)
		{
			continue;
		}
		const progress = wonder.foundationProgress();
		if (progress === undefined)
		{
			enemyWonder = wonder;
			break;
		}
		// only remember this wonder if it is the most advanced one so far
		if (moreAdvanced === undefined || progress >= moreAdvanced)
		{
			enemyWonder = wonder;
			moreAdvanced = progress;
		}
	}
	if (enemyWonder)
	{
		enemyPlayer = enemyWonder.owner();
		if (attack.targetPlayer === undefined)
		{
			targeting.currentEnemyPlayer = enemyPlayer;
		}
	}
	return enemyPlayer;
}

/**
 * Determine which player should be attacked: when called when starting the attack,
 * attack.targetPlayer is undefined and in that case, we keep track of the chosen target
 * for future attacks.
 */
export function getEnemyPlayer(
	gameState: CommonGameState,
	attack: AttackPlan,
	targeting: EnemyTargeting,
): PlayerId | undefined
{
	let enemyPlayer;

	// First check if there is a preferred enemy based on our victory conditions.
	// If both wonder and relic, choose randomly between them TODO should combine decisions

	if (gameState.getVictoryConditions().has("wonder"))
	{
		enemyPlayer = wonderEnemyPlayer(gameState, attack, targeting);
	}

	if (gameState.getVictoryConditions().has("capture_the_relic"))
	{
		if (!enemyPlayer || randBool())
		{
			enemyPlayer = getRelicEnemyPlayer(gameState, attack, targeting) || enemyPlayer;
		}
	}

	if (enemyPlayer)
	{
		return enemyPlayer;
	}

	const veto = vetoedPlayers(gameState, attack, targeting);

	// then if not a huge attack, continue attacking our previous target as long as it has some entities,
	// otherwise target the most accessible one
	if (attack.type !== AttackPlan.TYPE_HUGE_ATTACK)
	{
		if (
			attack.targetPlayer === undefined && targeting.currentEnemyPlayer !== undefined &&
			stillToFight(gameState, targeting, targeting.currentEnemyPlayer)
		)
		{
			return targeting.currentEnemyPlayer;
		}

		const ccmin = nearestEnemyCivCentre(gameState, veto);
		if (ccmin)
		{
			enemyPlayer = ccmin.owner();
			if (attack.targetPlayer === undefined)
			{
				targeting.currentEnemyPlayer = enemyPlayer;
			}
			return enemyPlayer;
		}
	}

	// then let's target our strongest enemy (basically counting enemies units)
	// with priority to enemies with civ center
	enemyPlayer = strongestEnemy(gameState, veto);
	if (attack.targetPlayer === undefined)
	{
		targeting.currentEnemyPlayer = enemyPlayer;
	}
	return enemyPlayer;
}

/**
 * Target the player with the most relics (including gaia).
 */
export function getRelicEnemyPlayer(
	gameState: CommonGameState,
	attack: AttackPlan,
	targeting: EnemyTargeting,
): PlayerId | undefined
{
	let enemyPlayer;
	const allRelics = gameState.updatingGlobalCollection("allRelics", filters.byClass("Relic"));
	let maxRelicsOwned = 0;
	for (let iIndex = 0; iIndex < gameState.sharedScript.playersData.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (
			!gameState.isPlayerEnemy(i) || targeting.defeated[i] ||
			i === 0 && !gameState.ai.HQ.victoryManager.tryCaptureGaiaRelic
		)
		{
			continue;
		}

		const relicsCount = allRelics.filter((relic) => relic.owner() === i).length;
		if (relicsCount <= maxRelicsOwned)
		{
			continue;
		}
		maxRelicsOwned = relicsCount;
		enemyPlayer = i;
	}
	if (enemyPlayer !== undefined)
	{
		if (attack.targetPlayer === undefined)
		{
			targeting.currentEnemyPlayer = enemyPlayer;
		}
		if (enemyPlayer === 0)
		{
			gameState.ai.HQ.victoryManager.resetCaptureGaiaRelic(gameState);
		}
	}
	return enemyPlayer;
}
