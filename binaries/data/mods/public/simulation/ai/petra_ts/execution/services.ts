/**
 * The services the decision layer gives the execution layer, declared here, below it (PLAN.md §3.4): execution
 * code depends on these interfaces only, never on decision/'s classes, and reaches them on `gameState.ai`
 * (PetraRuntime.AIState, the bot's getters return the managers, which satisfy them as they are).
 */
import type { SeaFleet, TransportPlan } from "./transportPlan.ts";

/** The naval manager's services (decision/navalManager.ts, `gameState.ai.naval`): ships, transports, fishing. */
export interface NavalService
{
	readonly ships: CommonEntityCollection;
	readonly transportShips: CommonEntityCollection;
	/** where a ship may land on a land from a sea: cells by land, then by sea */
	readonly landingZones: Readonly<Record<number, Record<number, Set<number>>>>;
	/** our ships on a sea, by kind */
	fleet(sea: number): SeaFleet | undefined;
	getPlan(ID: TransportPlanId | undefined): TransportPlan | undefined;
	/** a unit asks to be carried to another land; false when it cannot be */
	requireTransport(
		gameState: CommonGameState,
		ent: CommonEntity,
		startIndex: AccessIndex,
		endIndex: AccessIndex,
		endPos: CommonPosition,
	): boolean;
	/** the units a plan's ships cannot take go to a new plan */
	splitTransport(gameState: CommonGameState, plan: TransportPlan, needSplit: CommonEntity[]): boolean;
	/** a transport between two lands, unless one goes already */
	createTransportIfNeeded(
		gameState: CommonGameState,
		fromPos: CommonPosition,
		toPos: CommonPosition,
		toAccess: AccessIndex,
	): void;
	setMinimalTransportShips(gameState: CommonGameState, sea: SeaIndex, number: number): void;
	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void;
	getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number;
	canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean;
}
