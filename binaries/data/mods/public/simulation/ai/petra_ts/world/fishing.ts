/**
 * Where fish may be caught (PLAN.md §3.4, world/): the sea a shoal lies in
 * (noted on it once, with whether it lies in open sea), and whether no enemy
 * territory reaches it. The naval manager counts the fish of each sea with
 * them; the fishers ask them through the town's fishing
 * (execution/fishingDesk.ts).
 */
import { cellIndex } from "../adapter/brands.ts";

const FISH_RAYS = [[-0.7, 0.7], [0, 1], [0.7, 0.7], [1, 0], [0.7, -0.7], [0, -1], [-0.7, -0.7], [-1, 0]];

/** The cell index of the t-th of ntry steps towards pos from radius*ntry cells in direction a, or undefined off the map */
function ringCell(
	ring: { pos: number[]; radius: number; ntry: number; width: number; },
	a: number[],
	t: number,
): number | undefined
{
	const { pos, radius, ntry, width } = ring;
	const i = pos[0] + Math.round(a[0] * radius * (ntry - t));
	const j = pos[1] + Math.round(a[1] * radius * (ntry - t));
	if (i < 0 || i >= width || j < 0 || j >= width)
	{
		return undefined;
	}
	return i + j * width;
}

/** Whether every ray of ntry steps from 120 m out towards fishPos satisfies checkCell */
function everyFishRay(
	map: { cellSize: number; width: number; gamePosToMapPos(pos: CommonPosition): MapPos; },
	fishPos: CommonPosition,
	ntry: number,
	checkCell: (cell: number) => "pass" | "next" | "fail",
): boolean
{
	const pos = map.gamePosToMapPos(fishPos);
	const width = map.width;
	const radius = 120 / map.cellSize / ntry;
	return FISH_RAYS.every((a) =>
	{
		for (let t = 0; t < ntry; ++t)
		{
			const cell = ringCell({ pos, radius, ntry, width }, a, t);
			if (cell === undefined)
			{
				continue;
			}
			const step = checkCell(cell);
			if (step !== "next")
			{
				return step === "pass";
			}
		}
		return true;
	});
}

/** Get the sea a fish is in, cache it, and check whether it lies in open sea */
export function fishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
{
	let sea = fish.getMetadata(PlayerID, "sea");
	if (sea)
	{
		return sea;
	}
	const access = gameState.ai.accessibility;
	const pos = access.gamePosToMapPos(fish.position());
	const k = pos[0] + pos[1] * access.width;
	sea = access.navalPassMap[k];
	fish.setMetadata(PlayerID, "sea", sea);
	if (
		everyFishRay(access, fish.position(), 4, (cell) =>
		{
			if (access.landPassMap[cell] !== 1)
			{
				return "fail";
			}
			const navalPass = access.navalPassMap[cell];
			return navalPass === sea ? "pass" : navalPass === 1 ? "next" : "fail";
		})
	)
	{
		fish.setMetadata(PlayerID, "opensea", true);
	}
	return sea;
}

/** Whether no enemy territory lies near a fish */
export function fishIsSafe(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
{
	if (fish.getMetadata(PlayerID, "opensea"))
	{
		return true;
	}
	const territoryMap = gameState.ai.geography.territoryMap;
	return everyFishRay(territoryMap, fish.position(), 2, (cell) =>
	{
		const owner = territoryMap.getOwnerIndex(cellIndex(territoryMap, cell));
		return owner !== 0 && gameState.isPlayerEnemy(owner) ? "fail" : "next";
	});
}
