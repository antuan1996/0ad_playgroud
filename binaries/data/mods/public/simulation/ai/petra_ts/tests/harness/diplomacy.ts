/**
 * The players of a game and how each sees the others.
 *
 * `setPlayers` fills, for every player, the row the engine hands the AI
 * (sharedScript.playersData[i]: state, civ, name, team lock, resources,
 * population, and the isAlly/isMutualAlly/isNeutral/isEnemy arrays), points
 * our gameState.playerData at our own row, and installs the common-api
 * GameState diplomacy helpers that read them (gamestate.js: hasAllies,
 * hasEnemies, hasNeutrals, getEnemies, getMutualAllies, isPlayerAlly, ...)
 * exactly as defined there.
 */
import type { World } from "./world.ts";

export type Stance = "ally" | "neutral" | "enemy";

export interface PlayerSpec
{
	/** how this player sees the others, keyed by player id; enemy by default */
	towards?: Record<number, Stance>;
	civ?: string;
	state?: string;
	teamLocked?: boolean;
	resourceCounts?: Record<string, number>;
	popCount?: number;
}

export interface PlayerRow
{
	state: string;
	civ: string;
	name: string;
	teamLocked: boolean;
	resourceCounts: Record<string, number>;
	popCount: number;
	isAlly: boolean[];
	isMutualAlly: boolean[];
	isNeutral: boolean[];
	isEnemy: boolean[];
}

/**
 * Seat the given players (index = player id, 0 is gaia). A player is its own
 * ally; gaia and every pair left unsaid are enemies.
 */
export function setPlayers(world: World, players: PlayerSpec[], us = 1): PlayerRow[]
{
	const n = players.length;
	const stance = (i: number, j: number): Stance =>
		i === j ? "ally" : i === 0 || j === 0 ? "enemy" : players[i].towards?.[j] ?? "enemy";
	const rows: PlayerRow[] = players.map((spec, i) => ({
		"state": spec.state ?? "active",
		"civ": spec.civ ?? "athen",
		"name": "Player " + i,
		"teamLocked": spec.teamLocked ?? false,
		"resourceCounts": { "food": 0, "wood": 0, "stone": 0, "metal": 0, ...spec.resourceCounts },
		"popCount": spec.popCount ?? 0,
		"isAlly": [...Array(n).keys()].map((j) => stance(i, j) === "ally"),
		"isMutualAlly": [...Array(n).keys()].map((j) => stance(i, j) === "ally" && stance(j, i) === "ally"),
		"isNeutral": [...Array(n).keys()].map((j) => stance(i, j) === "neutral"),
		"isEnemy": [...Array(n).keys()].map((j) => stance(i, j) === "enemy")
	}));

	const gs = world.gameState;
	Object.assign(gs.sharedScript, { "playersData": rows });
	Object.assign(gs.playerData, {
		"civ": rows[us].civ, "isAlly": rows[us].isAlly, "isMutualAlly": rows[us].isMutualAlly,
		"isNeutral": rows[us].isNeutral, "isEnemy": rows[us].isEnemy, "teamLocked": rows[us].teamLocked
	});
	const own = () => rows[us];
	const defeated = (i: number | string) => rows[+i].state === "defeated";
	Object.assign(gs, {
		"isPlayerAlly": (id: number) => own().isAlly[id],
		"isPlayerMutualAlly": (id: number) => own().isMutualAlly[id],
		"isPlayerNeutral": (id: number) => own().isNeutral[id],
		"isPlayerEnemy": (id: number) => own().isEnemy[id],
		"hasAllies": () => own().isAlly.some((a, i) => a && i !== us && !defeated(i)),
		"hasEnemies": () => own().isEnemy.some((e, i) => e && i !== 0 && !defeated(i)),
		"hasNeutrals": () => own().isNeutral.some((ne, i) => ne && !defeated(i)),
		"getEnemies": () => own().isEnemy.flatMap((e, i) => e ? [i] : []),
		"getMutualAllies": () => own().isMutualAlly.flatMap((a, i) => a && rows[i].isMutualAlly[us] ? [i] : []),
		"getNumPlayerEnemies": () => own().isEnemy.filter((e, i) => e && i > 0 && !defeated(i)).length,
		"getPlayerCiv": (player?: number) => player === undefined ? own().civ : rows[player].civ
	});
	return rows;
}
