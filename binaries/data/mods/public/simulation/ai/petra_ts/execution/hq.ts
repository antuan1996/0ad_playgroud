/**
 * The headquarters as the execution layer sees it (PLAN.md §3.4).
 *
 * Plans and workers carry out what the managers decide; they read the HQ's
 * maps, flags and managers and ask it for searches, but they do not set its
 * state: everything below is read-only to them, and the things they report (a
 * phase researched, a foundation laid, nothing left to gather) are named
 * together in ExecutionReports. The view is the HQ itself (hqOf returns
 * gameState.ai.HQ); its type only limits what execution code may do with it.
 *
 * The view is split into the capabilities a plan actually needs, so that a
 * reader can see what a plan depends on: the managers it consults, the world
 * it reads, the state it weighs, and the searches and reports it has.
 */
import type { Headquarters } from "../decision/headquarters.ts";
import type { BaseView, SupplyUpkeep } from "../world/bases.ts";
import type { Geography } from "../world/geography.ts";

/**
 * The bases as plans may read them: their view (world/bases.ts) keeps the
 * lists read-only, though BasesManager itself is wider.
 */
interface ExecutionBases
{
	readonly baseManagers: ReadonlyArray<BaseView & SupplyUpkeep>;
	getBaseByID(baseID: BaseId): BaseView | undefined;
	baselessBase(): BaseView;
	baseAtIndex(territoryIndex: CellIndex<"territory">): BaseId;
	hasPotentialBase(): boolean;
	GetCurrentGatherRates(gameState: CommonGameState): Record<string, number>;
}

/** The managers an execution plan consults for decisions and world state. */
type ExecutionManagers =
	& Readonly<
		Pick<
			Headquarters,
			"attackManager" | "buildManager" | "defenseManager" | "navalManager" | "tradeManager" | "victoryManager"
		>
	>
	& { readonly basesManager: ExecutionBases; };

/** The maps and the regions execution code reads (world/geography.ts). */
type ExecutionWorld = {
	readonly turnCache: Readonly<Headquarters["turnCache"]>;
	readonly geography: Readonly<Geography>;
};

/** The state of the moment: what a plan may afford and what the town still needs. */
type ExecutionState = Readonly<
	Pick<Headquarters, "canBuildUnits" | "needCorral" | "needFarm" | "needFish" | "requireHouses" | "saveResources">
>;

/** Where a structure or a new base can stand: the headquarters' placement searches. */
type PlacementQueries = Readonly<
	Pick<
		Headquarters,
		| "findBestBaseForMilitary"
		| "findDefensiveLocation"
		| "findEconomicCCLocation"
		| "findMarketLocation"
		| "findStrategicCCLocation"
		| "isDangerousLocation"
		| "isNearInvadingArmy"
	>
>;

/** What the economy wants, what it has, and what it can train or build. */
type EconomyQueries = Readonly<
	Pick<
		Headquarters,
		"canBuild" | "findBestTrainableUnit" | "GetWantedGatherRates" | "houseNeeded" | "pickMostNeededResources"
	>
>;

/** Across water: the sea joining two lands. */
type RouteQueries = Readonly<Pick<Headquarters, "getSeaBetweenIndices">>;

/** What a plan reports back to the headquarters. */
type ExecutionReports = Readonly<
	Pick<
		Headquarters,
		"allowsDistantFood" | "markBuildingStarted" | "noteCivCentreOrdered" | "noteNothingToGather" | "phaseResearched"
	>
>;

type ExecutionHQ =
	& ExecutionManagers
	& ExecutionWorld
	& ExecutionState
	& PlacementQueries
	& EconomyQueries
	& RouteQueries
	& ExecutionReports;

/** The headquarters, through the execution layer's view of it. */
export function hqOf(gameState: CommonGameState): ExecutionHQ
{
	return gameState.ai.HQ;
}
