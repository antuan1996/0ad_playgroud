import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { cellIndex, seconds } from "../adapter/brands.ts";
import { getLandAccess, getMaxStrength, requireTemplate } from "../adapter/entityExtend.ts";
import { isPlaced } from "../adapter/placed.ts";
import { updateCaptureStrength } from "../execution/captureOrders.ts";
import { type PlanMetadata } from "../execution/queueplan.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { PLAN_RESERVE } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
import { CaptureTally, type CaptureEntry } from "../world/captureTally.ts";
import { censusOf } from "../world/census.ts";
import { Config } from "../world/config.ts";
import * as difficulty from "../world/difficultyLevel.ts";
import { GatherEconomy } from "../world/gatherEconomy.ts";
import { restoreGeography, seaBetween, type Geography } from "../world/geography.ts";
import * as mapMask from "../world/mapMask.ts";
import { createTerritoryMap, type TerritoryMap } from "../world/mapModule.ts";
import { ProductionLoad } from "../world/production.ts";
import { ShipTraffic } from "../world/shipTraffic.ts";
import { AttackManager } from "./attackManager.ts";
import { BasesManager } from "./basesManager.ts";
import { BuildManager } from "./buildManager.ts";
import { DefenseManager } from "./defenseManager.ts";
import { DiplomacyManager } from "./diplomacyManager.ts";
import { EmergencyManager } from "./emergencyManager.ts";
import { checkBaseExpansion, followCivCentreOrders, provideForDryLand } from "./expansion.ts";
import { GarrisonManager } from "./garrisonManager.ts";
import { buildMoreHouses } from "./houseBuilding.ts";
import { houseNeeded } from "./housing.ts";
import { checkEvents } from "./hqEvents.ts";
import { buildDefenses, constructTrainingBuildings } from "./militaryBuildings.ts";
import { NavalManager } from "./navalManager.ts";
import { checkPhaseRequirements, notePhase } from "./phasing.ts";
import { PlacementSearches } from "./placementSearches.ts";
import { ResearchManager } from "./researchManager.ts";
import {
	buildEarlyMarket,
	buildFarmstead,
	buildForge,
	buildMarket,
	buildTemple,
	buildWonder,
	manageCorral,
} from "./townBuildings.ts";
import { TradeManager } from "./tradeManager.ts";
import { VictoryManager } from "./victoryManager.ts";
import { type TrainableRequirement } from "./workforce.ts";
import { trainMoreWorkers } from "./workforceTraining.ts";

type HeadquartersTurnCache = {
	buildingBuilt?: boolean;
	allowDistantFood?: boolean;
	wantedRates?: Record<string, number>;
	firingStructures?: CommonEntityCollection<CommonPlacedEntity>;
	numAround?: Record<number, number>;
	accountedPopulation?: number;
	accountedWorkers?: number;
};
export type HeadquartersQueues = PetraRuntime.QueueCollection;
export type HeadquartersTrainableRequirement = TrainableRequirement;
export type HeadquartersEvents = EngineAIEvents;
export type HeadquartersSerializedData = {
	/** the fields a save keeps (the regions and naval flag through the geography's accessors) */
	properties: Pick<
		Headquarters,
		| "phasing"
		| "lastFailedGather"
		| "firstBaseConfig"
		| "supportRatio"
		| "targetNumWorkers"
		| "fortStartTime"
		| "towerStartTime"
		| "fortressStartTime"
		| "bAdvanced"
		| "saveResources"
		| "saveSpace"
		| "needCorral"
		| "needFarm"
		| "needFish"
		| "maxFields"
		| "canExpand"
		| "canBuildUnits"
		| "navalMap"
		| "landRegions"
		| "navalRegions"
		| "decayingStructures"
		| "capturableTargets"
		| "capturableTargetsTime"
	>;
	basesManager: ReturnType<BasesManager["Serialize"]>;
	attackManager: ReturnType<AttackManager["Serialize"]>;
	buildManager: ReturnType<BuildManager["Serialize"]>;
	defenseManager: ReturnType<DefenseManager["Serialize"]>;
	tradeManager: ReturnType<TradeManager["Serialize"]>;
	navalManager: ReturnType<NavalManager["Serialize"]>;
	researchManager: ReturnType<ResearchManager["Serialize"]>;
	diplomacyManager: ReturnType<DiplomacyManager["Serialize"]>;
	garrisonManager: ReturnType<GarrisonManager["Serialize"]>;
	victoryManager: ReturnType<VictoryManager["Serialize"]>;
	emergencyManager: ReturnType<EmergencyManager["Serialize"]>;
	gatherEconomy: ReturnType<GatherEconomy["Serialize"]>;
};

/**
 * Headquarters
 * Deal with high level logic for the AI. Most of the interesting stuff gets done here.
 * Some tasks:
 *  -defining RESS needs
 *  -BO decisions.
 *     > training workers
 *     > building stuff (though we'll send that to bases)
 *  -picking strategy (specific manager?)
 *  -diplomacy -> diplomacyManager
 *  -planning attacks -> attackManager
 *  -picking new CC locations.
 */

/** Wood left within reach of our bases under which a saving town calls its land dry (buildEarlyMarket). */
export const DRY_WOOD = 500;

/** A unit template's value by the parameters (before its cost); an unknown parameter is warned about (once a comparison) */
function unitValue(
	template: CommonTemplate,
	parameters: HeadquartersTrainableRequirement[],
	config: Config,
	warn: boolean,
): number
{
	let value = 0.1;
	for (const param of parameters)
	{
		if (param[0] === "strength")
		{
			value += getMaxStrength(template, config.debug, config.DamageTypeImportance) * param[1];
		}
		else if (param[0] === "siegeStrength")
		{
			value += getMaxStrength(template, config.debug, config.DamageTypeImportance, "Structure") * param[1];
		}
		else if (param[0] === "speed")
		{
			value += template.walkSpeed() * param[1];
		}
		else if (param[0] === "costsResource")
		{
			// requires a third parameter which is the resource
			if (template.cost()[param[2] ?? ""])
			{
				value *= param[1];
			}
		}
		else if (param[0] === "canGather")
		{
			// checking against wood, could be anything else really.
			if (template.resourceGatherRates()?.["wood.tree"])
			{
				value *= param[1];
			}
		}
		else if (warn)
		{
			aiWarn(" trainMoreUnits avec non prevu " + uneval(param));
		}
	}
	return value;
}

/** A step of the turn in its own profile region */
function profiled(name: string, step: () => void): void
{
	Engine.ProfileStart(name);
	step();
	Engine.ProfileStop();
}

/** Whether a building trains for over 5 s what has started or garrisons there */
function busyTraining(anchor: CommonEntity): boolean
{
	const queue = anchor.trainingQueue();
	if (!queue)
	{
		return false;
	}
	let time = 0;
	for (const item of queue)
	{
		if (item.progress > 0 || item.metadata && item.metadata.garrisonType)
		{
			time += item.timeRemaining;
		}
	}
	return time / 1000 > 5;
}

/**
 * The citizen infantry the anchor trains for an emergency, one that adds arrows when it garrisons and that we can
 * afford: ranged if wanted, else the last found
 */
function emergencyTemplate(
	gameState: CommonGameState,
	nearestAnchor: CommonEntity,
	civ: string,
	autogarrison: boolean,
	rangedWanted: boolean,
): [string, CommonTemplate] | undefined
{
	const total = gameState.getResources();
	let templateFound: [string, CommonTemplate] | undefined;
	const trainables = nearestAnchor.trainableEntities(civ);
	const garrisonArrowClasses = nearestAnchor.getGarrisonArrowClasses();
	for (const trainable of (trainables ?? []))
	{
		if (gameState.isTemplateDisabled(trainable))
		{
			continue;
		}
		const template = gameState.getTemplate(trainable);
		if (!template || !template.hasClasses(["Infantry+CitizenSoldier"]))
		{
			continue;
		}
		if (autogarrison && !template.hasClasses(garrisonArrowClasses))
		{
			continue;
		}
		if (!total.canAfford(new ResourcesManager(template.cost())))
		{
			continue;
		}
		templateFound = [trainable, template];
		if (template.hasClass("Ranged") === rangedWanted)
		{
			break;
		}
	}
	return templateFound;
}

export class Headquarters
{
	Config: Config;
	attackManager: AttackManager;
	/** the advanced buildings this civ has (startingStrategy.structureAnalysis) */
	bAdvanced: TemplateName[] = [];
	basesManager: BasesManager;
	buildManager: BuildManager;
	/** whether we have a built market; read each turn in update() */
	canBarter = false;
	/** whether we can train units at all, and expand: set by the first turn's analysis (startingStrategy) */
	canBuildUnits = false;
	canExpand = false;
	/** where to build: the placement searches (decision/placementSearches.ts) */
	placement: PlacementSearches = new PlacementSearches(this);
	/** the capture strength our units set on each target (world/captureTally.ts), saved through the accessors below */
	captures = new CaptureTally();
	currentPhase: number;
	decayingStructures: Set<EntityId> = new Set();
	defenseManager: DefenseManager;
	diplomacyManager: DiplomacyManager;
	emergencyManager: EmergencyManager;
	extraFortresses: number;
	extraTowers: number;
	firstBaseConfig: boolean;
	fortStartTime: GameSeconds;
	fortressLapseTime: GameSeconds;
	fortressStartTime: GameSeconds;
	garrisonManager: GarrisonManager;
	/** When a worker last found nothing left to gather, per resource. */
	lastFailedGather: Record<string, GameSeconds>;
	/** the most fields the map's start allows, false for no limit (startingStrategy) */
	maxFields: number | false = false;
	navalManager: NavalManager;
	needCorral = false;
	needFarm = false;
	needFish = false;
	phasing: number;
	requireHouses: boolean | undefined;
	researchManager: ResearchManager;
	saveResources: boolean | undefined;
	saveSpace: boolean | undefined;
	supportRatio: number;
	targetNumWorkers: number;
	towerLapseTime: GameSeconds;
	towerStartTime: GameSeconds;
	tradeManager: TradeManager;
	treasures: CommonEntityCollection<CommonPlacedEntity>;
	turnCache: HeadquartersTurnCache;
	victoryManager: VictoryManager;

	/** The map as we understand it (world/geography.ts); the accessors below keep its fields' old names. */
	geography: Geography;
	/** The civic centres ordered, followed until they stand (followCivCentreOrders); not saved. */
	ccOrders: Array<{ pos: CommonPosition; time: number; seen: boolean; }> = [];
	/** Civic centre spots that failed or lost their foundation, avoided until then (game seconds); not saved. */
	ccSpotsAvoided: Array<{ pos: CommonPosition; until: number; }> = [];
	/** Where the enemy's ships go, on naval maps (world/shipTraffic.ts); not saved, it fills again. */
	shipTraffic: ShipTraffic | undefined = undefined;
	/** How fast each resource comes in per gatherer, measured (world/gatherEconomy.ts). */
	gatherEconomy: GatherEconomy = new GatherEconomy();
	/** How busy our military trainers are, measured (world/production.ts); not saved. */
	productionLoad: ProductionLoad = new ProductionLoad();

	get territoryMap(): TerritoryMap
	{
		return this.geography.territoryMap;
	}
	set territoryMap(map: TerritoryMap)
	{
		this.geography.territoryMap = map;
	}
	get borderMap(): InfoMap
	{
		return this.geography.borderMap;
	}
	set borderMap(map: InfoMap)
	{
		this.geography.borderMap = map;
	}
	get landRegions(): Record<number, boolean>
	{
		return this.geography.landRegions;
	}
	set landRegions(regions: Record<number, boolean>)
	{
		this.geography.landRegions = regions;
	}
	get navalRegions(): Record<number, boolean>
	{
		return this.geography.navalRegions;
	}
	set navalRegions(regions: Record<number, boolean>)
	{
		this.geography.navalRegions = regions;
	}
	get navalMap(): boolean
	{
		return this.geography.navalMap;
	}
	set navalMap(naval: boolean)
	{
		this.geography.navalMap = naval;
	}

	/**
	 * A headquarters on an analysed map (startingStrategy.gameAnalysis then
	 * takes the first turn's decisions), or one restored from its save with
	 * its managers and their plans.
	 */
	constructor(config: Config, gameState: CommonGameState, geography: Geography, saved?: HeadquartersSerializedData)
	{
		this.geography = geography;
		this.Config = config;
		this.phasing = 0; // existing values: 0 means no, i > 0 means phasing towards phase i

		// Cache various quantities.
		this.turnCache = {};
		this.lastFailedGather = {};

		this.firstBaseConfig = false;

		// Workers configuration.
		this.targetNumWorkers = this.Config.Economy.targetNumWorkers;
		this.supportRatio = this.Config.Economy.supportRatio;

		this.fortStartTime = seconds(180); // Sentry towers, will start at fortStartTime + towerLapseTime.
		this.towerStartTime = seconds(0); // Stone towers, will start as soon as available (town phase).
		this.towerLapseTime = seconds(this.Config.Military.towerLapseTime);
		this.fortressStartTime = seconds(0); // Fortresses, will start as soon as available (city phase).
		this.fortressLapseTime = seconds(this.Config.Military.fortressLapseTime);
		this.extraTowers = Math.round(Math.min(this.Config.difficulty, 3) * this.Config.personality.defensive);
		this.extraFortresses = Math.round(
			Math.max(Math.min(this.Config.difficulty - 1, 2), 0) * this.Config.personality.defensive,
		);

		this.treasures = gameState.getEntities().filter((ent): ent is CommonPlacedEntity =>
			ent.isTreasure() && isPlaced(ent)
		);
		this.treasures.registerUpdates();
		this.currentPhase = gameState.currentPhase();

		if (saved)
		{
			this.resumeProperties(saved.properties);
			this.gatherEconomy = GatherEconomy.restore(saved.gatherEconomy);

			this.basesManager = new BasesManager(this.Config, gameState, saved.basesManager);
			this.navalManager = NavalManager.restore(this.Config, gameState, geography, saved.navalManager);
			this.attackManager = AttackManager.restore(this.Config, gameState, saved.attackManager, this.canBuildUnits);

			this.buildManager = BuildManager.restore(saved.buildManager);
			this.defenseManager = DefenseManager.restore(this.Config, gameState, geography, saved.defenseManager);

			this.tradeManager = TradeManager.restore(this.Config, gameState, geography, saved.tradeManager);

			this.researchManager = ResearchManager.restore(this.Config, saved.researchManager);
			this.diplomacyManager = DiplomacyManager.restore(this.Config, saved.diplomacyManager);
			this.garrisonManager = GarrisonManager.restore(this.Config, saved.garrisonManager);
			this.victoryManager = VictoryManager.restore(this.Config, saved.victoryManager);
			this.emergencyManager = EmergencyManager.restore(this.Config, saved.emergencyManager);
			return;
		}

		this.basesManager = new BasesManager(this.Config, gameState);
		this.attackManager = new AttackManager(this.Config, gameState);
		this.buildManager = BuildManager.start(gameState);
		this.defenseManager = new DefenseManager(this.Config, geography);
		this.tradeManager = new TradeManager(this.Config, gameState, geography);
		this.navalManager = new NavalManager(this.Config, gameState, geography);
		this.researchManager = new ResearchManager(this.Config);
		this.diplomacyManager = new DiplomacyManager(this.Config, false);
		this.garrisonManager = new GarrisonManager(this.Config);
		this.victoryManager = new VictoryManager(this.Config);
		this.emergencyManager = EmergencyManager.start(this.Config, gameState);
	}

	/** A saved headquarters' own state, as it was saved */
	private resumeProperties(properties: HeadquartersSerializedData["properties"]): void
	{
		this.phasing = properties.phasing;
		this.lastFailedGather = properties.lastFailedGather;
		this.firstBaseConfig = properties.firstBaseConfig;
		this.supportRatio = properties.supportRatio;
		this.targetNumWorkers = properties.targetNumWorkers;
		this.fortStartTime = properties.fortStartTime;
		this.towerStartTime = properties.towerStartTime;
		this.fortressStartTime = properties.fortressStartTime;
		this.bAdvanced = properties.bAdvanced;
		this.saveResources = properties.saveResources;
		this.saveSpace = properties.saveSpace;
		this.needCorral = properties.needCorral;
		this.needFarm = properties.needFarm;
		this.needFish = properties.needFish;
		this.maxFields = properties.maxFields;
		this.canExpand = properties.canExpand;
		this.canBuildUnits = properties.canBuildUnits;
		this.decayingStructures = properties.decayingStructures;
		this.capturableTargets = properties.capturableTargets;
		this.capturableTargetsTime = properties.capturableTargetsTime;
	}

	/** A saved headquarters: its map's regions from the save, its maps read again */
	static restore(config: Config, gameState: CommonGameState, saved: HeadquartersSerializedData): Headquarters
	{
		const regions = {
			landRegions: saved.properties.landRegions,
			navalRegions: saved.properties.navalRegions,
			navalMap: saved.properties.navalMap,
		};
		return new Headquarters(config, gameState, restoreGeography(gameState, regions), saved);
	}

	/** More initialisation for stuff that needs the gameState */

	/**
	 * initialization needed after deserialization (only called when deserialization)
	 */
	/**
	 * returns the sea index linking regions 1 and region 2 (supposed to be different land region)
	 * otherwise return undefined
	 * for the moment, only the case land-sea-land is supported
	 */
	getSeaBetweenIndices(gameState: CommonGameState, index1: AccessIndex, index2: AccessIndex): SeaIndex | undefined
	{
		return seaBetween(gameState, index1, index2, this.Config.debug);
	}

	/** A phase research started: we no longer phase towards it, and we are in it. */
	phaseResearched(gameState: CommonGameState, phase: number): void
	{
		this.phasing = 0;
		this.OnPhaseUp(gameState, phase);
	}

	/** Whether gatherers may go far for food this turn: only while no field or corral can be built (worked out once a turn). */
	allowsDistantFood(gameState: CommonGameState): boolean
	{
		if (this.turnCache.allowDistantFood === undefined)
		{
			this.turnCache.allowDistantFood = !this.canBuild(gameState, "structures/{civ}/field") &&
				!this.canBuild(gameState, "structures/{civ}/corral");
		}
		return this.turnCache.allowDistantFood;
	}

	/** A construction plan laid its foundation this turn. */
	markBuildingStarted(): void
	{
		this.turnCache.buildingBuilt = true;
	}

	/** A worker found nothing left to gather of `resource`, now. */
	noteNothingToGather(resource: string, time: GameSeconds): void
	{
		this.lastFailedGather[resource] = time;
	}

	/** Called by any "phase" research plan once it's started */
	OnPhaseUp(gameState: CommonGameState, phase: number): void
	{
	}

	/** picks the best template based on parameters and classes */
	findBestTrainableUnit(
		gameState: CommonGameState,
		classes: Array<string | string[]>,
		requirements: HeadquartersTrainableRequirement[],
		gatherersOnly = false,
	): TemplateName | undefined
	{
		let units;
		if (classes.indexOf("Hero") !== -1)
		{
			units = gameState.findTrainableUnits(classes, []);
		}
		// We do not want siege tower as AI does not know how to use it nor hero when not explicitely specified.
		else
		{
			units = gameState.findTrainableUnits(classes, ["Hero", "SiegeTower"]);
		}
		if (gatherersOnly)
		{
			units = units.filter(([, template]) => template.resourceGatherRates() !== undefined);
		}

		if (!units.length)
		{
			return undefined;
		}

		const parameters = this.unitParameters(gameState, requirements);
		const config = gameState.ai.Config;
		units.sort((a: [string, CommonTemplate], b: [string, CommonTemplate]): number =>
		{
			const aCost = 1 + a[1].costSum();
			const bCost = 1 + b[1].costSum();
			return -unitValue(a[1], parameters, config, true) / aCost +
				unitValue(b[1], parameters, config, false) / bCost;
		});
		return units[0][0];
	}

	/** The requirements, with a lower value for units costing a resource we hold and have left little of */
	private unitParameters(
		gameState: CommonGameState,
		requirements: HeadquartersTrainableRequirement[],
	): HeadquartersTrainableRequirement[]
	{
		const parameters = requirements.slice();
		const remainingResources = this.basesManager.getTotalResourceLevel(gameState); // resources (estimation) still gatherable in our territory
		const availableResources = gameState.ai.queueManager.getAvailableResources(gameState); // available (gathered) resources
		for (const type in remainingResources)
		{
			if (availableResources[type] > 800)
			{
				continue;
			}
			if (remainingResources[type] > 800)
			{
				continue;
			}
			const costsResource = remainingResources[type] > 400 ? 0.6 : 0.2;
			let toAdd = true;
			for (const param of parameters)
			{
				if (param[0] !== "costsResource" || param[2] !== type)
				{
					continue;
				}
				param[1] = Math.min(param[1], costsResource);
				toAdd = false;
				break;
			}
			if (toAdd)
			{
				parameters.push(["costsResource", costsResource, type]);
			}
		}
		return parameters;
	}

	/**
	 * Returns the wanted gather rate.
	 */
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
	pickMostNeededResources(
		gameState: CommonGameState,
		allowedResources: string[] = [],
	): Array<{ type: string; wanted: number; current: number; }>
	{
		const wantedRates = this.GetWantedGatherRates(gameState);
		const currentRates = this.basesManager.GetCurrentGatherRates(gameState);
		if (!allowedResources.length)
		{
			allowedResources = Resources.GetCodes();
		}

		const needed = [];
		for (const res of allowedResources)
		{
			needed.push({ type: res, wanted: wantedRates[res], current: currentRates[res] });
		}

		needed.sort(
			(
				a: { type: string; wanted: number; current: number; },
				b: { type: string; wanted: number; current: number; },
			): number =>
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
			},
		);
		return needed;
	}

	/**
	 * Returns the best position to build a new market: if the allies already have a market, build it as far as possible
	 * from it, although not in our border to be able to defend it easily. If no allied market, our second market will
	 * follow the same logic.
	 * To do so, we suppose that the gain/distance is an increasing function of distance and look for the max distance
	 * for performance reasons.
	 */

	/** A civic centre was ordered at `pos` (ConstructionPlan.start): followed until it stands. */
	noteCivCentreOrdered(gameState: CommonGameState, pos: CommonPosition): void
	{
		this.ccOrders.push({ pos, time: gameState.ai.elapsedTime, seen: false });
	}

	/**
	 * Whether a civic centre spot is contested (FINDINGS §39): remembered as
	 * failed, on a land with enemy buildings where we have no base, or with
	 * enemy soldiers within CC_ENEMY_AVOID metres. Petra sent its builders to
	 * islands the enemy held, and their foundations were lost unbuilt.
	 */

	/**
	 * A saving town (little wood on its land from the start), or any town on
	 * a naval map, with under DRY_WOOD left within reach of its bases: what
	 * wood it has in stock is all it will have until a market barters for more
	 * (FINDINGS §37; §39: on Dodecanese a town that started with plenty ran
	 * dry by minute 40 and held 14 wood against 12000 food and 6000 metal for
	 * the rest of the game). On mainland a dry town expands by land.
	 */
	landRunDry(gameState: CommonGameState): boolean
	{
		return (!!this.saveResources || this.geography.navalMap) &&
			this.basesManager.getTotalResourceLevel(gameState, ["wood"], ["nearby", "medium", "faraway"]).wood <
				DRY_WOOD;
	}

	/** Whether a planned house may be paid now (decision/housing.ts). */
	houseNeeded(gameState: CommonGameState): boolean
	{
		return houseNeeded(censusOf(gameState), !!this.saveResources);
	}

	/**
	 * train with highest priority ranged infantry in the nearest civil center from a given set of positions
	 * and garrison them there for defense
	 */
	trainEmergencyUnits(gameState: CommonGameState, positions: CommonPosition[]): boolean
	{
		if (gameState.ai.queues.emergency.hasQueuedUnits())
		{
			return false;
		}

		const civ = gameState.getPlayerCiv();
		// find nearest base anchor
		const distcut = 20000;
		const { nearestAnchor, distmin } = this.nearestFreeAnchor(gameState, positions, civ);
		if (!nearestAnchor || distmin > distcut)
		{
			return false;
		}

		// We will choose randomly ranged and melee units, except when garrisonHolder is full
		// in which case we prefer melee units
		const autogarrison = this.makeRoomToGarrison(nearestAnchor);
		const rangedWanted = randBool() && autogarrison;

		const templateFound = emergencyTemplate(gameState, nearestAnchor, civ, autogarrison, rangedWanted);
		if (!templateFound)
		{
			return false;
		}

		// Check first if we can afford it without touching the other accounts
		// and if not, take some of other accounted resources
		// TODO sort the queues to be substracted
		gameState.ai.queueManager.fund(gameState, new ResourcesManager(templateFound[1].cost()), "emergency");
		const metadata: PlanMetadata = {
			role: Worker.ROLE_WORKER,
			base: nearestAnchor.getMetadata(PlayerID, "base"),
			plan: PLAN_RESERVE,
			trainer: nearestAnchor.id(),
		};
		if (autogarrison)
		{
			metadata.garrisonType = GarrisonManager.TYPE_PROTECTION;
		}
		gameState.ai.queues.emergency.addPlan(new TrainingPlan(gameState, templateFound[0], metadata, 1, 1));
		return true;
	}

	/** The base anchor nearest one of the positions on its land that trains and is not busy for long, and its square distance */
	private nearestFreeAnchor(
		gameState: CommonGameState,
		positions: CommonPosition[],
		civ: string,
	): { nearestAnchor: CommonEntity | undefined; distmin: number; }
	{
		let nearestAnchor: CommonEntity | undefined;
		let distmin = Infinity;
		for (const pos of positions)
		{
			const access = gameState.ai.accessibility.getAccessValue(pos);
			// check nearest base anchor
			for (const base of this.basesManager.baseManagers)
			{
				if (!base.anchor)
				{
					continue;
				}
				if (getLandAccess(gameState, base.anchor) !== access)
				{
					continue;
				}
				if (!base.anchor.trainableEntities(civ))
				{ // base still in construction
					continue;
				}
				if (busyTraining(base.anchor))
				{
					continue;
				}
				const dist = SquareVectorDistance(base.anchor.position(), pos);
				if (nearestAnchor && dist > distmin)
				{
					continue;
				}
				distmin = dist;
				nearestAnchor = base.anchor;
			}
		}
		return { nearestAnchor, distmin };
	}

	/**
	 * The anchor's training queue keeps only what garrisons there and what has started; whether its garrison
	 * still has room (and it is sound enough) for the emergency unit to garrison
	 */
	private makeRoomToGarrison(nearestAnchor: CommonEntity): boolean
	{
		let numGarrisoned = this.garrisonManager.numberOfGarrisonedSlots(nearestAnchor);
		const anchorQueue = nearestAnchor.trainingQueue();
		if (anchorQueue)
		{
			for (const item of anchorQueue)
			{
				// only unit batches are trained with a garrisonType metadata (Petra never
				// attaches it to research), so the unit-only `count` field is present.
				if (item.metadata && item.metadata.garrisonType)
				{
					numGarrisoned += item.count;
				}
				else if (!item.progress && (!item.metadata || !item.metadata.trainer))
				{
					nearestAnchor.stopProduction(item.id);
				}
			}
		}
		return numGarrisoned < nearestAnchor.garrisonMax() &&
			nearestAnchor.hitpoints() > nearestAnchor.garrisonEjectHealth() * nearestAnchor.maxHitpoints();
	}

	canBuild(gameState: CommonGameState, structure: string): boolean
	{
		const type = gameState.applyCiv(structure);
		if (this.buildManager.isUnbuildable(gameState, type))
		{
			return false;
		}

		if (gameState.isTemplateDisabled(type))
		{
			this.buildManager.setUnbuildable(gameState, type, Infinity, "disabled");
			return false;
		}

		const template = gameState.getTemplate(type);
		if (!template)
		{
			this.buildManager.setUnbuildable(gameState, type, Infinity, "notemplate");
			return false;
		}

		if (!template.available(gameState))
		{
			this.buildManager.setUnbuildable(gameState, type, 30, "requirements");
			return false;
		}

		if (!this.buildManager.hasBuilder(type))
		{
			this.buildManager.setUnbuildable(gameState, type, 120, "nobuilder");
			return false;
		}

		if (!this.basesManager.hasActiveBase())
		{
			// if no base, check that we can build outside our territory
			const buildTerritories = template.buildTerritories();
			if (
				buildTerritories &&
				(!buildTerritories.length || buildTerritories.length === 1 && buildTerritories[0] === "own")
			)
			{
				this.buildManager.setUnbuildable(gameState, type, 180, "room");
				return false;
			}
		}

		// build limits
		const limits = gameState.getEntityLimits();
		const category = template.buildCategory();
		if (category && limits[category] !== undefined && gameState.getEntityCounts()[category] >= limits[category])
		{
			this.buildManager.setUnbuildable(gameState, type, 90, "limit");
			return false;
		}

		return true;
	}

	updateTerritories(gameState: CommonGameState): void
	{
		const around = [[-0.7, 0.7], [0, 1], [0.7, 0.7], [1, 0], [0.7, -0.7], [0, -1], [-0.7, -0.7], [-1, 0]];
		const alliedVictory = gameState.getAlliedVictory();
		const passabilityMap = gameState.getPassabilityMap();
		const cellSize = this.geography.territoryMap.cellSize;
		const insideSmall = Math.round(45 / cellSize);
		const insideLarge = Math.round(80 / cellSize); // should be about the range of towers
		let expansion = 0;

		for (let jIndex = 0; jIndex < this.geography.territoryMap.length; ++jIndex)
		{
			const j = cellIndex(this.geography.territoryMap, jIndex);
			if (this.geography.borderMap.map[j] & mapMask.outside)
			{
				continue;
			}
			if (this.geography.borderMap.map[j] & mapMask.fullFrontier)
			{
				this.geography.borderMap.map[j] &= ~mapMask.fullFrontier; // reset the frontier
			}

			if (this.geography.territoryMap.getOwnerIndex(j) !== PlayerID)
			{
				this.basesManager.removeBaseFromTerritoryIndex(j);
			}
			else
			{
				// Update the frontier
				const frontier = this.placement.frontierAt(gameState, j, {
					around,
					alliedVictory,
					insideSmall,
					insideLarge,
				});
				if (frontier.narrow)
				{
					this.geography.borderMap.map[j] |= mapMask.narrowFrontier;
				}
				if (frontier.onFrontier && !(this.geography.borderMap.map[j] & mapMask.narrowFrontier))
				{
					this.geography.borderMap.map[j] |= mapMask.largeFrontier;
				}

				if (this.basesManager.addTerritoryIndexToBase(gameState, j, passabilityMap))
				{
					expansion++;
				}
			}
		}

		if (!expansion)
		{
			return;
		}
		// We've increased our territory, so we may have some new room to build
		this.buildManager.resetMissingRoom(gameState);
		// And if sufficient expansion, check if building a new market would improve our present trade routes
		const cellArea = this.geography.territoryMap.cellSize * this.geography.territoryMap.cellSize;
		if (expansion * cellArea > 960)
		{
			this.tradeManager.routeProspection = true;
		}
	}

	isDangerousLocation(gameState: CommonGameState, pos: CommonPosition, radius: number): boolean
	{
		return this.isNearInvadingArmy(pos) || this.isUnderEnemyFire(gameState, pos, radius);
	}

	/** Check that the chosen position is not too near from an invading army */
	isNearInvadingArmy(pos: CommonPosition): boolean
	{
		for (const army of this.defenseManager.armies)
		{
			if (army.foePosition && SquareVectorDistance(army.foePosition, pos) < 12000)
			{
				return true;
			}
		}
		return false;
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

	/** The capture tally's targets and time, as the save keeps them (HeadquartersSerializedData) */
	get capturableTargets(): Map<EntityId, CaptureEntry>
	{
		return this.captures.targets;
	}

	set capturableTargets(targets: Map<EntityId, CaptureEntry>)
	{
		this.captures.targets = targets;
	}

	get capturableTargetsTime(): GameSeconds
	{
		return this.captures.time;
	}

	set capturableTargetsTime(time: GameSeconds)
	{
		this.captures.time = time;
	}

	/**
	 * Check if a structure in blinking territory should/can be defended (currently if it has some attacking armies around)
	 */
	isDefendable(ent: CommonPlacedEntity): boolean
	{
		if (!this.turnCache.numAround)
		{
			this.turnCache.numAround = {};
		}
		if (this.turnCache.numAround[ent.id()] === undefined)
		{
			this.turnCache.numAround[ent.id()] = this.attackManager.numAttackingUnitsAround(ent.position(), 130);
		}
		return +this.turnCache.numAround[ent.id()] > 8;
	}

	/**
	 * Get the number of population already accounted for
	 */
	getAccountedPopulation(gameState: CommonGameState): number
	{
		if (this.turnCache.accountedPopulation === undefined)
		{
			let pop = gameState.getPopulation();
			for (const ent of gameState.getOwnTrainingFacilities().values())
			{
				for (const item of (ent.trainingQueue() ?? []))
				{
					if (!item.unitTemplate)
					{
						continue;
					}
					// a batch in training: its template exists
					const unitTemplate = requireTemplate(gameState, item.unitTemplate);
					// template leaves are strings (parsed XML)
					const unitPop = Number(unitTemplate.get("Cost/Population"));
					if (unitPop)
					{
						pop += item.count * unitPop;
					}
				}
			}
			this.turnCache.accountedPopulation = pop;
		}
		return this.turnCache.accountedPopulation;
	}

	/**
	 * Get the number of workers already accounted for
	 */
	getAccountedWorkers(gameState: CommonGameState): number
	{
		if (this.turnCache.accountedWorkers === undefined)
		{
			let workers = gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true).length;
			for (const ent of gameState.getOwnTrainingFacilities().values())
			{
				for (const item of (ent.trainingQueue() ?? []))
				{
					if (!item.metadata || !item.metadata.role || item.metadata.role !== Worker.ROLE_WORKER)
					{
						continue;
					}
					workers += item.count;
				}
			}
			this.turnCache.accountedWorkers = workers;
		}
		return this.turnCache.accountedWorkers;
	}

	/**
	 * Some functions are run every turn
	 * Others once in a while
	 */
	update(gameState: CommonGameState, queues: HeadquartersQueues, events: HeadquartersEvents): void
	{
		Engine.ProfileStart("Headquarters update");
		this.updateWorld(gameState, queues);
		notePhase(this, gameState);

		profiled("HQ checkEvents", () => checkEvents(this, gameState, events));
		profiled("HQ naval checkEvents", () => this.navalManager.checkEvents(gameState, queues, events));

		if (this.phasing)
		{
			checkPhaseRequirements(this, gameState, queues);
		}
		else
		{
			this.researchManager.checkPhase(gameState, queues);
		}

		if (this.basesManager.hasActiveBase())
		{
			this.updateTown(gameState, queues);
		}
		this.updateBuildings(gameState, queues);

		profiled("HQ trade", () => this.tradeManager.update(gameState, events, queues));
		profiled("HQ garrison", () => this.garrisonManager.update(gameState, events));
		profiled("HQ defense", () => this.defenseManager.update(gameState, events));

		if (gameState.ai.playedTurn % 3 === 0)
		{
			profiled("HQ training buildings and defenses", () =>
			{
				constructTrainingBuildings(this, gameState, queues);
				if (this.Config.difficulty > difficulty.SANDBOX)
				{
					buildDefenses(this, gameState, queues);
				}
			});
		}

		profiled("HQ bases", () => this.basesManager.update(gameState, queues, events));
		profiled("HQ naval", () => this.navalManager.update(gameState, queues, events));

		if (this.Config.difficulty > difficulty.SANDBOX && (this.basesManager.hasActiveBase() || !this.canBuildUnits))
		{
			profiled("HQ attacks", () => this.attackManager.update(gameState, queues, events));
		}

		profiled("HQ diplomacy", () => this.diplomacyManager.update(gameState, events));
		profiled("HQ victory", () => this.victoryManager.update(gameState, events, queues));

		// We update the capture strength at the end as it can change attack orders
		if (gameState.ai.elapsedTime - this.capturableTargetsTime > 3)
		{
			profiled("HQ updateCaptureStrength", () => updateCaptureStrength(gameState, this.captures));
		}

		Engine.ProfileStop();
	}

	/** The turn's view of the world: emergencies, the economy measured, the territory, our civic centre orders, the sea */
	private updateWorld(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		profiled("HQ emergency", () => this.emergencyManager.update(gameState));
		this.turnCache = {};
		profiled("HQ gatherEconomy", () => this.gatherEconomy.update(gameState));
		profiled("HQ productionLoad", () => this.productionLoad.update(gameState));
		profiled("HQ territoryMap", () =>
		{
			this.geography.territoryMap = createTerritoryMap(gameState);
		});
		profiled("HQ followCivCentreOrders", () => followCivCentreOrders(this, gameState));
		if (gameState.ai.playedTurn % 10 === 3)
		{
			provideForDryLand(this, gameState, queues);
		}
		if (this.geography.navalMap)
		{
			const map = this.geography.territoryMap;
			this.shipTraffic ??= new ShipTraffic(map.width * map.cellSize, map.height * map.cellSize);
			this.shipTraffic.sample(gameState);
		}
		this.canBarter = gameState.getOwnEntitiesByClass("Market", true).filter(filters.isBuilt()).hasEntities();
	}

	/** A town's turn, one task in four: workers, houses, a farmstead, a corral; research one turn in five */
	private updateTown(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		const turn = gameState.ai.playedTurn;
		if (turn % 4 === 0)
		{
			profiled("HQ trainMoreWorkers", () => trainMoreWorkers(this, gameState, queues));
		}
		if (turn % 4 === 1)
		{
			profiled("HQ buildMoreHouses", () => buildMoreHouses(this, gameState, queues));
		}
		if ((!this.saveResources || this.canBarter) && turn % 4 === 2)
		{
			profiled("HQ buildFarmstead", () => buildFarmstead(this, gameState, queues));
		}
		if (this.needCorral && turn % 4 === 3)
		{
			profiled("HQ manageCorral", () => manageCorral(this, gameState, queues));
		}
		if (turn % 5 === 1)
		{
			profiled("HQ research", () => this.researchManager.update(gameState, queues));
		}
	}

	/** New bases, the markets, the forge, the temple and the wonder */
	private updateBuildings(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (
			!this.basesManager.hasPotentialBase() ||
			this.canExpand && gameState.ai.playedTurn % 10 === 7 && this.currentPhase > 1
		)
		{
			profiled("HQ checkBaseExpansion", () => checkBaseExpansion(this, gameState, queues));
		}

		if (this.currentPhase === 1 && gameState.ai.playedTurn % 3 === 0 && !this.canBarter)
		{
			buildEarlyMarket(this, gameState, queues);
		}
		if (this.currentPhase <= 1 || gameState.ai.playedTurn % 3 !== 0)
		{
			return;
		}
		profiled("HQ market forge temple wonder", () =>
		{
			if (!this.canBarter)
			{
				buildMarket(this, gameState, queues);
			}

			if (!this.saveResources)
			{
				buildForge(this, gameState, queues);
				buildTemple(this, gameState, queues);
			}

			if (gameState.ai.playedTurn % 30 === 0 && gameState.getPopulation() > 0.9 * gameState.getPopulationMax())
			{
				buildWonder(this, gameState, queues, false);
			}
		});
	}

	Serialize(): HeadquartersSerializedData
	{
		const properties = {
			phasing: this.phasing,
			lastFailedGather: this.lastFailedGather,
			firstBaseConfig: this.firstBaseConfig,
			supportRatio: this.supportRatio,
			targetNumWorkers: this.targetNumWorkers,
			fortStartTime: this.fortStartTime,
			towerStartTime: this.towerStartTime,
			fortressStartTime: this.fortressStartTime,
			bAdvanced: this.bAdvanced,
			saveResources: this.saveResources,
			saveSpace: this.saveSpace,
			needCorral: this.needCorral,
			needFarm: this.needFarm,
			needFish: this.needFish,
			maxFields: this.maxFields,
			canExpand: this.canExpand,
			canBuildUnits: this.canBuildUnits,
			navalMap: this.geography.navalMap,
			landRegions: this.geography.landRegions,
			navalRegions: this.geography.navalRegions,
			decayingStructures: this.decayingStructures,
			capturableTargets: this.capturableTargets,
			capturableTargetsTime: this.capturableTargetsTime,
		};

		if (this.Config.debug === -100)
		{
			aiWarn(" HQ serialization ---------------------");
			aiWarn(" properties " + uneval(properties));
			aiWarn(" basesManager " + uneval(this.basesManager.Serialize()));
			aiWarn(" attackManager " + uneval(this.attackManager.Serialize()));
			aiWarn(" buildManager " + uneval(this.buildManager.Serialize()));
			aiWarn(" defenseManager " + uneval(this.defenseManager.Serialize()));
			aiWarn(" tradeManager " + uneval(this.tradeManager.Serialize()));
			aiWarn(" navalManager " + uneval(this.navalManager.Serialize()));
			aiWarn(" researchManager " + uneval(this.researchManager.Serialize()));
			aiWarn(" diplomacyManager " + uneval(this.diplomacyManager.Serialize()));
			aiWarn(" garrisonManager " + uneval(this.garrisonManager.Serialize()));
			aiWarn(" victoryManager " + uneval(this.victoryManager.Serialize()));
			aiWarn(" emergencyManager " + uneval(this.emergencyManager.Serialize()));
		}

		return {
			properties: properties,

			basesManager: this.basesManager.Serialize(),
			attackManager: this.attackManager.Serialize(),
			buildManager: this.buildManager.Serialize(),
			defenseManager: this.defenseManager.Serialize(),
			tradeManager: this.tradeManager.Serialize(),
			navalManager: this.navalManager.Serialize(),
			researchManager: this.researchManager.Serialize(),
			diplomacyManager: this.diplomacyManager.Serialize(),
			garrisonManager: this.garrisonManager.Serialize(),
			victoryManager: this.victoryManager.Serialize(),
			emergencyManager: this.emergencyManager.Serialize(),
			gatherEconomy: this.gatherEconomy.Serialize(),
		};
	}
}
