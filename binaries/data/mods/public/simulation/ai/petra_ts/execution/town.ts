/**
 * The town as the execution layer sees it (`gameState.ai.town`): the state of the moment the plans and workers
 * share, the economy and danger queries they ask, and what they report back. It is the execution layer's one
 * door to the decision layer (decision/headquarters.ts, which owns it and passes itself as TownHQ): no other
 * execution module holds the headquarters or a manager, and the town and its parts (its desks: `sites`, `guard`, `attacks`, `transports`) reach
 * them only through their private views.
 */
import * as filters from "simulation/ai/common-api/filters.js";
import { SquareVectorDistance } from "simulation/ai/common-api/utils.js";
import type { Config } from "../world/config.ts";
import type { EconomyPlan } from "../world/economyPlan.ts";
import { seaBetween } from "../world/geography.ts";
import { AttackDesk, type AttackHQ } from "./attackDesk.ts";
import { GuardDesk, type GuardHQ } from "./guardDesk.ts";
import { SiteDesk, type SiteHQ } from "./siteDesk.ts";
import { TransportDesk, type SerializedTransports, type TransportHQ } from "./transportDesk.ts";

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

	noteCivCentreOrdered(gameState: CommonGameState, pos: CommonPosition): void;
	noteNothingToGather(resource: string, time: GameSeconds): void;
	phaseResearched(gameState: CommonGameState, phase: number): void;
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
	/** the defense and the victory conditions: raids, armies, shelter, critical units, relics */
	readonly guard: GuardDesk;
	/** the attack plans, whom they attack, and the units between plans */
	readonly attacks: AttackDesk;
	/** the ships, the transports between lands, and the fishing grounds */
	readonly transports: TransportDesk;
	private readonly config: Config;
	private readonly hq: TownHQ;
	private turnCache: TownTurnCache = {};

	constructor(config: Config, hq: TownHQ & SiteHQ & GuardHQ & AttackHQ & TransportHQ)
	{
		this.config = config;
		this.hq = hq;
		this.sites = new SiteDesk(hq);
		this.guard = new GuardDesk(hq);
		this.attacks = new AttackDesk(hq);
		this.transports = new TransportDesk(config, hq);
	}

	/** The town's own state, as the headquarters saves it with its own */
	Serialize(): { transports: SerializedTransports; }
	{
		return { transports: this.transports.Serialize() };
	}

	/** The saved state back, once the managers it reads are restored */
	resume(gameState: CommonGameState, data: ReturnType<Town["Serialize"]>): void
	{
		this.transports.resume(gameState, data.transports);
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
		this.hq.noteCivCentreOrdered(gameState, pos);
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
