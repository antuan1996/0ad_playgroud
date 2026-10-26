/**
 * The headquarters as the execution layer sees it (PLAN.md §3.4).
 *
 * Plans and workers carry out what the managers decide; they read the HQ's
 * maps, flags and managers and ask it for searches, but they do not set its
 * state: everything below is read-only to them, and the three things they
 * report (a phase researched, a foundation laid, nothing left to gather) are
 * the HQ's own methods. The view is the HQ itself (hqOf returns
 * gameState.ai.HQ); its type only limits what execution code may do with it.
 */
import type { Headquarters } from "../decision/headquarters.ts";
import type { BaseView, SupplyUpkeep } from "../world/bases.ts";
import type { Geography } from "../world/geography.ts";

export type ExecutionHQ = {
	readonly turnCache: Readonly<Headquarters["turnCache"]>;
	/** the maps and the regions (world/geography.ts), read-only */
	readonly geography: Readonly<Geography>;
	// bases are read through their view (world/bases.ts)
	getBaseByID(baseID: BaseId): BaseView | undefined;
	baseManagers(): ReadonlyArray<BaseView & SupplyUpkeep>;
} & Readonly<Pick<Headquarters,
	// the managers they ask
	| "attackManager" | "basesManager" | "buildManager" | "defenseManager" | "navalManager" | "tradeManager"
	| "victoryManager"
	// maps and flags they read
	| "canBuildUnits" | "needCorral" | "needFarm" | "needFish" | "requireHouses" | "saveResources"
	// questions and searches
	| "baseAtIndex" | "canBuild" | "findBestBaseForMilitary" | "findBestTrainableUnit"
	| "findDefensiveLocation" | "findEconomicCCLocation" | "findMarketLocation" | "findStrategicCCLocation"
	| "GetCurrentGatherRates" | "getSeaBetweenIndices" | "GetWantedGatherRates"
	| "hasPotentialBase" | "isDangerousLocation" | "isNearInvadingArmy" | "pickMostNeededResources"
	// what they report
	| "allowsDistantFood" | "markBuildingStarted" | "noteNothingToGather" | "phaseResearched"
>>;

/** The headquarters, through the execution layer's view of it. */
export function hqOf(gameState: CommonGameState): ExecutionHQ
{
	return gameState.ai.HQ;
}
