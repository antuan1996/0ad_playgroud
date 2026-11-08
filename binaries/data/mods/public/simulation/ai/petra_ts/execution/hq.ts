/**
 * The headquarters as the execution layer sees it (PLAN.md §3.4).
 *
 * Plans and workers carry out what the managers decide; they read the HQ's
 * flags and managers and ask it for searches (its geography, bases and
 * treasures are world data, read on gameState.ai), but they do not set its
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

/** The headquarters' per-turn bookkeeping execution code reads (its geography, bases and treasures are on gameState.ai). */
type ExecutionWorld = { readonly turnCache: Readonly<Headquarters["turnCache"]>; };

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
