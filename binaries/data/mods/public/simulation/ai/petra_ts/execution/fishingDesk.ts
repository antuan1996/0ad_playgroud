/**
 * The town's fishing (`gameState.ai.town.fishing`, part of execution/town.ts): what the fishers ask — the sea of
 * a shoal and whether it is safe (world/fishing.ts) — and what they report: a sea, or every sea, fished out, so
 * its boats are no more wanted. The naval manager (decision/navalManager.ts) makes it, and the desk reaches it
 * only through FishingFleet.
 */
import { fishIsSafe, fishSea } from "../world/fishing.ts";

/** What the fishing desk asks of its naval manager */
export interface FishingFleet
{
	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void;
}

export class FishingDesk
{
	private readonly fleet: FishingFleet;

	constructor(fleet: FishingFleet)
	{
		this.fleet = fleet;
	}

	/** the fishing boats (of a sea, or all) are no more wanted: the shoals are fished out */
	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void
	{
		this.fleet.resetFishingBoats(gameState, sea);
	}

	/** the sea a shoal lies in */
	getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
	{
		return fishSea(gameState, fish);
	}

	/** whether no enemy territory reaches the shoal */
	canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
	{
		return fishIsSafe(gameState, fish);
	}
}
