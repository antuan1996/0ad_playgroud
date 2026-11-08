/**
 * The services the decision layer gives the execution layer, declared here, below it (PLAN.md §3.4): execution
 * code depends on these interfaces only, never on decision/'s classes, and reaches them on `gameState.ai`
 * (PetraRuntime.AIState, the bot's getters return the managers, which satisfy them as they are).
 */
import type { AttackPlan, AttackType } from "./attackPlan.ts";
import type { DefenseArmy } from "./defenseArmy.ts";
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

/** The attack manager's services (decision/attackManager.ts, `gameState.ai.attacks`): the plans, whom to attack. */
export interface AttackRegistry
{
	readonly startedAttacks: Record<AttackType, AttackPlan[]>;
	/** units that left a plan, ready for the next one */
	readonly outOfPlan: CommonEntityCollection;
	/** the players found defeated */
	readonly defeated: Readonly<Record<number, boolean>>;
	/** the siege units sent ahead against a target, by target */
	readonly bombingAttacks: ReadonlyMap<EntityId, Set<EntityId>>;
	getPlan(planName: UnitPlan | undefined): AttackPlan | undefined;
	getAttackInPreparation(type: AttackType): AttackPlan | undefined;
	/** the player an attack should go for */
	getEnemyPlayer(gameState: CommonGameState, attack: AttackPlan): PlayerId | undefined;
	/** the enemies' entities on each land, counted once a turn */
	enemiesByLand(gameState: CommonGameState): ReadonlyMap<AccessIndex, readonly CommonPlacedEntity[]>;
	/** the soldiers of a leaving plan beside enemies on another land stay there, as attacks of their own */
	splitLocalFights(gameState: CommonGameState, leaving: AttackPlan, targetLand: AccessIndex | undefined): void;
}

/** The defense manager's services (decision/defenseManager.ts, `gameState.ai.defense`). */
export interface DefenseService
{
	/** the enemy foundations whose builders we attacked, for the raids */
	readonly targetList: readonly EntityId[];
	getArmy(partOfArmy: ArmyId): DefenseArmy | undefined;
	/** a hurt unit sent into the nearest holder that heals it (any, in an emergency) */
	garrisonAttackedUnit(gameState: CommonGameState, unit: CommonPlacedEntity, emergency?: boolean): boolean;
}

/** The victory manager's services (decision/victoryManager.ts, `gameState.ai.victory`): critical units, relics. */
export interface VictoryService
{
	/** the units the victory conditions protect (heroes in regicide, ...) */
	readonly criticalEnts: ReadonlyMap<EntityId, unknown>;
	isRelicRaided(relicId: EntityId): boolean;
	/** an attack plan that chose a gaia relic as its target raids it, alone */
	planRelicRaid(relicId: EntityId, plan: AttackPlanId): void;
}

/** The build manager's services (decision/buildManager.ts, `gameState.ai.build`): who builds what, and what not. */
export interface BuildRules
{
	hasBuilder(template: TemplateName): boolean | undefined;
	isUnbuildable(gameState: CommonGameState, template: string): boolean;
	setUnbuildable(gameState: CommonGameState, template: string, time?: number, reason?: string): void;
}

/** The trade manager's services (decision/tradeManager.ts, `gameState.ai.trade`). */
export interface TradeService
{
	/** whether a trade route exists, looked for anew */
	checkRoutes(gameState: CommonGameState): boolean;
	isNewMarketWorth(expectedGain: number): boolean;
}

/** A trainable unit's weights for findBestTrainableUnit: a name, a weight and its arguments (decision/workforce.ts) */
type TrainableWeight = [string, number, ...string[]];

/**
 * The headquarters' own services (decision/headquarters.ts, `gameState.ai.town`): the town's state of the moment,
 * the placement and economy searches, the sea between two lands, and what a plan reports back. Read-only to
 * execution code but for the reports. Where to build is PlacementService.
 */
export interface HeadquartersService
{
	readonly canBuildUnits: boolean;
	readonly needCorral: boolean;
	readonly needFarm: boolean;
	readonly needFish: boolean;
	readonly requireHouses: boolean | undefined;
	readonly saveResources: boolean | undefined;
	/** the turn's bookkeeping: whether a building was started this turn */
	readonly turnCache: Readonly<{ buildingBuilt?: boolean; }>;

	isDangerousLocation(gameState: CommonGameState, pos: CommonPosition, radius: number): boolean;
	isNearInvadingArmy(pos: CommonPosition): boolean;

	canBuild(gameState: CommonGameState, structure: string): boolean;
	findBestTrainableUnit(
		gameState: CommonGameState,
		classes: Array<string | string[]>,
		requirements: TrainableWeight[],
		gatherersOnly?: boolean,
	): TemplateName | undefined;
	GetWantedGatherRates(gameState: CommonGameState): Record<string, number>;
	houseNeeded(gameState: CommonGameState): boolean;
	pickMostNeededResources(
		gameState: CommonGameState,
		allowedResources?: string[],
	): Array<{ type: string; wanted: number; current: number; }>;

	/** the sea joining two lands, if any */
	getSeaBetweenIndices(gameState: CommonGameState, index1: AccessIndex, index2: AccessIndex): SeaIndex | undefined;

	allowsDistantFood(gameState: CommonGameState): boolean;
	markBuildingStarted(): void;
	noteCivCentreOrdered(gameState: CommonGameState, pos: CommonPosition): void;
	noteNothingToGather(resource: string, time: GameSeconds): void;
	phaseResearched(gameState: CommonGameState, phase: number): void;
}

/** The placement searches (decision/placementSearches.ts, `gameState.ai.placement`): where to build. */
export interface PlacementService
{
	findBestBaseForMilitary(gameState: CommonGameState): number | undefined;
	findDefensiveLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined;
	findEconomicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		resource: string,
		options?: { proximity?: CommonPosition; fromStrategic?: boolean; forRoom?: boolean; },
	): false | CommonPosition;
	findMarketLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | [number, number, BaseId | -1, number];
	findStrategicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | CommonPosition | undefined;
}
