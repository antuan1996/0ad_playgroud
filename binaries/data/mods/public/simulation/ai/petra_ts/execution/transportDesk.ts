/**
 * The town's transports (`gameState.ai.town.transports`, part of execution/town.ts): what units, plans and workers
 * ask of the naval manager — our ships and fleets, where ships may land, the transport plans and a passage to
 * another land, the ships a sea needs, and the fishing grounds. It reaches the naval manager only through
 * TransportHQ.
 */
import type { SeaFleet, TransportPlan } from "./transportPlan.ts";

/** What the transports desk asks of the headquarters (decision/headquarters.ts satisfies it as it is) */
export interface TransportHQ
{
	readonly navalManager: {
		readonly ships: CommonEntityCollection;
		readonly transportShips: CommonEntityCollection;
		readonly landingZones: Readonly<Record<number, Record<number, Set<number>>>>;
		fleet(sea: number): SeaFleet | undefined;
		getPlan(ID: TransportPlanId | undefined): TransportPlan | undefined;
		requireTransport(
			gameState: CommonGameState,
			ent: CommonEntity,
			startIndex: AccessIndex,
			endIndex: AccessIndex,
			endPos: CommonPosition,
		): boolean;
		splitTransport(gameState: CommonGameState, plan: TransportPlan, needSplit: CommonEntity[]): boolean;
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
	};
}

export class TransportDesk
{
	private readonly hq: TransportHQ;

	constructor(hq: TransportHQ)
	{
		this.hq = hq;
	}

	/** our ships */
	get ships(): CommonEntityCollection
	{
		return this.hq.navalManager.ships;
	}

	/** our ships that carry units */
	get transportShips(): CommonEntityCollection
	{
		return this.hq.navalManager.transportShips;
	}

	/** where a ship may land on a land from a sea: cells by land, then by sea */
	get landingZones(): Readonly<Record<number, Record<number, Set<number>>>>
	{
		return this.hq.navalManager.landingZones;
	}

	/** our ships on a sea, by kind */
	fleet(sea: number): SeaFleet | undefined
	{
		return this.hq.navalManager.fleet(sea);
	}

	getPlan(ID: TransportPlanId | undefined): TransportPlan | undefined
	{
		return this.hq.navalManager.getPlan(ID);
	}

	/** a unit asks to be carried to another land; false when it cannot be */
	requireTransport(
		gameState: CommonGameState,
		ent: CommonEntity,
		startIndex: AccessIndex,
		endIndex: AccessIndex,
		endPos: CommonPosition,
	): boolean
	{
		return this.hq.navalManager.requireTransport(gameState, ent, startIndex, endIndex, endPos);
	}

	/** the units a plan's ships cannot take go to a new plan */
	splitTransport(gameState: CommonGameState, plan: TransportPlan, needSplit: CommonEntity[]): boolean
	{
		return this.hq.navalManager.splitTransport(gameState, plan, needSplit);
	}

	/** a transport between two lands, unless one goes already */
	createTransportIfNeeded(
		gameState: CommonGameState,
		fromPos: CommonPosition,
		toPos: CommonPosition,
		toAccess: AccessIndex,
	): void
	{
		this.hq.navalManager.createTransportIfNeeded(gameState, fromPos, toPos, toAccess);
	}

	/** at least `number` transport ships wanted on the sea */
	setMinimalTransportShips(gameState: CommonGameState, sea: SeaIndex, number: number): void
	{
		this.hq.navalManager.setMinimalTransportShips(gameState, sea, number);
	}

	/** the fishing boats (of a sea, or all) look for fish anew */
	resetFishingBoats(gameState: CommonGameState, sea?: SeaIndex): void
	{
		this.hq.navalManager.resetFishingBoats(gameState, sea);
	}

	getFishSea(gameState: CommonGameState, fish: CommonPlacedEntity): number
	{
		return this.hq.navalManager.getFishSea(gameState, fish);
	}

	canFishSafely(gameState: CommonGameState, fish: CommonPlacedEntity): boolean
	{
		return this.hq.navalManager.canFishSafely(gameState, fish);
	}
}
