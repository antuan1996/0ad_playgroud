/**
 * The town as the execution layer sees it (`gameState.ai.town`): the state of the moment the plans and workers
 * share, the economy and danger queries they ask, and what they report back. It is the execution layer's one
 * door to the decision layer: no other execution module holds the headquarters or a manager.
 *
 * Its parts are desks, each the execution side of a decision manager. The core managers make their own desk and
 * hold it, and the desk holds its manager through a view of what it asks (`attacks` and `bombing`: the attack manager's,
 * `transports` and `fishing`: the naval manager's, `defense` and `garrisons`: the defense manager's, `victory`: the victory
 * manager's); the town gathers them once the managers are made. The town makes the parts that serve the
 * headquarters as a whole (`sites`, `placement`), over its view of it (decision/headquarters.ts, which builds the
 * town after its managers and passes itself as TownHQ).
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import type { Config } from "../world/config.ts";
import type { EconomyPlan } from "../world/economyPlan.ts";
import { seaBetween } from "../world/geography.ts";
import type { AttackDesk, SerializedAttacks } from "./attackDesk.ts";
import type { Bombardment } from "./bombardment.ts";
import type { DefenseDesk } from "./defenseDesk.ts";
import type { FishingDesk } from "./fishingDesk.ts";
import type { GarrisonManager, SerializedGarrisonManager } from "./garrisonManager.ts";
import { PlacementSearches, type PlacementSearchHQ } from "./placementSearches.ts";
import { SiteDesk, type SiteHQ } from "./siteDesk.ts";
import type { SerializedTransports, TransportDesk } from "./transportDesk.ts";
import type { VictoryDesk } from "./victoryDesk.ts";

/** A trainable unit's weights for findBestTrainableUnit: a name, a weight and its arguments (decision/workforce.ts) */
type TrainableWeight = [string, number, ...string[]];

/** A resource's wanted and current gather rates, as pickMostNeededResources orders them */
type ResourceNeed = { type: string; wanted: number; current: number; };

/**
 * What the town asks of its headquarters: the state it sets, the decisions it takes for the plans, and where the
 * plans' reports go. The headquarters satisfies it as it is.
 */
interface TownHQ
{
	readonly canBuildUnits: boolean;
	readonly economy: Readonly<EconomyPlan>;
	readonly requireHouses: boolean | undefined;

	canBuild(gameState: CommonGameState, structure: string): boolean;
	findBestTrainableUnit(
		gameState: CommonGameState,
		classes: Array<string | string[]>,
		requirements: TrainableWeight[],
		gatherersOnly?: boolean,
	): TemplateName | undefined;
	houseNeeded(gameState: CommonGameState): boolean;
	isNearInvadingArmy(pos: CommonPosition): boolean;

	noteNothingToGather(resource: string, time: GameSeconds): void;
	phaseResearched(gameState: CommonGameState, phase: number): void;
}

/** The desks the core managers made, which the town gathers */
interface ManagerDesks
{
	readonly attackManager: { readonly desk: AttackDesk; readonly bombing: Bombardment; };
	readonly navalManager: { readonly desk: TransportDesk; readonly fishing: FishingDesk; };
	readonly defenseManager: { readonly desk: DefenseDesk; readonly garrisons: GarrisonManager; };
	readonly victoryManager: { readonly desk: VictoryDesk; };
}

/** What the town works out once a headquarters turn (cleared by newTurn) */
type TownTurnCache = {
	buildingBuilt?: boolean;
	allowDistantFood?: boolean;
	wantedRates?: Record<string, number>;
	firingStructures?: CommonEntityCollection<CommonPlacedEntity>;
};

export class Town
{
	/** the building sites: builders, what may not be built, where to build */
	readonly sites: SiteDesk;
	/** where to build, and the civic centres ordered followed until they stand */
	readonly placement: PlacementSearches;
	/** the defense: raids, armies, shelter for a hurt unit */
	readonly defense: DefenseDesk;
	/** the victory conditions: critical units, relics */
	readonly victory: VictoryDesk;
	/** the garrison orders, carried out, followed and released */
	readonly garrisons: GarrisonManager;
	/** the attack plans, whom they attack, and the units between plans */
	readonly attacks: AttackDesk;
	/** the siege sent to bomb what is in range while it waits */
	readonly bombing: Bombardment;
	/** the ships, the transports between lands, and the fishing grounds */
	readonly transports: TransportDesk;
	/** the fishers' questions and reports */
	readonly fishing: FishingDesk;
	private readonly config: Config;
	private readonly hq: TownHQ;
	private turnCache: TownTurnCache = {};

	constructor(config: Config, hq: TownHQ & SiteHQ & PlacementSearchHQ & ManagerDesks)
	{
		this.config = config;
		this.hq = hq;
		this.sites = new SiteDesk(hq);
		this.placement = new PlacementSearches(hq);
		this.defense = hq.defenseManager.desk;
		this.victory = hq.victoryManager.desk;
		this.garrisons = hq.defenseManager.garrisons;
		this.attacks = hq.attackManager.desk;
		this.bombing = hq.attackManager.bombing;
		this.transports = hq.navalManager.desk;
		this.fishing = hq.navalManager.fishing;
	}

	/** The town's own state, as the headquarters saves it with its own */
	Serialize(): { transports: SerializedTransports; attacks: SerializedAttacks; garrisons: SerializedGarrisonManager; }
	{
		return {
			transports: this.transports.Serialize(),
			attacks: this.attacks.Serialize(),
			garrisons: this.garrisons.Serialize(),
		};
	}

	/** The saved state back (the managers it reads are restored before the town is made) */
	resume(gameState: CommonGameState, data: ReturnType<Town["Serialize"]>): void
	{
		this.transports.resume(gameState, data.transports);
		this.attacks.resume(gameState, data.attacks, this.hq.canBuildUnits);
		this.garrisons.resume(data.garrisons);
	}

	/** A headquarters turn starts: what was worked out for the last one is forgotten */
	newTurn(): void
	{
		this.turnCache = {};
	}

	get canBuildUnits(): boolean
	{
		return this.hq.canBuildUnits;
	}

	/** what the town saves for and where its food comes from */
	get economy(): Readonly<EconomyPlan>
	{
		return this.hq.economy;
	}

	get requireHouses(): boolean | undefined
	{
		return this.hq.requireHouses;
	}

	/** Whether a building was started since the headquarters turn began */
	get buildingStarted(): boolean
	{
		return this.turnCache.buildingBuilt === true;
	}

	/** A construction plan laid its foundation this turn. */
	markBuildingStarted(): void
	{
		this.turnCache.buildingBuilt = true;
	}

	isDangerousLocation(gameState: CommonGameState, pos: CommonPosition, radius: number): boolean
	{
		return this.hq.isNearInvadingArmy(pos) || this.isUnderEnemyFire(gameState, pos, radius);
	}

	/** Check that the chosen position is not too near from an invading army */
	isNearInvadingArmy(pos: CommonPosition): boolean
	{
		return this.hq.isNearInvadingArmy(pos);
	}

	isUnderEnemyFire(gameState: CommonGameState, pos: CommonPosition, radius: number = 0): boolean
	{
		if (!this.turnCache.firingStructures)
		{
			this.turnCache.firingStructures = gameState.updatingCollection(
				"diplo-FiringStructures",
				filters.hasDefensiveFire(),
				gameState.getEnemyStructures(),
			);
		}
		for (const ent of this.turnCache.firingStructures.values())
		{
			const ranged = ent.attackRange("Ranged");
			if (!ranged)
			{
				continue;
			}
			const range = radius + ranged.max;
			if (SquareVectorDistance(ent.position(), pos) < range * range)
			{
				return true;
			}
		}
		return false;
	}

	canBuild(gameState: CommonGameState, structure: string): boolean
	{
		return this.hq.canBuild(gameState, structure);
	}

	/** picks the best template based on parameters and classes */
	findBestTrainableUnit(
		gameState: CommonGameState,
		classes: Array<string | string[]>,
		requirements: TrainableWeight[],
		gatherersOnly?: boolean,
	): TemplateName | undefined
	{
		return this.hq.findBestTrainableUnit(gameState, classes, requirements, gatherersOnly);
	}

	/** Whether a planned house may be paid now (decision/housing.ts). */
	houseNeeded(gameState: CommonGameState): boolean
	{
		return this.hq.houseNeeded(gameState);
	}

	/** The gather rates the queues want, worked out once a turn */
	GetWantedGatherRates(gameState: CommonGameState): Record<string, number>
	{
		if (!this.turnCache.wantedRates)
		{
			this.turnCache.wantedRates = gameState.ai.queueManager.wantedGatherRates(gameState);
		}

		return this.turnCache.wantedRates;
	}

	/**
	 * Pick the resource which most needs another worker
	 * How this works:
	 * We get the rates we would want to have to be able to deal with our plans
	 * We get our current rates
	 * We compare; we pick the one where the discrepancy is highest.
	 * Need to balance long-term needs and possible short-term needs.
	 */
	pickMostNeededResources(gameState: CommonGameState, allowedResources: string[] = []): ResourceNeed[]
	{
		const wantedRates = this.GetWantedGatherRates(gameState);
		const currentRates = gameState.ai.bases.GetCurrentGatherRates(gameState);
		if (!allowedResources.length)
		{
			allowedResources = Resources.GetCodes();
		}

		const needed = [];
		for (const res of allowedResources)
		{
			needed.push({ type: res, wanted: wantedRates[res], current: currentRates[res] });
		}

		needed.sort(compareNeeds);
		return needed;
	}

	/**
	 * returns the sea index linking regions 1 and region 2 (supposed to be different land region)
	 * otherwise return undefined
	 * for the moment, only the case land-sea-land is supported
	 */
	getSeaBetweenIndices(gameState: CommonGameState, index1: AccessIndex, index2: AccessIndex): SeaIndex | undefined
	{
		return seaBetween(gameState, index1, index2, this.config.debug);
	}

	/** Whether gatherers may go far for food this turn: only while no field or corral can be built (worked out once a turn). */
	allowsDistantFood(gameState: CommonGameState): boolean
	{
		if (this.turnCache.allowDistantFood === undefined)
		{
			this.turnCache.allowDistantFood = !this.hq.canBuild(gameState, "structures/{civ}/field") &&
				!this.hq.canBuild(gameState, "structures/{civ}/corral");
		}
		return this.turnCache.allowDistantFood;
	}

	/** A civic centre was ordered at `pos` (ConstructionPlan.start): followed until it stands. */
	noteCivCentreOrdered(gameState: CommonGameState, pos: CommonPosition): void
	{
		this.placement.noteCivCentreOrdered(gameState, pos);
	}

	/** A worker found nothing left to gather of `resource`, now. */
	noteNothingToGather(resource: string, time: GameSeconds): void
	{
		this.hq.noteNothingToGather(resource, time);
	}

	/** A phase research started: we no longer phase towards it, and we are in it. */
	phaseResearched(gameState: CommonGameState, phase: number): void
	{
		this.hq.phaseResearched(gameState, phase);
	}
}

/** The most needed resource first: short of its wanted rate, then by how far short */
function compareNeeds(a: ResourceNeed, b: ResourceNeed): number
{
	if (a.current < a.wanted && b.current < b.wanted)
	{
		if (a.current && b.current)
		{
			return b.wanted / b.current - a.wanted / a.current;
		}
		if (a.current)
		{
			return 1;
		}
		if (b.current)
		{
			return -1;
		}
		return b.wanted - a.wanted;
	}
	if (a.current < a.wanted || a.wanted && !b.wanted)
	{
		return -1;
	}
	if (b.current < b.wanted || b.wanted && !a.wanted)
	{
		return 1;
	}
	return a.current - a.wanted - b.current + b.wanted;
}
