import * as filters from "simulation/ai/common-api/filters.js";
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";
import { SquareVectorDistance, aiWarn } from "simulation/ai/common-api/utils.js";
import { GAIA, NEW_BASE, NO_BASE, cellIndex, playerId, seconds, worldPos } from "../adapter/brands.ts";
import { debugWarn } from "../adapter/debug.ts";
import {
	allowCapture,
	getAttackBonus,
	getLandAccess,
	getMaxStrength,
	requireTemplate,
	setSeaAccess,
} from "../adapter/entityExtend.ts";
import { ordersOf } from "../adapter/orders.ts";
import { isPlaced } from "../adapter/placed.ts";
import { isStructureTemplate } from "../adapter/templateData.ts";
import { hasActivity } from "../adapter/unitState.ts";
import { AttackPlan } from "../execution/attackPlan.ts";
import { type PlanMetadata } from "../execution/queueplan.ts";
import { ConstructionPlan } from "../execution/queueplanBuilding.ts";
import { TrainingPlan } from "../execution/queueplanTraining.ts";
import { PLAN_RESERVE } from "../execution/unitPlan.ts";
import { Worker } from "../execution/worker.ts";
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
import type { BaseManager } from "./baseManager.ts";
import { BasesManager } from "./basesManager.ts";
import { BuildManager } from "./buildManager.ts";
import { DefenseManager } from "./defenseManager.ts";
import { DiplomacyManager } from "./diplomacyManager.ts";
import { EmergencyManager } from "./emergencyManager.ts";
import { GarrisonManager } from "./garrisonManager.ts";
import { TIGHT_SLOTS, houseNeeded, planAnotherHouse, urgentHousePriority } from "./housing.ts";
import { NavalManager } from "./navalManager.ts";
import {
	findDefensiveSpot,
	findEconomicCCTile,
	findMarketSpot,
	findShoreTowerSpot,
	findStrategicCCTile,
	type EconomicCCOptions,
} from "./placement.ts";
import { ResearchManager } from "./researchManager.ts";
import { buildFirstBase, configFirstBase } from "./startingStrategy.ts";
import { TradeManager } from "./tradeManager.ts";
import { VictoryManager } from "./victoryManager.ts";
import {
	batchSize,
	soldierRequirements,
	supportAlpha,
	supportShare,
	trainingStopped,
	type TrainableRequirement,
} from "./workforce.ts";

type HeadquartersTurnCache = {
	buildingBuilt?: boolean;
	allowDistantFood?: boolean;
	wantedRates?: Record<string, number>;
	firingStructures?: CommonEntityCollection<CommonPlacedEntity>;
	numAround?: Record<number, number>;
	accountedPopulation?: number;
	accountedWorkers?: number;
};
type HeadquartersQueues = PetraRuntime.QueueCollection;
type HeadquartersTrainableRequirement = TrainableRequirement;
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
/** The share of the time our infantry trainers train above which another one is built (FINDINGS §29). */
const BUSY_TRAINERS = 0.85;
/** The most infantry trainers that rule builds up to. */
const MAX_MILITARY_TRAINERS = 5;

/** Idle workers from which a dry town stops training more (workforceStalled). */
export const STALLED_IDLE = 10;

/** Seconds a civic centre's foundation may take to appear once ordered (followCivCentreOrders). */
export const CC_ORDER_WAIT = 20;
/** Seconds a civic centre spot that failed, or whose foundation was lost, is avoided. */
export const CC_SPOT_MEMORY = 600;
/** Metres around such a spot avoided, and around enemy soldiers. */
const CC_SPOT_AVOID = 80;
export const CC_ENEMY_AVOID = 150;

/** Whether an entity is a market of ours */
function isOwnMarket(gameState: CommonGameState, id: EntityId): boolean
{
	const ent = gameState.getEntityById(id);
	return !!ent && ent.owner() === PlayerID && !!ent.hasClass("Market");
}

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

/** The barracks, range and stable templates we can build */
type TrainerTemplates = { barracks: string | undefined; range: string | undefined; stable: string | undefined; };

/** Put available resources in the queued market */
function fundMarket(gameState: CommonGameState, queues: HeadquartersQueues): void
{
	fundQueue(gameState, queues.economicBuilding.plans[0].getCost(), "economicBuilding");
}

/** A queue's account gets what is available for the cost, then other queues' until it can pay */
function fundQueue(gameState: CommonGameState, cost: ResourcesManager, queue: PetraRuntime.ConfiguredQueueName): void
{
	const queueManager = gameState.ai.queueManager;
	queueManager.setAccounts(gameState, cost, queue);
	if (queueManager.canAfford(queue, cost))
	{
		return;
	}
	for (const [q] of queueManager.entries())
	{
		if (q === queue)
		{
			continue;
		}
		queueManager.transferAccounts(cost, q, queue);
		if (queueManager.canAfford(queue, cost))
		{
			break;
		}
	}
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

/** The first huntable animal a corral may train of which we have (or train) no more than one per corral */
function corralAnimal(
	gameState: CommonGameState,
	corral: CommonEntity,
	civ: string,
	nCorral: number,
): TemplateName | undefined
{
	for (const trainable of (corral.trainableEntities(civ) ?? []))
	{
		if (gameState.isTemplateDisabled(trainable))
		{
			continue;
		}
		const template = gameState.getTemplate(trainable);
		if (!template || !template.isHuntable())
		{
			continue;
		}
		let count = gameState.countEntitiesByType(trainable, true);
		const corralTrainingQueue = corral.trainingQueue();
		if (corralTrainingQueue)
		{
			for (const item of corralTrainingQueue)
			{
				count += item.count;
			}
		}
		if (count > nCorral)
		{
			continue;
		}
		return trainable;
	}
	return undefined;
}

/** A plan for the next phase and its queue */
type PhasePlan = { plan: ConstructionPlan; queue: PetraRuntime.ConfiguredQueueName; };

/** Counting the workers that aren't part of a plan, those in training included: all, the support ones, and all units in training */
function countWorkers(
	gameState: CommonGameState,
): { numberOfWorkers: number; numberOfSupports: number; numberInTraining: number; }
{
	let numberOfWorkers = 0; // all workers
	let numberOfSupports = 0; // only support workers (i.e. non fighting)
	gameState.getOwnUnits().forEach((ent) =>
	{
		if (ent.getMetadata(PlayerID, "role") === Worker.ROLE_WORKER && ent.getMetadata(PlayerID, "plan") === undefined)
		{
			++numberOfWorkers;
			if (ent.hasClass("Support"))
			{
				++numberOfSupports;
			}
		}
	});
	let numberInTraining = 0;
	gameState.getOwnTrainingFacilities().forEach(function(ent: CommonEntity): void
	{
		const trainingQueue = ent.trainingQueue();
		if (!trainingQueue)
		{
			return;
		}
		for (const item of trainingQueue)
		{
			numberInTraining += item.count;
			if (
				item.metadata && item.metadata.role && item.metadata.role === Worker.ROLE_WORKER &&
				item.metadata.plan === undefined
			)
			{
				numberOfWorkers += item.count;
				if (item.metadata.support)
				{
					numberOfSupports += item.count;
				}
			}
		}
	});
	return { numberOfWorkers, numberOfSupports, numberInTraining };
}

/** Queue a support worker, or the citizen soldier found to train instead. */
function queueWorkerTraining(
	gameState: CommonGameState,
	queues: HeadquartersQueues,
	templateDef: TemplateName | undefined,
	template: TemplateName | undefined,
	size: number,
): void
{
	// If the template variable is empty, the default unit (Support unit) will be used
	// base "0" means automatic choice of base
	if (!template && templateDef)
	{
		queues.villager.addPlan(
			new TrainingPlan(
				gameState,
				templateDef,
				{ role: Worker.ROLE_WORKER, base: NO_BASE, support: true },
				size,
				size,
			),
		);
	}
	else if (template)
	{
		queues.citizenSoldier.addPlan(
			new TrainingPlan(gameState, template, { role: Worker.ROLE_WORKER, base: NO_BASE }, size, size),
		);
	}
}

/** The first two batches queued no bigger than size */
function capFirstBatches(queue: { plans: Array<{ number: number; }>; }, size: number): void
{
	if (!queue.plans[0])
	{
		return;
	}
	queue.plans[0].number = Math.min(queue.plans[0].number, size);
	if (queue.plans[1])
	{
		queue.plans[1].number = Math.min(queue.plans[1].number, size);
	}
}

/** A unit we captured: its old roles cleared, a trader, worker or soldier of ours */
function takeOverUnit(gameState: CommonGameState, ent: CommonEntity): void
{
	ent.setMetadata(PlayerID, "role", undefined);
	ent.setMetadata(PlayerID, "subrole", undefined);
	ent.setMetadata(PlayerID, "plan", undefined);
	ent.setMetadata(PlayerID, "PartOfArmy", undefined);
	if (ent.hasClass("Trader"))
	{
		ent.setMetadata(PlayerID, "role", Worker.ROLE_TRADER);
		ent.setMetadata(PlayerID, "route", undefined);
	}
	if (ent.hasClass("Worker") && ent.isGatherer())
	{
		ent.setMetadata(PlayerID, "role", Worker.ROLE_WORKER);
		ent.setMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE);
	}
	if (ent.hasClass("Ship"))
	{
		setSeaAccess(gameState, ent);
	}
	if (!ent.hasClasses(["Support", "Ship"]) && ent.attackTypes() !== undefined)
	{
		ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
	}
}

/** A building of ours starting to train: its trained units will autogarrison if its first batch is to */
function setTrainingRallyPoint(gameState: CommonGameState, entity: EntityId): void
{
	const ent = gameState.getEntityById(entity);
	if (!ent || !ent.isOwn(PlayerID))
	{
		return;
	}

	const trainingQueue = ent.trainingQueue();
	if (!trainingQueue || !trainingQueue.length)
	{
		return;
	}
	const metadata = trainingQueue[0].metadata;
	if (metadata && metadata.garrisonType)
	{
		ent.setRallyPoint(ent, "garrison"); // trained units will autogarrison
	}
	else
	{
		ent.unsetRallyPoint();
	}
}

/**
 * Whether a decaying structure of ours is being lost to an enemy: half its capture points or more still ours,
 * an enemy's among the others, and below a random ratio (higher when it is attacked)
 */
function lostToEnemy(gameState: CommonGameState, ent: CommonEntity, events: HeadquartersEvents): boolean
{
	const capture = ent.capturePoints();
	if (!capture)
	{
		return false;
	}
	const captureRatio = capture[PlayerID] / capture.reduce((a: number, b: number): number => a + b);
	if (captureRatio < 0.50)
	{
		return false;
	}
	let decayToGaia = true;
	for (let iIndex = 1; iIndex < capture.length; ++iIndex)
	{
		const i = playerId(iIndex);
		if (gameState.isPlayerAlly(i) || !capture[i])
		{
			continue;
		}
		decayToGaia = false;
		break;
	}
	if (decayToGaia)
	{
		return false;
	}
	let ratioMax = 0.7 + randFloat(0, 0.1);
	for (const evt of events.Attacked)
	{
		if (ent.id() !== evt.target)
		{
			continue;
		}
		ratioMax = 0.85 + randFloat(0, 0.1);
		break;
	}
	return !(captureRatio > ratioMax);
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
	capturableTargets: Map<EntityId, { strength: number; ents: Set<EntityId>; }>;
	capturableTargetsTime: GameSeconds;
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

		this.capturableTargets = new Map();
		this.capturableTargetsTime = seconds(0);

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

	/** checkEvents: units trained. */
	onTrainingFinished(gameState: CommonGameState, events: HeadquartersEvents): void
	{
		for (const evt of events.TrainingFinished)
		{
			for (const entId of evt.entities)
			{
				const ent = gameState.getEntityById(entId);
				if (!ent || !ent.isOwn(PlayerID))
				{
					continue;
				}

				if (!isPlaced(ent))
				{
					this.checkAutogarrison(gameState, ent);
				}
				else if (ent.getMetadata(PlayerID, "garrisonType"))
				{
					// we were supposed to be autogarrisoned, but this has failed (may-be full)
					ent.setMetadata(PlayerID, "garrisonType", undefined);
				}

				// Check if this unit is no more needed in its attack plan
				// (happen when the training ends after the attack is started or aborted)
				const plan = ent.getMetadata(PlayerID, "plan");
				if (plan !== undefined && plan >= 0)
				{
					const attack = this.attackManager.getPlan(plan);
					if (!attack || attack.state !== AttackPlan.STATE_UNEXECUTED)
					{
						ent.setMetadata(PlayerID, "plan", PLAN_RESERVE);
					}
				}
			}
		}
	}

	/**
	 * we are autogarrisoned, check that the holder is registered in the garrisonManager.
	 * The rally point garrisons a whole building's batches, set from the one
	 * at the head of its queue as we last saw it: a unit not trained to
	 * garrison (one of an attack, say) comes out again.
	 */
	private checkAutogarrison(gameState: CommonGameState, ent: CommonEntity): void
	{
		const holderID = ent.garrisonHolderID();
		const holder = holderID === undefined ? undefined : gameState.getEntityById(holderID);
		if (holder && !ent.getMetadata(PlayerID, "garrisonType"))
		{
			holder.unload(ent.id());
		}
		else if (holder)
		{
			this.garrisonManager.registerHolder(gameState, holder);
		}
	}

	checkEvents(gameState: CommonGameState, events: HeadquartersEvents): void
	{
		this.buildManager.checkEvents(gameState, events);
		this.updateTerritories(gameState);

		// Reset the entities collections which depend on diplomacy
		if (events.DiplomacyChanged.some((evt) => evt.player === PlayerID || evt.otherPlayer === PlayerID))
		{
			gameState.resetOnDiplomacyChanged();
		}

		this.basesManager.checkEvents(gameState, events);

		// a market built lifts the fields' limit
		for (const evt of events.ConstructionFinished)
		{
			if (evt.newentity !== evt.entity && this.maxFields && isOwnMarket(gameState, evt.newentity))
			{ // not a repaired building
				this.maxFields = false;
			}
		}

		for (const evt of events.OwnershipChanged)
		{ // capture events
			if (evt.to === PlayerID)
			{
				this.onCaptured(gameState, evt.entity);
			}
		}

		// deal with the different rally points of training units: the rally point is set when the training starts
		// for the time being, only autogarrison is used
		for (const evt of events.TrainingStarted)
		{
			setTrainingRallyPoint(gameState, evt.entity);
		}

		this.onTrainingFinished(gameState, events);

		for (const evt of events.TerritoryDecayChanged)
		{
			this.onDecayChanged(gameState, evt.entity, evt.to);
		}

		// Then deals with decaying structures: destroy them if being lost to enemy (except in easier difficulties)
		if (this.Config.difficulty >= difficulty.EASY)
		{
			this.destroyLostStructures(gameState, events);
		}
	}

	/** Our decaying structures being lost to an enemy are destroyed; those no more decaying (or gone) forgotten */
	private destroyLostStructures(gameState: CommonGameState, events: HeadquartersEvents): void
	{
		for (const entId of this.decayingStructures)
		{
			const ent = gameState.getEntityById(entId);
			if (ent && ent.decaying() && ent.isOwn(PlayerID))
			{
				if (!lostToEnemy(gameState, ent, events))
				{
					continue;
				}
				ent.destroy();
			}
			this.decayingStructures.delete(entId);
		}
	}

	/** A building of ours starting or stopping to decay */
	private onDecayChanged(gameState: CommonGameState, entity: EntityId, decaying: boolean): void
	{
		const ent = gameState.getEntityById(entity);
		if (!ent || !ent.isOwn(PlayerID) || ent.foundationProgress() !== undefined)
		{
			return;
		}
		if (decaying)
		{
			this.noteDecaying(gameState, ent, false);
		}
		else if (ent.isGarrisonHolder())
		{
			this.garrisonManager.removeDecayingStructure(entity);
		}
	}

	/** An entity we captured: a decaying structure is followed, a unit taken over */
	private onCaptured(gameState: CommonGameState, entity: EntityId): void
	{
		const ent = gameState.getEntityById(entity);
		if (!ent)
		{
			return;
		}
		if (!ent.hasClass("Unit"))
		{
			if (ent.decaying())
			{
				this.noteDecaying(gameState, ent, true);
			}
			return;
		}
		takeOverUnit(gameState, ent);
	}

	/** A structure of ours decaying: garrisoned against it if it may be (justCaptured too), else followed */
	private noteDecaying(gameState: CommonGameState, ent: CommonEntity, justCaptured: boolean): void
	{
		if (
			ent.isGarrisonHolder() &&
			this.garrisonManager.addDecayingStructure(gameState, ent.id(), justCaptured || undefined)
		)
		{
			return;
		}
		if (!this.decayingStructures.has(ent.id()))
		{
			this.decayingStructures.add(ent.id());
		}
	}

	handleNewBase(gameState: CommonGameState): void
	{
		if (!this.firstBaseConfig)
		{
			// This is our first base, let us configure our starting resources.
			configFirstBase(this, gameState);
		}
		else
		{
			// Let us hope this new base will fix our possible resource shortage.
			this.saveResources = undefined;
			this.saveSpace = undefined;
			this.maxFields = false;
		}
	}

	/** Ensure that all requirements are met when phasing up*/
	checkPhaseRequirements(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (gameState.getNumberOfPhases() === this.currentPhase)
		{
			return;
		}

		const requirements = gameState.getPhaseEntityRequirements(this.currentPhase + 1);
		for (const entityReq of requirements)
		{
			// Village requirements are met elsewhere by constructing more houses
			if (entityReq.class === "Village" || entityReq.class === "NotField")
			{
				continue;
			}
			if (gameState.getOwnEntitiesByClass(entityReq.class, true).length >= entityReq.count)
			{
				continue;
			}
			const phasePlan = entityReq.class === "Town" ?
				this.townPhasePlan(gameState, queues) :
				this.phasePlanWithClass(gameState, queues, entityReq.class);
			if (phasePlan)
			{
				this.queuePhasePlan(gameState, queues, phasePlan);
				return;
			}
		}
	}

	/** A market, else a temple, else a forge for the town phase, unless an economic or military building is queued */
	private townPhasePlan(gameState: CommonGameState, queues: HeadquartersQueues): PhasePlan | undefined
	{
		if (queues.economicBuilding.hasQueuedUnits() || queues.militaryBuilding.hasQueuedUnits())
		{
			return undefined;
		}
		const options: Array<[string, string, PetraRuntime.ConfiguredQueueName]> = [
			["Market", "structures/{civ}/market", "economicBuilding"],
			["Temple", "structures/{civ}/temple", "economicBuilding"],
			["Forge", "structures/{civ}/forge", "militaryBuilding"],
		];
		for (const [className, templateName, queue] of options)
		{
			if (
				!gameState.getOwnEntitiesByClass(className, true).hasEntities() &&
				this.canBuild(gameState, templateName)
			)
			{
				return { plan: new ConstructionPlan(gameState, templateName, { phaseUp: true }), queue };
			}
		}
		return undefined;
	}

	/**
	 * A structure of a class the phase requires, not dealt with inside vanilla game: for the time being on the
	 * economic queue, except if wonder; none while that queue has one
	 */
	private phasePlanWithClass(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		className: string,
	): PhasePlan | undefined
	{
		const queue = className === "Wonder" ? "wonder" : "economicBuilding";
		if (queues[queue].hasQueuedUnits())
		{
			return undefined;
		}
		const structure = this.buildManager.findStructureWithClass(gameState, [className]);
		if (structure && this.canBuild(gameState, structure))
		{
			return { plan: new ConstructionPlan(gameState, structure, { phaseUp: true }), queue };
		}
		return undefined;
	}

	/** A plan for the next phase goes first in its queue, raised meanwhile (the major techs' for a wonder) */
	private queuePhasePlan(gameState: CommonGameState, queues: HeadquartersQueues, phasePlan: PhasePlan): void
	{
		const { plan, queue } = phasePlan;
		if (queue === "wonder")
		{
			gameState.ai.queueManager.changePriority("majorTech", 400);
			plan.queueToReset = "majorTech";
		}
		else
		{
			gameState.ai.queueManager.changePriority(queue, 1000);
			plan.queueToReset = queue;
		}
		queues[queue].addPlan(plan);
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

	/** This code trains citizen workers, trying to keep close to a ratio of worker/soldiers */
	trainMoreWorkers(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		// default template
		const requirementsDef: HeadquartersTrainableRequirement[] = [["costsResource", 1, "food"]];
		const classesDef = ["Support+Worker"];
		const templateDef = this.findBestTrainableUnit(gameState, classesDef, requirementsDef);

		const { numberOfWorkers, numberOfSupports, numberInTraining } = countWorkers(gameState);

		// Anticipate the optimal batch size when this queue will start
		// and adapt the batch size of the first and second queued workers to the present population
		// to ease a possible recovery if our population was drastically reduced by an attack
		// (need to go up to second queued as it is accounted in queueManager)
		const size = batchSize(numberOfWorkers);
		capFirstBatches(queues.villager, size);
		capFirstBatches(queues.citizenSoldier, size);

		const numberOfQueuedSupports = queues.villager.countQueuedUnits();
		const numberOfQueuedSoldiers = queues.citizenSoldier.countQueuedUnits();
		const numberTotal = numberOfWorkers + numberOfQueuedSupports + numberOfQueuedSoldiers;

		// with the land run dry and many hands idle, no more of them, and those queued let go (FINDINGS §40)
		const stalled = this.workforceStalled(gameState);
		if (stalled)
		{
			queues.villager.empty();
			queues.citizenSoldier.empty();
		}
		// getPhaseName(2) is optional: preserve original semantics (isResearching(undefined) === false)
		const phaseName2 = gameState.getPhaseName(2);
		if (
			trainingStopped({
				workers: numberOfWorkers,
				queuedSupports: numberOfQueuedSupports,
				queuedSoldiers: numberOfQueuedSoldiers,
				inTraining: numberInTraining,
				target: this.targetNumWorkers,
				popPhase2: this.Config.Economy.popPhase2,
				waitingForTown: this.currentPhase === 1 &&
					(phaseName2 === undefined || !gameState.isResearching(phaseName2)),
				saving: !!this.saveResources,
				stalled,
			})
		)
		{
			return;
		}

		// soldiers or support units (decision/workforce.ts)
		const alpha = supportAlpha(
			this.attackManager.rushNumber < this.attackManager.maxRushes ||
				this.attackManager.upcomingAttacks[AttackPlan.TYPE_RUSH].length > 0,
			gameState.isCeasefireActive() ? gameState.ceasefireTimeRemaining : undefined,
		);
		const supportNum = supportShare(
			numberTotal,
			this.supportRatio,
			this.targetNumWorkers,
			alpha,
			!!gameState.isTemplateAvailable(gameState.applyCiv("structures/{civ}/field")),
		);

		const template = !templateDef || numberOfSupports + numberOfQueuedSupports > supportNum ?
			this.citizenSoldierTemplate(gameState, numberTotal) :
			undefined;

		queueWorkerTraining(gameState, queues, templateDef, template, size);
	}

	/** A citizen soldier to train: at least 33% ranged and 33% melee; only units that gather (a mercenary, Athens' archers, is a citizen soldier by its classes) */
	private citizenSoldierTemplate(gameState: CommonGameState, numberTotal: number): TemplateName | undefined
	{
		const requirements = soldierRequirements(numberTotal);
		const classes = [["CitizenSoldier", "Infantry"]];
		const pickedClass = pickRandom(["Ranged", "Melee", "Infantry"]);
		if (pickedClass !== undefined)
		{
			classes[0].push(pickedClass);
		}
		return this.findBestTrainableUnit(gameState, classes, requirements, true);
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
		const remainingResources = this.getTotalResourceLevel(gameState); // resources (estimation) still gatherable in our territory
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
	 * returns an entity collection of workers through BaseManager.pickBuilders
	 * TODO: when same accessIndex, sort by distance
	 */
	bulkPickWorkers(gameState: CommonGameState, baseRef: BaseManager, number: number): CommonEntityCollection | false
	{
		return this.basesManager.bulkPickWorkers(gameState, baseRef, number);
	}

	getTotalResourceLevel(
		gameState: CommonGameState,
		resources?: string[],
		proximity?: string[],
	): Record<string, number>
	{
		return this.basesManager.getTotalResourceLevel(gameState, resources, proximity);
	}

	/**
	 * Returns the current gather rate
	 * This is not per-se exact, it performs a few adjustments ad-hoc to account for travel distance, stuffs like that.
	 */
	GetCurrentGatherRates(gameState: CommonGameState): Record<string, number>
	{
		return this.basesManager.GetCurrentGatherRates(gameState);
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
		const currentRates = this.GetCurrentGatherRates(gameState);
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
	 * Returns the best position to build a new Civil Center
	 * Whose primary function would be to reach new resources of type "resource".
	 */
	findEconomicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
		resource: string,
		options: EconomicCCOptions = {},
	): false | CommonPosition
	{
		const spot = findEconomicCCTile(this, gameState, template, { resource, options, allowContested: false }) ||
			(options.forRoom ?
				findEconomicCCTile(this, gameState, template, { resource, options, allowContested: true }) :
				false);
		return spot ? this.newBaseAt(gameState, spot.bestIdx, spot.obstructions) : false;
	}

	/** A new base's position at an obstruction tile; a minimal number of wanted ships in the seas reaching it */
	private newBaseAt(
		gameState: CommonGameState,
		bestIdx: number,
		obstructions: { width: number; cellSize: number; },
	): CommonPosition
	{
		const x = (bestIdx % obstructions.width + 0.5) * obstructions.cellSize;
		const z = (Math.floor(bestIdx / obstructions.width) + 0.5) * obstructions.cellSize;

		const indexIdx = gameState.ai.accessibility.landPassMap[bestIdx];
		for (const base of this.baseManagers())
		{
			if (!base.anchor || base.accessIndex === undefined || base.accessIndex === indexIdx)
			{
				continue;
			}
			const sea = this.getSeaBetweenIndices(gameState, base.accessIndex, indexIdx);
			if (sea !== undefined)
			{
				this.navalManager.setMinimalTransportShips(gameState, sea, 1);
			}
		}

		return worldPos(x, z);
	}

	/**
	 * Returns the best position to build a new Civil Center
	 * Whose primary function would be to assure territorial continuity with our allies
	 */
	findStrategicCCLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | CommonPosition | undefined
	{
		const spot = findStrategicCCTile(this, gameState, template);
		if (spot === "economic")
		{
			return this.findEconomicCCLocation(gameState, template, "wood", { fromStrategic: true });
		}
		return spot && this.newBaseAt(gameState, spot.bestIdx, spot.obstructions);
	}

	/**
	 * Returns the best position to build a new market: if the allies already have a market, build it as far as possible
	 * from it, although not in our border to be able to defend it easily. If no allied market, our second market will
	 * follow the same logic.
	 * To do so, we suppose that the gain/distance is an increasing function of distance and look for the max distance
	 * for performance reasons.
	 */
	/** [x, z, base, expected gain]; base -1 (and x, z -1) when the market goes where the standard placement puts it */
	findMarketLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): false | [number, number, BaseId | -1, number]
	{
		return this.tradeManager.minimalGain >= 0 ? findMarketSpot(this, gameState, template) : false;
	}

	/**
	 * Returns the best position to build defensive buildings (fortress and towers)
	 * Whose primary function is to defend our borders
	 */
	findDefensiveLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined
	{
		if (template.hasClass("Tower"))
		{
			const shore = this.findShoreTowerLocation(gameState, template);
			if (shore || this.towersByTrafficOnly(gameState))
			{
				return shore;
			}
		}
		return findDefensiveSpot(this, gameState, template);
	}

	/**
	 * Whether our towers go only where the enemy's ships pass: on a naval map,
	 * no enemy civic centre on a land of one of our bases. A tower stands 60 m
	 * from any other (its template's BuildRestrictions), and on small islands
	 * the early ones, put up facing an enemy town across the sea before any
	 * ship had sailed, left no room for one over the passages (FINDINGS §38).
	 */
	towersByTrafficOnly(gameState: CommonGameState): boolean
	{
		if (!this.shipTraffic)
		{
			return false;
		}
		const ourLands = new Set(this.baseManagers().map((base) => base.accessIndex));
		for (const centre of gameState.getEnemyStructures().filter(filters.byClass("CivCentre")).values())
		{
			if (centre.owner() !== GAIA && ourLands.has(getLandAccess(gameState, centre)))
			{
				return false;
			}
		}
		return true;
	}

	/**
	 * Whether the land has run dry (landRunDry) with more than a fifth of the
	 * workers, and at least STALLED_IDLE, standing idle: in a 4-player
	 * Dodecanese match a town went on training soldiers and women from 163 to
	 * 264 population while 200 stood idle, nothing left to gather on its
	 * islands, and the food they took was what its ships and attacks lacked
	 * (FINDINGS §40).
	 */
	workforceStalled(gameState: CommonGameState): boolean
	{
		const workers = gameState.getOwnEntitiesByRole(Worker.ROLE_WORKER, true);
		const idle = workers.filter(filters.byMetadata(PlayerID, "subrole", Worker.SUBROLE_IDLE)).length;
		return idle >= STALLED_IDLE && idle > workers.length / 5 && this.landRunDry(gameState);
	}

	/**
	 * When the land has run dry (landRunDry): the field limit of a small
	 * starting island lifted, as a market or a new base lifts it (with nothing
	 * left to gather, every field's room is worth taking; the fishing boats
	 * follow the fish left, NavalManager.fishByWhatIsLeft). In a 4-player Dodecanese
	 * match a town kept its 2 fields for 50 minutes after its islands ran
	 * dry, its workers idle, holding 6000 wood (FINDINGS §40). And its
	 * civic centre's queue raised while one is queued.
	 */
	provideForDryLand(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		const queueManager = gameState.ai.queueManager;
		const dry = this.landRunDry(gameState);
		// a new base is a dry or full town's way out: its civic centre goes just
		// above the training queues, where Petra left it at 1, paid only once
		// every other queue was (FINDINGS §40: one waited from minute 31 to the end)
		const wanted = dry || this.geography.navalMap && this.buildManager.numberMissingRoom(gameState) > 1;
		const ccPriority = wanted && queues.civilCentre.hasQueuedUnits() ?
			Math.max(this.Config.priorities.villager, this.Config.priorities.citizenSoldier) + 2 :
			this.Config.priorities.civilCentre;
		if (queueManager.getPriority("civilCentre") !== ccPriority)
		{
			queueManager.changePriority("civilCentre", ccPriority);
		}
		if (dry)
		{
			this.maxFields = false;
		}
	}

	/** A civic centre was ordered at `pos` (ConstructionPlan.start): followed until it stands. */
	noteCivCentreOrdered(gameState: CommonGameState, pos: CommonPosition): void
	{
		this.ccOrders.push({ pos, time: gameState.ai.elapsedTime, seen: false });
	}

	/**
	 * Follows the civic centres ordered: one whose foundation did not appear
	 * within CC_ORDER_WAIT seconds (the spot taken, by another player's
	 * foundation most often), or whose foundation was lost before it was
	 * built, has its spot avoided for CC_SPOT_MEMORY seconds. Petra ordered
	 * the same spot again and again: in a 4-player Dodecanese match three
	 * players went for the same spot of the same neutral island, one ordering
	 * it 6 times in a minute (FINDINGS §39).
	 */
	followCivCentreOrders(gameState: CommonGameState): void
	{
		const now = gameState.ai.elapsedTime;
		this.ccSpotsAvoided = this.ccSpotsAvoided.filter((spot) => spot.until > now);
		if (!this.ccOrders.length)
		{
			return;
		}
		const centres = gameState.getOwnStructures().filter(filters.byClass("CivCentre")).toEntityArray();
		this.ccOrders = this.ccOrders.filter((order) =>
		{
			const centre = centres.find((ent) =>
			{
				const pos = ent.position();
				return !!pos && SquareVectorDistance(pos, order.pos) < 40 * 40;
			});
			if (centre)
			{
				if (centre.foundationProgress() === undefined)
				{
					return false;
				}
				order.seen = true;
				return true;
			}
			if (!order.seen && now - order.time < CC_ORDER_WAIT)
			{
				return true;
			}
			this.ccSpotsAvoided.push({ pos: order.pos, until: now + CC_SPOT_MEMORY });
			return false;
		});
	}

	/**
	 * Whether a civic centre spot is contested (FINDINGS §39): remembered as
	 * failed, on a land with enemy buildings where we have no base, or with
	 * enemy soldiers within CC_ENEMY_AVOID metres. Petra sent its builders to
	 * islands the enemy held, and their foundations were lost unbuilt.
	 */
	/** Whether a civic centre spot is remembered as failed (followCivCentreOrders). */
	isAvoidedCCSpot(pos: CommonPosition): boolean
	{
		return this.ccSpotsAvoided.some((spot) => SquareVectorDistance(spot.pos, pos) < CC_SPOT_AVOID * CC_SPOT_AVOID);
	}

	isContestedCCSpot(gameState: CommonGameState, pos: CommonPosition, land: AccessIndex): boolean
	{
		if (this.isAvoidedCCSpot(pos))
		{
			return true;
		}
		const enemies = this.attackManager.enemiesByLand(gameState).get(land);
		if (!enemies)
		{
			return false;
		}
		if (
			enemies.some((enemy) => enemy.hasClass("Structure")) &&
			!this.baseManagers().some((base) => base.accessIndex === land && base.anchor)
		)
		{
			return true;
		}
		return enemies.some((enemy) =>
		{
			const at = enemy.position();
			return !enemy.hasClass("Structure") && !!at &&
				SquareVectorDistance(at, pos) < CC_ENEMY_AVOID * CC_ENEMY_AVOID;
		});
	}

	/** Whether a tower of this template has a spot on a shore the enemy's ships pass (findShoreTowerLocation). */
	hasShoreTowerSpot(gameState: CommonGameState, templateName: string): boolean
	{
		const template = gameState.getTemplate(gameState.applyCiv(templateName));
		return !!template && isStructureTemplate(template) &&
			this.findShoreTowerLocation(gameState, template) !== undefined;
	}

	/**
	 * The spot of our territory where a tower would reach the most of the
	 * enemy's ship traffic (world/shipTraffic.ts), the stretches our towers
	 * already watch counting a third: on naval maps, some passages are used a
	 * lot by ships and others barely (FINDINGS §38). Undefined below
	 * SHORE_TOWER_TRAFFIC ship-seconds in reach, or off naval maps; a spot
	 * keeps the distances of findDefensiveLocation (30 m from our towers and
	 * fortresses, 80 m from the enemy's defenses) and is not dangerous.
	 */
	findShoreTowerLocation(
		gameState: CommonGameState,
		template: CommonStructureTemplate,
	): [number, number, BaseId] | undefined
	{
		return this.shipTraffic ? findShoreTowerSpot(this, this.shipTraffic, gameState, template) : undefined;
	}

	buildTemple(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		// at least one market (which have the same queue) should be build before any temple
		if (
			queues.economicBuilding.hasQueuedUnits() ||
			gameState.getOwnEntitiesByClass("Temple", true).hasEntities() ||
			!gameState.getOwnEntitiesByClass("Market", true).hasEntities()
		)
		{
			return;
		}
		// Try to build a temple earlier if in regicide to recruit healer guards
		if (this.currentPhase < 3 && !gameState.getVictoryConditions().has("regicide"))
		{
			return;
		}

		let templateName = "structures/{civ}/temple";
		if (this.canBuild(gameState, "structures/{civ}/temple_vesta"))
		{
			templateName = "structures/{civ}/temple_vesta";
		}
		else if (!this.canBuild(gameState, templateName))
		{
			return;
		}
		queues.economicBuilding.addPlan(new ConstructionPlan(gameState, templateName));
	}

	buildMarket(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (
			gameState.getOwnEntitiesByClass("Market", true).hasEntities() ||
			!this.canBuild(gameState, "structures/{civ}/market")
		)
		{
			return;
		}

		if (queues.economicBuilding.hasQueuedUnitsWithClass("Market"))
		{
			if (!queues.economicBuilding.paused)
			{
				fundMarket(gameState, queues);
			}
			return;
		}

		gameState.ai.queueManager.changePriority("economicBuilding", 3 * this.Config.priorities.economicBuilding);
		const plan = new ConstructionPlan(gameState, "structures/{civ}/market");
		plan.queueToReset = "economicBuilding";
		queues.economicBuilding.addPlan(plan);
	}

	/**
	 * A saving town (little wood on its land from the start, FINDINGS §37)
	 * whose land has no wood left within reach queues its market at once, in
	 * the village phase too: queued, the market holds its wood at the top
	 * priority until the town phase lets it be built, and then barters the
	 * town's food, stone and metal for wood. Petra queued it only in the town
	 * phase, when the wood was gone: 24 of 38 drawn island games had it waiting
	 * for good with 50-277 of its 300 wood. The town phase it waits for goes
	 * first: while the phase is queued, the market's queue sits just below it
	 * (holding the wood at the top, it starved the phase on islands with
	 * under 800 wood left, and the town stayed in the village phase).
	 */
	buildEarlyMarket(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (
			!this.saveResources && !this.geography.navalMap ||
			gameState.getOwnEntitiesByClass("Market", true).hasEntities()
		)
		{
			return;
		}
		const queueManager = gameState.ai.queueManager;
		if (queues.economicBuilding.hasQueuedUnitsWithClass("Market"))
		{
			const priority = queues.majorTech.hasQueuedUnits() ?
				Math.max(1, queueManager.getPriority("majorTech") - 1) :
				3 * this.Config.priorities.economicBuilding;
			if (queueManager.getPriority("economicBuilding") !== priority)
			{
				queueManager.changePriority("economicBuilding", priority);
			}
			return;
		}
		const market = gameState.applyCiv("structures/{civ}/market");
		if (!gameState.isTemplateAvailable(market) || this.buildManager.isUnbuildable(gameState, market))
		{
			return;
		}
		if (!this.landRunDry(gameState))
		{
			return;
		}
		queueManager.changePriority("economicBuilding", 3 * this.Config.priorities.economicBuilding);
		const plan = new ConstructionPlan(gameState, "structures/{civ}/market");
		plan.queueToReset = "economicBuilding";
		queues.economicBuilding.addPlan(plan);
	}

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
			this.getTotalResourceLevel(gameState, ["wood"], ["nearby", "medium", "faraway"]).wood < DRY_WOOD;
	}

	/** Build a farmstead */
	buildFarmstead(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		// Only build one farmstead for the time being ("DropsiteFood" does not refer to CCs)
		if (gameState.getOwnEntitiesByClass("Farmstead", true).hasEntities())
		{
			return;
		}
		// Wait to have at least one dropsite and house before the farmstead
		if (!gameState.getOwnEntitiesByClass("Storehouse", true).hasEntities())
		{
			return;
		}
		if (!gameState.getOwnEntitiesByClass("House", true).hasEntities())
		{
			return;
		}
		if (queues.economicBuilding.hasQueuedUnitsWithClass("DropsiteFood"))
		{
			return;
		}
		if (!this.canBuild(gameState, "structures/{civ}/farmstead"))
		{
			return;
		}

		queues.economicBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/farmstead"));
	}

	/**
	 * Try to build a wonder when required
	 * force = true when called from the victoryManager in case of Wonder victory condition.
	 */
	buildWonder(gameState: CommonGameState, queues: HeadquartersQueues, force: boolean = false): void
	{
		if (
			queues.wonder && queues.wonder.hasQueuedUnits() ||
			gameState.getOwnEntitiesByClass("Wonder", true).hasEntities() ||
			!this.canBuild(gameState, "structures/{civ}/wonder")
		)
		{
			return;
		}

		if (!force)
		{
			// canBuild() above already verified that the template exists.
			const template = requireTemplate(gameState, gameState.applyCiv("structures/{civ}/wonder"));
			// Check that we have enough resources to start thinking to build a wonder
			const cost = template.cost();
			const resources = gameState.getResources();
			let highLevel = 0;
			let lowLevel = 0;
			for (const res in cost)
			{
				if (resources[res] && resources[res] > 0.7 * cost[res])
				{
					++highLevel;
				}
				else if (!resources[res] || resources[res] < 0.3 * cost[res])
				{
					++lowLevel;
				}
			}
			if (highLevel === 0 || lowLevel > 1)
			{
				return;
			}
		}

		queues.wonder.addPlan(new ConstructionPlan(gameState, "structures/{civ}/wonder"));
	}

	/** Build a corral, and train animals there */
	manageCorral(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (queues.corral.hasQueuedUnits())
		{
			return;
		}

		const nCorral = gameState.getOwnEntitiesByClass("Corral", true).length;
		if (
			!nCorral ||
			!gameState.isTemplateAvailable(gameState.applyCiv("structures/{civ}/field")) &&
				nCorral < this.currentPhase && gameState.getPopulation() > 30 * nCorral
		)
		{
			if (this.canBuild(gameState, "structures/{civ}/corral"))
			{
				queues.corral.addPlan(new ConstructionPlan(gameState, "structures/{civ}/corral"));
				return;
			}
			if (!nCorral)
			{
				return;
			}
		}

		// And train some animals
		const civ = gameState.getPlayerCiv();
		for (const corral of gameState.getOwnEntitiesByClass("Corral", true).values())
		{
			if (corral.foundationProgress() !== undefined)
			{
				continue;
			}
			const trainable = corralAnimal(gameState, corral, civ, nCorral);
			if (trainable === undefined)
			{
				continue;
			}
			queues.corral.addPlan(new TrainingPlan(gameState, trainable, { trainer: corral.id() }));
			return;
		}
	}

	/**
	 * build more houses if needed.
	 * kinda ugly, lots of special cases to both build enough houses but not tooo many…
	 */
	buildMoreHouses(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		let houseTemplateString = "structures/{civ}/apartment";
		if (
			!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)) ||
			!this.canBuild(gameState, houseTemplateString)
		)
		{
			houseTemplateString = "structures/{civ}/house";
			if (!gameState.isTemplateAvailable(gameState.applyCiv(houseTemplateString)))
			{
				return;
			}
		}
		if (gameState.getPopulationMax() <= gameState.getPopulationLimit())
		{
			return;
		}
		// isTemplateAvailable() above already verified that this template exists.
		const houseTemplateName = gameState.applyCiv(houseTemplateString);

		const numPlanned = queues.house.length();
		if (planAnotherHouse(numPlanned, gameState.getPopulation()))
		{
			const plan = new ConstructionPlan(gameState, houseTemplateString);
			// change the starting condition according to the situation.
			plan.goRequirement = "houseNeeded";
			queues.house.addPlan(plan);
		}

		if (numPlanned > 0 && this.phasing && gameState.getPhaseEntityRequirements(this.phasing).length)
		{
			this.housesForPhase(gameState, queues, houseTemplateName, numPlanned);
		}

		if (this.requireHouses)
		{
			const houseTemplate = requireTemplate(gameState, houseTemplateName);
			if (
				!this.phasing ||
				gameState.getPhaseEntityRequirements(this.phasing).every((
					req: { class: string; count: number; },
				): boolean =>
					!houseTemplate.hasClass(req.class) ||
					gameState.getOwnStructures().filter(filters.byClass(req.class)).length >= req.count
				)
			)
			{
				this.requireHouses = undefined;
			}
		}

		this.raiseHousesIfTight(gameState, queues, houseTemplateName);
	}

	/**
	 * The houses the next phase requires go without waiting to be needed; with no room to place one we try to
	 * be less restrictive
	 */
	private housesForPhase(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		houseTemplateName: TemplateName,
		numPlanned: number,
	): void
	{
		const houseTemplate = requireTemplate(gameState, houseTemplateName);

		let needed = 0;
		for (const entityReq of gameState.getPhaseEntityRequirements(this.phasing))
		{
			if (!houseTemplate.hasClass(entityReq.class))
			{
				continue;
			}

			const count = gameState.getOwnStructures().filter(filters.byClass(entityReq.class)).length;
			if (count < entityReq.count && this.buildManager.isUnbuildable(gameState, houseTemplateName))
			{
				debugWarn(this.Config, 1, () => "no room to place a house ... try to be less restrictive");
				this.buildManager.setBuildable(houseTemplateName);
				this.requireHouses = true;
			}
			needed = Math.max(needed, entityReq.count - count);
		}

		const houseQueue = queues.house.plans;
		for (let i = 0; i < numPlanned; ++i)
		{
			if (houseQueue[i].isGo(gameState))
			{
				--needed;
			}
			else if (needed > 0)
			{
				houseQueue[i].goRequirement = undefined;
				--needed;
			}
		}
	}

	/**
	 * When population limit too tight: if no room to build, try to improve with technology, otherwise increase
	 * temporarily the priority of houses
	 */
	private raiseHousesIfTight(gameState: CommonGameState, queues: HeadquartersQueues, house: TemplateName): void
	{
		const HouseNb = gameState.getOwnFoundations().filter(filters.byClass("House")).length;
		const houseTemplate = requireTemplate(gameState, house);
		const popBonus = houseTemplate.getPopulationBonus();
		const freeSlots = gameState.getPopulationLimit() + HouseNb * popBonus - this.getAccountedPopulation(gameState);
		let priority;
		if (freeSlots < TIGHT_SLOTS)
		{
			if (this.buildManager.isUnbuildable(gameState, house))
			{
				debugWarn(this.Config, 1, () => "no room to place a house ... try to improve with technology");
				this.researchManager.researchPopulationBonus(gameState, queues);
			}
			else
			{
				priority = urgentHousePriority(this.Config.priorities);
			}
		}
		else
		{
			priority = this.Config.priorities.house;
		}

		if (priority && priority !== gameState.ai.queueManager.getPriority("house"))
		{
			gameState.ai.queueManager.changePriority("house", priority);
		}
	}

	/** Whether a planned house may be paid now (decision/housing.ts). */
	houseNeeded(gameState: CommonGameState): boolean
	{
		return houseNeeded(censusOf(gameState), !!this.saveResources);
	}

	/** Checks the status of the territory expansion. If no new economic bases created, build some strategic ones. */
	checkBaseExpansion(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (queues.civilCentre.hasQueuedUnits())
		{
			return;
		}
		// First build one cc if all have been destroyed
		if (!this.hasPotentialBase())
		{
			buildFirstBase(this, gameState);
			return;
		}
		// Then expand if we have not enough room available for buildings
		if (this.buildManager.numberMissingRoom(gameState) > 1)
		{
			debugWarn(this.Config, 2, () => "try to build a new base because not enough room to build ");
			// on a naval map, for its room: any free land will do (FINDINGS §40)
			this.buildNewBase(gameState, queues, undefined, this.geography.navalMap);
			return;
		}
		// If we've already planned to phase up, wait a bit before trying to expand
		if (this.phasing)
		{
			return;
		}
		// Finally expand if we have lots of units (threshold depending on the aggressivity value)
		const activeBases = this.numActiveBases();
		const numUnits = gameState.getOwnUnits().length;
		const numvar = 10 * (1 - this.Config.personality.aggressive);
		if (
			numUnits > activeBases * (65 + numvar + (10 + numvar) * (activeBases - 1)) ||
			this.saveResources && numUnits > 50
		)
		{
			debugWarn(
				this.Config,
				2,
				() => "try to build a new base because of population " + numUnits + " for " + activeBases + " CCs",
			);
			this.buildNewBase(gameState, queues);
		}
	}

	buildNewBase(gameState: CommonGameState, queues: HeadquartersQueues, resource?: string, forRoom = false): boolean
	{
		const phaseName2 = gameState.getPhaseName(2);
		if (
			this.hasPotentialBase() && this.currentPhase === 1 &&
			(phaseName2 === undefined || !gameState.isResearching(phaseName2))
		)
		{
			return false;
		}
		if (
			gameState.getOwnFoundations().filter(filters.byClass("CivCentre")).hasEntities() ||
			queues.civilCentre.hasQueuedUnits()
		)
		{
			return false;
		}

		const template = this.newBaseTemplate(gameState);
		if (template === undefined)
		{
			return false;
		}

		// base "-1" means new base.
		debugWarn(
			this.Config,
			1,
			() => "new base " + gameState.applyCiv(template) + " planned with resource " + resource,
		);
		queues.civilCentre.addPlan(
			new ConstructionPlan(
				gameState,
				template,
				forRoom ? { base: NEW_BASE, room: true } : { base: NEW_BASE, resource: resource },
			),
		);
		return true;
	}

	/**
	 * A military colony once we have a civic centre of our own civ (it may allow specific units or techs), else a
	 * civic centre, else a colony; undefined when we can build none
	 */
	private newBaseTemplate(gameState: CommonGameState): string | undefined
	{
		let hasOwnCC = false;
		for (const ent of gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")).values())
		{
			if (ent.owner() !== PlayerID || ent.templateName() !== gameState.applyCiv("structures/{civ}/civil_centre"))
			{
				continue;
			}
			hasOwnCC = true;
			break;
		}
		if (hasOwnCC && this.canBuild(gameState, "structures/{civ}/military_colony"))
		{
			return "structures/{civ}/military_colony";
		}
		if (this.canBuild(gameState, "structures/{civ}/civil_centre"))
		{
			return "structures/{civ}/civil_centre";
		}
		if (!hasOwnCC && this.canBuild(gameState, "structures/{civ}/military_colony"))
		{
			return "structures/{civ}/military_colony";
		}
		return undefined;
	}

	/** Deals with building fortresses and towers along our border with enemies. */
	buildDefenses(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (queues.defenseBuilding.hasQueuedUnits())
		{
			return;
		}
		// A saving town builds no defense, but for a tower on a shore the enemy's
		// ships pass (FINDINGS §38): an island's town saves its wood, and sat on
		// thousands of stone while their transports and warships sailed by.
		const saving = this.saveResources && !this.canBarter;
		if (saving && !this.shipTraffic)
		{
			return;
		}
		const shoreOnly = saving || this.towersByTrafficOnly(gameState);

		if (
			!this.saveResources && this.reachingCityPhase(gameState) &&
			this.canBuild(gameState, "structures/{civ}/fortress") && this.queueFortress(gameState, queues)
		)
		{
			return;
		}

		if (
			this.Config.Military.numSentryTowers && this.currentPhase < 2 &&
			this.canBuild(gameState, "structures/{civ}/sentry_tower")
		)
		{
			this.queueSentryTower(gameState, queues, shoreOnly);
			return;
		}

		if (this.currentPhase < 2 || !this.canBuild(gameState, "structures/{civ}/defense_tower"))
		{
			return;
		}
		this.queueDefenseTower(gameState, queues, shoreOnly);
	}

	/** Whether we are in the city phase, or researching it */
	private reachingCityPhase(gameState: CommonGameState): boolean
	{
		const phaseName3 = gameState.getPhaseName(3);
		return this.currentPhase > 2 || phaseName3 !== undefined && gameState.isResearching(phaseName3);
	}

	/** A fortress, the first raised in priority, once the last is old enough and we have bases and men for it; whether one was queued */
	private queueFortress(gameState: CommonGameState, queues: HeadquartersQueues): boolean
	{
		const numFortresses = gameState.getOwnEntitiesByClass("Fortress", true).length;
		if (
			(!numFortresses ||
				gameState.ai.elapsedTime >
					(1 + 0.10 * numFortresses) * this.fortressLapseTime + this.fortressStartTime) &&
			numFortresses < this.numActiveBases() + 1 + this.extraFortresses &&
			numFortresses < Math.floor(gameState.getPopulation() / 25) &&
			gameState.getOwnFoundationsByClass("Fortress").length < 2
		)
		{
			this.fortressStartTime = gameState.ai.elapsedTime;
			if (!numFortresses)
			{
				gameState.ai.queueManager.changePriority("defenseBuilding", 2 * this.Config.priorities.defenseBuilding);
			}
			const plan = new ConstructionPlan(gameState, "structures/{civ}/fortress");
			plan.queueToReset = "defenseBuilding";
			queues.defenseBuilding.addPlan(plan);
			return true;
		}
		return false;
	}

	/** A sentry tower in the village phase, up to the configured number, spaced in time (all towers and wall towers counted) */
	private queueSentryTower(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		shoreOnly: boolean | undefined,
	): void
	{
		const numTowers = gameState.getOwnEntitiesByClass("Tower", true).length +
			gameState.getOwnEntitiesByClass("WallTower", true).length;
		const towerLapseTime = this.saveResources ? (1 + 0.5 * numTowers) * this.towerLapseTime : this.towerLapseTime;
		if (
			numTowers < this.Config.Military.numSentryTowers &&
			gameState.ai.elapsedTime > towerLapseTime + this.fortStartTime
		)
		{
			if (shoreOnly && !this.hasShoreTowerSpot(gameState, "structures/{civ}/sentry_tower"))
			{
				return;
			}
			this.fortStartTime = gameState.ai.elapsedTime;
			queues.defenseBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/sentry_tower"));
		}
	}

	/** A stone tower, spaced in time, up to a number by our bases and men (lowered in priority past it) */
	private queueDefenseTower(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		shoreOnly: boolean | undefined,
	): void
	{
		const numTowers = gameState.getOwnEntitiesByClass("StoneTower", true).length;
		const towerLapseTime = this.saveResources ? (1 + numTowers) * this.towerLapseTime : this.towerLapseTime;
		if (
			(!numTowers || gameState.ai.elapsedTime > (1 + 0.1 * numTowers) * towerLapseTime + this.towerStartTime) &&
			numTowers < 2 * this.numActiveBases() + 3 + this.extraTowers &&
			numTowers < Math.floor(gameState.getPopulation() / 8) &&
			gameState.getOwnFoundationsByClass("Tower").length < 3
		)
		{
			if (shoreOnly && !this.hasShoreTowerSpot(gameState, "structures/{civ}/defense_tower"))
			{
				return;
			}
			this.towerStartTime = gameState.ai.elapsedTime;
			if (numTowers > 2 * this.numActiveBases() + 3)
			{
				gameState.ai.queueManager.changePriority(
					"defenseBuilding",
					Math.round(0.7 * this.Config.priorities.defenseBuilding),
				);
			}
			const plan = new ConstructionPlan(gameState, "structures/{civ}/defense_tower");
			plan.queueToReset = "defenseBuilding";
			queues.defenseBuilding.addPlan(plan);
		}
	}

	buildForge(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (
			this.getAccountedPopulation(gameState) < this.Config.Military.popForForge ||
			queues.militaryBuilding.hasQueuedUnits() || gameState.getOwnEntitiesByClass("Forge", true).length
		)
		{
			return;
		}
		// Build a Market before the Forge.
		if (!gameState.getOwnEntitiesByClass("Market", true).hasEntities())
		{
			return;
		}

		if (this.canBuild(gameState, "structures/{civ}/forge"))
		{
			queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, "structures/{civ}/forge"));
		}
	}

	/**
	 * Deals with constructing military buildings (e.g. barracks, stable).
	 * They are mostly defined by Config.js. This is unreliable since changes could be done easily.
	 */
	constructTrainingBuildings(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (this.saveResources && !this.canBarter || queues.militaryBuilding.hasQueuedUnits())
		{
			return;
		}

		// A saving town builds no more military buildings, and so on islands, where
		// every town saves, no arsenal and no siege engine came, and the attacks
		// met defended towns without siege (FINDINGS §37). With a market it can
		// barter for one: its arsenal.
		if (
			this.saveResources && this.canBarter && this.currentPhase >= 3 &&
			this.queueMissing(gameState, queues, "Arsenal", "arsenal")
		)
		{
			return;
		}

		const numBarracks = gameState.getOwnEntitiesByClass("Barracks", true).length;
		if (this.saveResources && numBarracks !== 0)
		{
			return;
		}

		if (this.queueTrainerIfNeeded(gameState, queues, numBarracks))
		{
			return;
		}

		if (!this.saveResources && this.currentPhase >= 3)
		{
			this.queueCityMilitary(gameState, queues);
		}
	}

	/** In the city phase: an elephant stable, an arsenal, then the advanced buildings with the population */
	private queueCityMilitary(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (
			this.queueMissing(gameState, queues, "ElephantStable", "elephant_stable") ||
			this.queueMissing(gameState, queues, "Arsenal", "arsenal")
		)
		{
			return;
		}

		if (this.getAccountedPopulation(gameState) < 80 || !this.bAdvanced.length)
		{
			return;
		}
		this.queueAdvancedBuilding(gameState, queues);
	}

	/** A military building we can build and have none of; whether it was queued */
	private queueMissing(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		className: string,
		name: string,
	): boolean
	{
		const template = "structures/{civ}/" + name;
		if (!this.canBuild(gameState, template) || gameState.getOwnEntitiesByClass(className, true).hasEntities())
		{
			return false;
		}
		queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, template, { militaryBase: true }));
		return true;
	}

	/**
	 * With the population for barracks (or while phasing to the town phase short of village buildings), a trainer;
	 * whether one was queued. (canBuild marks what cannot be built: asked each time, as Petra did)
	 */
	private queueTrainerIfNeeded(gameState: CommonGameState, queues: HeadquartersQueues, numBarracks: number): boolean
	{
		const trainers: TrainerTemplates = {
			barracks: this.canBuild(gameState, "structures/{civ}/barracks") ? "structures/{civ}/barracks" : undefined,
			range: this.canBuild(gameState, "structures/{civ}/range") ? "structures/{civ}/range" : undefined,
			stable: this.canBuild(gameState, "structures/{civ}/stable") ? "structures/{civ}/stable" : undefined,
		};
		return (this.getAccountedPopulation(gameState) > this.Config.Military.popForBarracks1 ||
			this.phasing === 2 && gameState.getOwnStructures().filter(filters.byClass("Village")).length < 5) &&
			this.queueTrainer(gameState, queues, numBarracks, trainers);
	}

	/**
	 * The barracks, ranges and stables: the first ones (raised in priority), a second and a third with the
	 * population, then one more while those we have are busy; whether one was queued
	 */
	private queueTrainer(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		numBarracks: number,
		trainers: TrainerTemplates,
	): boolean
	{
		const stableTemplate = trainers.stable;
		const numRanges = gameState.getOwnEntitiesByClass("Range", true).length;
		const numStables = gameState.getOwnEntitiesByClass("Stable", true).length;
		const military = (template: string): boolean =>
		{
			queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, template, { militaryBase: true }));
			return true;
		};

		if (this.queueFirstTrainer(gameState, queues, numBarracks + numRanges, trainers))
		{
			return true;
		}
		if (numStables === 0 && stableTemplate)
		{
			return military(stableTemplate);
		}
		return this.queueMoreTrainers(gameState, { numBarracks, numRanges, numStables }, trainers, military);
	}

	/** The first barracks (or range), raised in priority; whether it was queued */
	private queueFirstTrainer(
		gameState: CommonGameState,
		queues: HeadquartersQueues,
		numFootTrainers: number,
		trainers: TrainerTemplates,
	): boolean
	{
		if (numFootTrainers === 0)
		{
			const template = trainers.barracks || trainers.range;
			if (template)
			{
				gameState.ai.queueManager.changePriority(
					"militaryBuilding",
					2 * this.Config.priorities.militaryBuilding,
				);
				const plan = new ConstructionPlan(gameState, template, { militaryBase: true });
				plan.queueToReset = "militaryBuilding";
				queues.militaryBuilding.addPlan(plan);
				return true;
			}
		}
		return false;
	}

	/** A second and a third barracks, range or stable with the population, then one more while those are busy */
	private queueMoreTrainers(
		gameState: CommonGameState,
		counts: { numBarracks: number; numRanges: number; numStables: number; },
		trainers: TrainerTemplates,
		military: (template: string) => boolean,
	): boolean
	{
		const next = this.nextTrainer(gameState, counts, trainers);
		if (next)
		{
			return military(next);
		}

		// One more while those we have are nearly always training and the
		// stock lies unbooked: the town cannot spend what it gathers (FINDINGS §29)
		const template = trainers.barracks || trainers.range;
		if (template && this.oneMoreTrainerPays(gameState, template))
		{
			return military(template);
		}
		return false;
	}

	/** The second barracks/range and stable, and a third if needed, with the population */
	private nextTrainer(
		gameState: CommonGameState,
		counts: { numBarracks: number; numRanges: number; numStables: number; },
		trainers: TrainerTemplates,
	): string | undefined
	{
		const { numBarracks, numRanges, numStables } = counts;
		const barracksTemplate = trainers.barracks;
		const rangeTemplate = trainers.range;
		const stableTemplate = trainers.stable;
		const popForBarracks2 = this.Config.Military.popForBarracks2;
		if (numBarracks + numRanges === 1 && this.getAccountedPopulation(gameState) > popForBarracks2)
		{
			const template = numBarracks === 0 ?
				(barracksTemplate || rangeTemplate) :
				(rangeTemplate || barracksTemplate);
			if (template)
			{
				return template;
			}
		}
		if (numStables === 1 && stableTemplate && this.getAccountedPopulation(gameState) > popForBarracks2)
		{
			return stableTemplate;
		}
		if (numBarracks + numRanges + numStables === 2 && this.getAccountedPopulation(gameState) > popForBarracks2 + 30)
		{
			return barracksTemplate || stableTemplate || rangeTemplate;
		}
		return undefined;
	}

	/** Whether our trainers are busy and twice the trainer's cost lies unbooked */
	private oneMoreTrainerPays(gameState: CommonGameState, template: string): boolean
	{
		if (
			!(this.productionLoad.trainers >= 1 && this.productionLoad.trainers < MAX_MILITARY_TRAINERS &&
				this.productionLoad.busy >= BUSY_TRAINERS)
		)
		{
			return false;
		}
		const cost = gameState.getTemplate(gameState.applyCiv(template))?.costSum() ?? Infinity;
		const unbooked = gameState.ai.queueManager.getAvailableResources(gameState);
		let free = 0;
		for (const res of Resources.GetCodes())
		{
			free += Math.max(0, unbooked[res]);
		}
		return free >= 2 * cost;
	}

	/** Build advanced military buildings: the first, then the others with the population */
	private queueAdvancedBuilding(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		let nAdvanced = 0;
		for (const advanced of this.bAdvanced)
		{
			nAdvanced += gameState.countEntitiesAndQueuedByType(advanced, true);
		}

		if (nAdvanced && !(nAdvanced < this.bAdvanced.length && this.getAccountedPopulation(gameState) > 110))
		{
			return;
		}
		for (const advanced of this.bAdvanced)
		{
			if (gameState.countEntitiesAndQueuedByType(advanced, true) > 0 || !this.canBuild(gameState, advanced))
			{
				continue;
			}
			// canBuild() above already verified that the template exists.
			const template = requireTemplate(gameState, advanced);
			const civ = gameState.getPlayerCiv();
			if (template.hasDefensiveFire() || template.trainableEntities(civ))
			{
				queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, advanced, { militaryBase: true }));
			}
			// not a military building, but still use this queue
			else
			{
				queues.militaryBuilding.addPlan(new ConstructionPlan(gameState, advanced));
			}
			return;
		}
	}

	/**
	 *  Find base nearest to ennemies for military buildings.
	 */
	findBestBaseForMilitary(gameState: CommonGameState): number | undefined
	{
		const ccEnts = gameState.updatingGlobalCollection("allCCs", filters.byClass("CivCentre")).toEntityArray();
		let bestBase;
		let enemyFound = false;
		let distMin = Math.min();
		for (const cce of ccEnts)
		{
			if (!isPlaced(cce) || gameState.isPlayerAlly(cce.owner()))
			{
				continue;
			}
			if (enemyFound && !gameState.isPlayerEnemy(cce.owner()))
			{
				continue;
			}
			const access = getLandAccess(gameState, cce);
			const isEnemy = gameState.isPlayerEnemy(cce.owner());
			for (const cc of ccEnts)
			{
				if (cc.owner() !== PlayerID || !isPlaced(cc))
				{
					continue;
				}
				if (getLandAccess(gameState, cc) !== access)
				{
					continue;
				}
				const dist = SquareVectorDistance(cc.position(), cce.position());
				if (!enemyFound && isEnemy)
				{
					enemyFound = true;
				}
				else if (dist > distMin)
				{
					continue;
				}
				bestBase = cc.getMetadata(PlayerID, "base");
				distMin = dist;
			}
		}
		return bestBase;
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
		fundQueue(gameState, new ResourcesManager(templateFound[1].cost()), "emergency");
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
			for (const base of this.baseManagers())
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

		if (!this.hasActiveBase())
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

	/**
	 * Whether a cell of ours lies on the frontier: narrow, a cell not ours (nor an ally's in an allied victory)
	 * within 45 m, or large, within 80 m
	 */
	private frontierAt(
		gameState: CommonGameState,
		j: CellIndex<"territory">,
		ring: { around: number[][]; alliedVictory: boolean; insideSmall: number; insideLarge: number; },
	): { narrow: boolean; onFrontier: boolean; }
	{
		const width = this.geography.territoryMap.width;
		const ix = j % width;
		const iz = Math.floor(j / width);
		const foreignAt = (distance: number, a: number[]): boolean | undefined =>
		{
			const jx = ix + Math.round(distance * a[0]);
			if (jx < 0 || jx >= width)
			{
				return undefined;
			}
			const jz = iz + Math.round(distance * a[1]);
			if (jz < 0 || jz >= width)
			{
				return undefined;
			}
			if (this.geography.borderMap.map[jx + width * jz] & mapMask.outside)
			{
				return undefined;
			}
			const territoryOwner = this.geography.territoryMap.getOwnerIndex(
				cellIndex(this.geography.territoryMap, jx + width * jz),
			);
			return territoryOwner !== PlayerID && !(ring.alliedVictory && gameState.isPlayerAlly(territoryOwner));
		};
		let onFrontier = false;
		for (const a of ring.around)
		{
			const small = foreignAt(ring.insideSmall, a);
			if (small === undefined)
			{
				continue;
			}
			if (small)
			{
				return { narrow: true, onFrontier };
			}
			if (foreignAt(ring.insideLarge, a))
			{
				onFrontier = true;
			}
		}
		return { narrow: false, onFrontier };
	}

	/** A unit of ours capturing adds its capture strength to its target's */
	private addCaptureStrength(gameState: CommonGameState, ent: CommonEntity): void
	{
		if (!ent.canCapture())
		{
			return;
		}
		if (!hasActivity(ent, "COMBAT"))
		{
			return;
		}
		const orderData = ordersOf(ent);
		if (!orderData || !orderData.length || !orderData[0].target)
		{
			return;
		}
		const targetId = orderData[0].target;
		const target = gameState.getEntityById(targetId);
		if (!target || !target.isCapturable() || !ent.canCapture(target))
		{
			return;
		}
		const captureStrength = ent.captureStrength();
		if (captureStrength === undefined)
		{
			return;
		}
		const capturableTarget = this.capturableTargets.get(targetId);
		if (!capturableTarget)
		{
			this.capturableTargets.set(targetId, {
				strength: captureStrength * getAttackBonus(ent, target, "Capture"),
				ents: new Set([ent.id()]),
			});
		}
		else
		{
			capturableTarget.strength += captureStrength * getAttackBonus(ent, target, "Capture");
			capturableTarget.ents.add(ent.id());
		}
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
				const frontier = this.frontierAt(gameState, j, { around, alliedVictory, insideSmall, insideLarge });
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

	/**
	 * returns the base corresponding to baseID
	 */
	getBaseByID(baseID: BaseId): BaseManager | undefined
	{
		return this.basesManager.getBaseByID(baseID);
	}

	/**
	 * returns the number of bases with a cc
	 * ActiveBases includes only those with a built cc
	 * PotentialBases includes also those with a cc in construction
	 */
	numActiveBases(): number
	{
		return this.basesManager.numActiveBases();
	}

	hasActiveBase(): boolean
	{
		return this.basesManager.hasActiveBase();
	}

	/** TODO never called (nor in the original Petra): remove it, or call it where it was meant to be used */
	numPotentialBases(): number
	{
		return this.basesManager.numPotentialBases();
	}

	hasPotentialBase(): boolean
	{
		return this.basesManager.hasPotentialBase();
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

	/** Compute the capture strength of all units attacking a capturable target */
	updateCaptureStrength(gameState: CommonGameState): void
	{
		this.capturableTargets.clear();
		for (const ent of gameState.getOwnUnits().values())
		{
			this.addCaptureStrength(gameState, ent);
		}

		for (const [targetId, capturableTarget] of this.capturableTargets)
		{
			const target = gameState.getEntityById(targetId);
			if (!target)
			{
				continue;
			}
			let shouldCapture;
			for (const entId of capturableTarget.ents)
			{
				const ent = gameState.getEntityById(entId);
				if (!ent)
				{
					continue;
				}
				if (shouldCapture === undefined)
				{
					shouldCapture = allowCapture(gameState, ent, target);
				}
				const orderData = ordersOf(ent);
				if (!orderData || !orderData.length || !orderData[0].attackType)
				{
					continue;
				}
				if ((orderData[0].attackType === "Capture") !== shouldCapture)
				{
					ent.attack(targetId, shouldCapture);
				}
			}
		}

		this.capturableTargetsTime = gameState.ai.elapsedTime;
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

	baseManagers(): BaseManager[]
	{
		return this.basesManager.baseManagers;
	}

	/**
	 * @param {number} territoryIndex - The index to get the map for.
	 * @return {number} - The ID of the base at the given territory index.
	 */
	baseAtIndex(territoryIndex: CellIndex<"territory">): BaseId
	{
		return this.basesManager.baseAtIndex(territoryIndex);
	}

	/**
	 * Some functions are run every turn
	 * Others once in a while
	 */
	update(gameState: CommonGameState, queues: HeadquartersQueues, events: HeadquartersEvents): void
	{
		Engine.ProfileStart("Headquarters update");
		this.updateWorld(gameState, queues);
		this.notePhase(gameState);

		profiled("HQ checkEvents", () => this.checkEvents(gameState, events));
		profiled("HQ naval checkEvents", () => this.navalManager.checkEvents(gameState, queues, events));

		if (this.phasing)
		{
			this.checkPhaseRequirements(gameState, queues);
		}
		else
		{
			this.researchManager.checkPhase(gameState, queues);
		}

		if (this.hasActiveBase())
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
				this.constructTrainingBuildings(gameState, queues);
				if (this.Config.difficulty > difficulty.SANDBOX)
				{
					this.buildDefenses(gameState, queues);
				}
			});
		}

		profiled("HQ bases", () => this.basesManager.update(gameState, queues, events));
		profiled("HQ naval", () => this.navalManager.update(gameState, queues, events));

		if (this.Config.difficulty > difficulty.SANDBOX && (this.hasActiveBase() || !this.canBuildUnits))
		{
			profiled("HQ attacks", () => this.attackManager.update(gameState, queues, events));
		}

		profiled("HQ diplomacy", () => this.diplomacyManager.update(gameState, events));
		profiled("HQ victory", () => this.victoryManager.update(gameState, events, queues));

		// We update the capture strength at the end as it can change attack orders
		if (gameState.ai.elapsedTime - this.capturableTargetsTime > 3)
		{
			profiled("HQ updateCaptureStrength", () => this.updateCaptureStrength(gameState));
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
		profiled("HQ followCivCentreOrders", () => this.followCivCentreOrders(gameState));
		if (gameState.ai.playedTurn % 10 === 3)
		{
			this.provideForDryLand(gameState, queues);
		}
		if (this.geography.navalMap)
		{
			const map = this.geography.territoryMap;
			this.shipTraffic ??= new ShipTraffic(map.width * map.cellSize, map.height * map.cellSize);
			this.shipTraffic.sample(gameState);
		}
		this.canBarter = gameState.getOwnEntitiesByClass("Market", true).filter(filters.isBuilt()).hasEntities();
	}

	/** A phase reached (TODO find a better way to update) */
	private notePhase(gameState: CommonGameState): void
	{
		if (this.currentPhase === gameState.currentPhase())
		{
			return;
		}
		debugWarn(
			this.Config,
			0,
			() =>
				" civ " + gameState.getPlayerCiv() + " has phasedUp from " + this.currentPhase +
				" to " + gameState.currentPhase() + " at time " + gameState.ai.elapsedTime +
				" phasing " + this.phasing,
		);
		this.currentPhase = gameState.currentPhase();

		// In principle, this.phasing should be already reset to 0 when starting the research
		// but this does not work in case of an autoResearch tech
		if (this.phasing)
		{
			this.phasing = 0;
		}
	}

	/** A town's turn, one task in four: workers, houses, a farmstead, a corral; research one turn in five */
	private updateTown(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		const turn = gameState.ai.playedTurn;
		if (turn % 4 === 0)
		{
			profiled("HQ trainMoreWorkers", () => this.trainMoreWorkers(gameState, queues));
		}
		if (turn % 4 === 1)
		{
			profiled("HQ buildMoreHouses", () => this.buildMoreHouses(gameState, queues));
		}
		if ((!this.saveResources || this.canBarter) && turn % 4 === 2)
		{
			profiled("HQ buildFarmstead", () => this.buildFarmstead(gameState, queues));
		}
		if (this.needCorral && turn % 4 === 3)
		{
			profiled("HQ manageCorral", () => this.manageCorral(gameState, queues));
		}
		if (turn % 5 === 1)
		{
			profiled("HQ research", () => this.researchManager.update(gameState, queues));
		}
	}

	/** New bases, the markets, the forge, the temple and the wonder */
	private updateBuildings(gameState: CommonGameState, queues: HeadquartersQueues): void
	{
		if (!this.hasPotentialBase() || this.canExpand && gameState.ai.playedTurn % 10 === 7 && this.currentPhase > 1)
		{
			profiled("HQ checkBaseExpansion", () => this.checkBaseExpansion(gameState, queues));
		}

		if (this.currentPhase === 1 && gameState.ai.playedTurn % 3 === 0 && !this.canBarter)
		{
			this.buildEarlyMarket(gameState, queues);
		}
		if (this.currentPhase <= 1 || gameState.ai.playedTurn % 3 !== 0)
		{
			return;
		}
		profiled("HQ market forge temple wonder", () =>
		{
			if (!this.canBarter)
			{
				this.buildMarket(gameState, queues);
			}

			if (!this.saveResources)
			{
				this.buildForge(gameState, queues);
				this.buildTemple(gameState, queues);
			}

			if (gameState.ai.playedTurn % 30 === 0 && gameState.getPopulation() > 0.9 * gameState.getPopulationMax())
			{
				this.buildWonder(gameState, queues, false);
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
