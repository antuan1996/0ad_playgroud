type CommonPosition = [number, number];
type CommonResourceAmounts = Record<string, number>;
type CommonResourcesManager = import("simulation/ai/common-api/resources.js").ResourcesManager;
type CommonEntityFilter = {
	func: (entity: CommonEntity | CommonTemplate) => boolean;
	dynamicProperties: string[];
};
/**
 * A grid as the engine hands it to the AI: `Script::ToJSVal<Grid<uint8_t>>`
 * builds exactly `{width, height, data}`, and the AI side adds `cellSize`.
 * `data` is always there — treating it as optional lets a wrong field name
 * quietly read `undefined` instead of failing.
 */
type CommonPassabilityMap = {
	width: number;
	height: number;
	cellSize: number;
	data: Uint8Array;
};
type CommonMap = {
	width: number;
	height: number;
	cellSize: number;
	map: Uint8Array;
};
type CommonRequirement = {
	techs?: string[];
	entities?: Array<{
		class: string;
		number: number;
		check: "count" | "variants";
	}>;
};
type CommonTrainingQueueItem = {
	id: number;
	unitTemplate: string;
	count: number;
	progress: number;
	timeRemaining: number;
	metadata?: Record<string, unknown>;
};
type CommonResourceSupplyType = {
	generic: string;
	specific: string | undefined;
};

type CommonTemplate = import("simulation/ai/common-api/entity.js").Template;

type CommonEntity = import("simulation/ai/common-api/entity.js").Entity;

type CommonEntityCollection = import("simulation/ai/common-api/entitycollection.js").EntityCollection;

type CommonInfoMap = import("simulation/ai/common-api/map-module.js").InfoMap;

type CommonGameState = import("simulation/ai/common-api/gamestate.js").GameState;

type CommonSharedScript = import("simulation/ai/common-api/shared.js").SharedScript;
type CommonTechnology = import("simulation/ai/common-api/technology.js").Technology;

interface PetraEntityMetadata
{
	[key: string]: unknown;
	assignedResource: boolean;
	plan: number;
	base: number;
	transport: number;
	transporter: number;
	sea: number;
	access: number;
	PartOfArmy: number;
	"target-foundation": number;
	supply: number;
	treasure: number;
	garrisonHolder: number;
	guardedEnt: number;
	distance: number;
	lastAttackPlanUpdateTime: number;
	inaccessibleTime: number;
	approachingTime: number;
	timeGarrison: number;
	holderTimeUpdate: number;
	turnPreviousPosition: number;
	nextMoveToGatherer: number;
	lastHuntSearch: number;
	role: string;
	subrole: string;
	"gather-type": string;
	garrisonType: string;
	onBoard: number | "onBoard";
	endPos: CommonPosition;
	posGarrison: CommonPosition;
	previousPosition: CommonPosition;
	previousIdlePosition: CommonPosition;
	approachingPos: CommonPosition;
	allied: boolean;
	opensea: boolean;
	baseAnchor: boolean;
	garrisoning: boolean;
	approachingTarget: number | boolean;
	stationnary: boolean;
	alreadyTried: number | boolean;
	phaseUp: boolean;
	route: { source: number; target: number; gain: number; land?: number; sea?: number };
	lastGathered: number;
	carriedBefore: number;
/** The subrole of the entity before it was turned into a defender. */
	formerSubrole?: string;
}

interface CommonTemplateData
{
	[key: string]: unknown;
	affects?: Array<string | string[]>;
	Cost?: { Population?: number; [resource: string]: number | undefined };
	cost?: CommonResourceAmounts;
	modifications?: CommonTechnologyModificationList;
	requirements?: CommonRequirement[];
	BuildDistance?: { MinDistance?: number; FromClass?: string; [key: string]: number | string | undefined };
	UnitAI?: { DefaultStance?: string };
	Attack?: Record<string, { Bonuses?: Array<{
		Civ?: string;
		Classes?: string[];
		Multiplier: number;
	}> }>;
}

/** Describes a technology modification. */
interface CommonTechnologyModification
{
	value: string;
	add?: number;
	multiply?: number;
	replace?: string | number;
	tokens?: string;
	affects?: string;
	[key: string]: unknown;
}

type CommonTechnologyModificationList = CommonTechnologyModification[] & {
	[key: string]: CommonTechnologyModification;
};

interface CommonTechnologyTemplate
{
	genericName?: string;
	specificName?: Record<string, string>;
	partOfPair?: string;
	pair?: string[];
	cost?: Record<string, number>;
	researchTime?: number | string;
	autoResearch?: boolean;
	supersedes?: string[];
	modifications?: CommonTechnologyModificationList;
	affects?: Array<string | string[]>;
	[key: string]: unknown;
}

type CommonBaseAI = import("simulation/ai/common-api/baseAI.js").BaseAI;
type PetraBaseManager = import("./baseManager.ts").BaseManager;

declare module "simulation/ai/common-api/utils.js"
{
/** Logs a warning message for the AI. */
	export function aiWarn(output: unknown): void;
/** Stops the AI script with the given exit code. */
	export function exit(exitStatus: number): void;
/** Computes the distance between two positions. */
	export function VectorDistance(a: CommonPosition, b: CommonPosition): number;
/** Computes the squared distance between two positions. */
	export function SquareVectorDistance(a: CommonPosition, b: CommonPosition): number;
/** Maps a flat index to the corresponding source indices. */
	export function getMapIndices(index: number, map1: CommonMap | CommonPassabilityMap, map2: CommonMap | CommonPassabilityMap): number[];
}

declare module "simulation/ai/common-api/terrain-states.js"
{
/** Marks a tile as impassable. */
	export let IMPASSABLE: number;
/** Marks a tile as deep water. */
	export let DEEP_WATER: number;
/** Marks a tile as shallow water. */
	export let SHALLOW_WATER: number;
/** Marks a tile as land. */
	export let LAND: number;
}

declare module "simulation/ai/common-api/terrain-analysis.js"
{
/** Analyzes terrain values and influence over a map. */
	export class TerrainAnalysis
	{
/** Initializes the object. */
		constructor(sharedScript: CommonSharedScript, rawState: EngineAIState);
		width: number;
		height: number;
		cellSize: number;
		length: number;
		maxVal: number;
		map: Uint8Array;
/** Sets the maximum value for the map. */
		setMaxVal(value: number): void;
/** Converts a world position into a map-space position. */
		gamePosToMapPos(position: CommonPosition): CommonPosition;
/** Gets the value at the given map position. */
		point(position: CommonPosition): number;
/** Runs a loop over a map region and invokes a callback. */
		runLoop(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, maxDistSquared: number, callback: (index: number, distanceSquared: number) => number): void;
/** Adds influence around a center point. */
		addInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Represents the multiply Influence. */
		multiplyInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Adds another map or influence layer. */
		add(map: CommonInfoMap): void;
/** Sets the . */
		set(index: number, value: number): void;
		findBestTile(radius: number, obstruction: CommonInfoMap): { idx: number | undefined; val: number };
/** Finds a nearby tile that is not obstructed. */
		getNonObstructedTile(index: number, radius: number, obstruction: CommonInfoMap): number;
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
/** Dumps the map for debugging. */
		dumpIm(name?: string, threshold?: number): void;
	}
/** Calculates region connectivity and passability. */
	export class Accessibility extends TerrainAnalysis
	{
/** Initializes the object. */
		constructor(rawState: EngineAIState, terrainAnalyzer: TerrainAnalysis);
		landPassMap: Uint16Array;
		navalPassMap: Uint16Array;
		maxRegions: number;
		regionSize: number[];
		regionType: string[];
		regionLinks: number[][];
		regionID: number;
/** Gets the accessibility value at a position. */
		getAccessValue(position: CommonPosition, onWater?: boolean): number;
/** Gets the Traject To. */
		getTrajectTo(start: CommonPosition, end: CommonPosition): number[] | false | undefined;
/** Gets a path between two regions. */
		getTrajectToIndex(startRegion: number, endRegion: number): number[] | undefined;
/** Gets the Region Size. */
		getRegionSize(position: CommonPosition, onWater: boolean): number;
/** Gets the size of a region by index. */
		getRegionSizei(index: number, onWater: boolean): number;
/** Represents the flood Fill. */
		floodFill(startIndex: number, value: number, onWater: boolean): boolean;
	}
}

declare module "simulation/ai/common-api/technology.js"
{
/** Represents a technology definition and its effects. */
	export class Technology
	{
/** Initializes the object. */
		constructor(templateName: string);
		_templateName: string;
		_template: CommonTechnologyTemplate;
		get(path: "Cost/Population"): number | undefined;
		get(path: "ResourceSupply/Type"): string | undefined;
		get(path: string): any;
/** Gets the technology name. */
		name(civ?: string): string | undefined;
/** Checks whether the technology is paired by definition. */
		pairDef(): boolean;
/** Gets the technologies paired with this one. */
		getPairedTechs(): Technology[] | undefined;
/** Represents the pair. */
		pair(): string | undefined;
/** Gets the technology paired with this one. */
		pairedWith(): string | undefined;
/** Represents the cost. */
		cost(researcher?: CommonTemplate | CommonEntity): CommonResourceAmounts | undefined;
/** Gets the total cost of the technology. */
		costSum(researcher?: CommonTemplate | CommonEntity): number;
/** Represents the research Time. */
		researchTime(): number;
/** Gets the technology requirements. */
		requirements(civ?: string): TechnologyRequirements | CommonRequirement[] | false | undefined;
/** Represents the auto Research. */
		autoResearch(): boolean | string | undefined;
/** Gets the technology this one supersedes. */
		supersedes(): string[] | string | undefined;
/** Gets the technology modifications. */
		modifications(): CommonTechnologyModificationList | undefined;
/** Gets the targets affected by this technology. */
		affects(): Array<string | string[]> | undefined;
/** Checks whether the provided classes are affected. */
		isAffected(classes: string[] | string | undefined): boolean | undefined;
	}
}

declare module "simulation/ai/common-api/shared.js"
{
/** Stores shared AI state, templates, and entity collections. */
	export class SharedScript
	{
/** Initializes the object. */
		constructor(settings?: Record<string, unknown>);
		events: EngineAIEvents;
		_players: number[];
		_templates: Record<string, Record<string, unknown> | null>;
		_entities: Map<number, CommonEntity>;
		entities: CommonEntityCollection;
		_entityCollections: Map<number, CommonEntityCollection>;
		_entityCollectionsName: Map<string, CommonEntityCollection>;
		_entityCollectionsByDynProp: Record<string, Map<number, CommonEntityCollection>>;
		_entityCollectionsUID: number;
		_entitiesModifications: Map<number, Map<string, unknown>>;
		_templatesModifications: Record<string, Record<number, Map<string, unknown>>>;
		_entityMetadata: Record<number, Record<number, Record<string, unknown>>>;
		passabilityClasses: Record<string, number>;
		playersData: EnginePlayerState[];
		timeElapsed: number;
		circularMap: boolean;
		mapSize: number;
		victoryConditions: Set<string>;
		alliedVictory: boolean;
		ceasefireActive: boolean;
		ceasefireTimeRemaining: number;
		barterPrices: number[];
		passabilityMap: CommonPassabilityMap;
		territoryMap: CommonPassabilityMap;
		terrainAnalyzer: CommonInfoMap;
		accessibility: CommonInfoMap;
		gameState: Record<number, CommonGameState>;
		resources: number[];
		resourceMaps: Record<string, CommonInfoMap>;
		ccResourceMaps: Record<string, CommonInfoMap>;
		normalizationFactor: Record<string, number>;
		influenceRadius: Record<string, number>;
		ccInfluenceRadius: Record<string, number>;
/** Serializes the object state. */
		Serialize(): Record<string, unknown>;
/** Represents the Deserialize. */
		Deserialize(data: Record<string, unknown>): void;
/** Gets a template by name. */
		GetTemplate(name: string): Record<string, unknown> | null;
/** Represents the init. */
		init(state: EngineAIState, deserialization?: boolean): void;
/** Runs the update pass for the current state. */
		onUpdate(state: EngineAIState): void;
/** Applies Entities Delta. */
		ApplyEntitiesDelta(state: EngineAIState): void;
/** Applies template changes from the engine delta. */
		ApplyTemplatesDelta(state: EngineAIState): void;
/** Represents the register Updating Entity Collection. */
		registerUpdatingEntityCollection(collection: CommonEntityCollection): void;
/** Removes a dynamic entity collection. */
		removeUpdatingEntityCollection(collection: CommonEntityCollection): void;
/** Updates the Entity Collections. */
		updateEntityCollections(property: string, entity: CommonEntity): void;
/** Stores metadata for a player and entity. */
		setMetadata(player: number, entity: CommonEntity, key: string, value: unknown): void;
/** Gets the Metadata. */
		getMetadata<K extends keyof PetraEntityMetadata>(player: number, entity: CommonEntity, key: K): PetraEntityMetadata[K] | undefined;
		getMetadata(player: number, entity: CommonEntity, key: string): unknown;
/** Deletes metadata for a player and entity. */
		deleteMetadata(player: number, entity: CommonEntity, key: string): boolean;
/** Represents the create Resource Maps. */
		createResourceMaps(): void;
/** Updates the resource maps from engine events. */
		updateResourceMaps(events: EngineAIEvents): void;
/** Adds Entity To Resource Map. */
		addEntityToResourceMap(entity: CommonEntity): void;
/** Removes an entity from the resource map. */
		removeEntityFromResourceMap(entity: CommonEntity): void;
/** Represents the change Entity In Resource Map Helper. */
		changeEntityInResourceMapHelper(entity: CommonEntity | undefined, multiplication?: number): void;
	}
}

declare module "simulation/ai/common-api/resources.js"
{
/** Tracks resource amounts and population. */
	export class ResourcesManager
	{
/** Initializes the object. */
		constructor(amounts?: CommonResourceAmounts, population?: number);
		population: number;
		food: number;
		wood: number;
		stone: number;
		metal: number;
/** Represents the reset. */
		reset(): void;
/** Represents the can Afford. */
		canAfford(amounts: CommonResourceAmounts | ResourcesManager): boolean;
/** Adds another map or influence layer. */
		add(amounts: CommonResourceAmounts | ResourcesManager): void;
/** Represents the subtract. */
		subtract(amounts: CommonResourceAmounts | ResourcesManager): void;
/** Represents the multiply. */
		multiply(multiplier: number): void;
		Serialize(): { amounts: CommonResourceAmounts; population: number };
/** Deserializes a saved object state. */
		Deserialize(data: { amounts: CommonResourceAmounts; population: number }): void;
		[key: string]: any;
	}
}

declare module "simulation/ai/common-api/map-module.js"
{
/** Stores terrain or influence data for AI analysis. */
	export class InfoMap
	{
/** Initializes the object. */
		constructor(sharedScript: CommonSharedScript | Record<string, unknown>, type: string, originalMap?: Uint8Array, actualCopy?: boolean);
		width: number;
		height: number;
		cellSize: number;
		length: number;
		maxVal: number;
		map: Uint8Array;
		pattern?: number[];
/** Sets the maximum value for the map. */
		setMaxVal(value: number): void;
/** Converts a world position into a map-space position. */
		gamePosToMapPos(position: CommonPosition): CommonPosition;
/** Gets the value at the given map position. */
		point(position: CommonPosition): number;
/** Runs a loop over a map region and invokes a callback. */
		runLoop(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, maxDistSquared: number, callback: (index: number, distanceSquared: number) => number): void;
/** Adds influence around a center point. */
		addInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Represents the multiply Influence. */
		multiplyInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Adds another map or influence layer. */
		add(map: CommonInfoMap): void;
/** Sets the . */
		set(index: number, value: number): void;
		findBestTile(radius: number, obstruction: CommonInfoMap): { idx: number | undefined; val: number };
/** Finds a nearby tile that is not obstructed. */
		getNonObstructedTile(index: number, radius: number, obstruction: CommonInfoMap): number;
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
/** Dumps the map for debugging. */
		dumpIm(name?: string, threshold?: number): void;
	}
}

declare module "simulation/ai/common-api/gamestate.js"
{
/** Provides per-player state and collection helpers. */
	export class GameState
	{
/** Initializes the object. */
		constructor();
		ai: PetraRuntime.AIState;
		sharedScript: CommonSharedScript;
		entities: CommonEntityCollection;
		EntCollecNames: Map<string, CommonEntityCollection>;
		timeElapsed: number;
		circularMap: boolean;
		templates: Record<string, Record<string, unknown> | null>;
		player: number;
		playerData: EnginePlayerState;
		victoryConditions: Set<string>;
		alliedVictory: boolean;
		ceasefireActive: boolean;
		ceasefireTimeRemaining: number;
		phases: Array<{ name: string; requirements: CommonRequirement[] }>;
/** Initializes the script with the current engine state. */
		init(sharedScript: CommonSharedScript, state: Record<string, unknown>, player: number): void;
/** Updates the . */
		update(sharedScript: CommonSharedScript): void;
/** Represents the updating Collection. */
		updatingCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
/** Represents the destroy Collection. */
		destroyCollection(id: string): void;
/** Represents the updating Global Collection. */
		updatingGlobalCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
/** Represents the destroy Global Collection. */
		destroyGlobalCollection(id: string): void;
/** Represents the reset On Diplomacy Changed. */
		resetOnDiplomacyChanged(): void;
/** Gets the Time Elapsed. */
		getTimeElapsed(): number;
/** Gets the Barter Prices. */
		getBarterPrices(): { buy: CommonResourceAmounts; sell: CommonResourceAmounts };
/** Gets the Victory Conditions. */
		getVictoryConditions(): Set<string>;
/** Gets the Allied Victory. */
		getAlliedVictory(): boolean;
/** Represents the is Ceasefire Active. */
		isCeasefireActive(): boolean;
/** Gets the Template. */
		getTemplate(type: string): CommonTemplate | null;
/** Gets the Built Template. */
		getBuiltTemplate(foundationName: string): CommonEntity | null;
/** Represents the apply Civ. */
		applyCiv(templateName: string): string;
/** Gets the Player Civ. */
		getPlayerCiv(player?: number): string;
/** Represents the current Phase. */
		currentPhase(): number;
/** Gets the Number Of Phases. */
		getNumberOfPhases(): number;
/** Gets the Phase Name. */
		getPhaseName(index: number): string | undefined;
		getPhaseEntityRequirements(index: number): Array<{ class: string; count: number }>;
/** Represents the is Researched. */
		isResearched(template: string): boolean;
/** Represents the is Researching. */
		isResearching(template: string): boolean;
/** Represents the can Research. */
		canResearch(templateName: string, noRequirementCheck?: boolean): boolean;
/** Represents the check Tech Requirements. */
		checkTechRequirements(requirements: CommonRequirement[] | false): boolean;
/** Gets the Passability Map. */
		getPassabilityMap(): CommonPassabilityMap;
/** Gets the Passability Class Mask. */
		getPassabilityClassMask(name: string): number;
/** Gets the Resources. */
		getResources(): CommonResourcesManager;
/** Gets the Population. */
		getPopulation(): number;
/** Gets the Population Limit. */
		getPopulationLimit(): number;
/** Gets the Population Max. */
		getPopulationMax(): number;
/** Gets the Player ID. */
		getPlayerID(): number;
/** Represents the has Allies. */
		hasAllies(): boolean;
/** Represents the has Enemies. */
		hasEnemies(): boolean;
/** Represents the has Neutrals. */
		hasNeutrals(): boolean;
/** Represents the is Player Neutral. */
		isPlayerNeutral(id: number): boolean;
/** Represents the is Player Ally. */
		isPlayerAlly(id: number): boolean;
/** Represents the is Player Mutual Ally. */
		isPlayerMutualAlly(id: number): boolean;
/** Represents the is Player Enemy. */
		isPlayerEnemy(id: number): boolean;
/** Gets the Num Player Enemies. */
		getNumPlayerEnemies(): number;
/** Gets the Enemies. */
		getEnemies(): number[];
/** Gets the Neutrals. */
		getNeutrals(): number[];
/** Gets the Allies. */
		getAllies(): number[];
/** Gets the Exclusive Allies. */
		getExclusiveAllies(): number[];
/** Gets the Mutual Allies. */
		getMutualAllies(): number[];
/** Represents the is Entity Ally. */
		isEntityAlly(entity: CommonEntity | undefined): boolean;
/** Represents the is Entity Exclusive Ally. */
		isEntityExclusiveAlly(entity: CommonEntity | undefined): boolean;
/** Represents the is Entity Enemy. */
		isEntityEnemy(entity: CommonEntity | undefined): boolean;
/** Represents the is Entity Own. */
		isEntityOwn(entity: CommonEntity | undefined): boolean;
/** Gets the Entity By Id. Returns undefined for an undefined, zero or stale id. */
		getEntityById(id: number | undefined): CommonEntity | undefined;
/** Gets the Entities. */
		getEntities(id?: number): CommonEntityCollection;
/** Gets the Structures. */
		getStructures(): CommonEntityCollection;
/** Gets the Own Entities. */
		getOwnEntities(): CommonEntityCollection;
/** Gets the Own Structures. */
		getOwnStructures(): CommonEntityCollection;
/** Gets the Own Units. */
		getOwnUnits(): CommonEntityCollection;
/** Gets the Ally Entities. */
		getAllyEntities(): CommonEntityCollection;
/** Gets the Exclusive Ally Entities. */
		getExclusiveAllyEntities(): CommonEntityCollection;
/** Gets the Ally Structures. */
		getAllyStructures(allyID?: number): CommonEntityCollection;
/** Gets the Neutral Structures. */
		getNeutralStructures(): CommonEntityCollection;
/** Gets the Enemy Entities. */
		getEnemyEntities(): CommonEntityCollection;
/** Gets the Enemy Structures. */
		getEnemyStructures(enemyID?: number): CommonEntityCollection;
/** Gets the Enemy Units. */
		getEnemyUnits(enemyID?: number): CommonEntityCollection;
/** Gets the Own Entities By Metadata. */
		getOwnEntitiesByMetadata(key: string, value: unknown, maintain?: boolean): CommonEntityCollection;
/** Gets the Own Entities By Role. */
		getOwnEntitiesByRole(role: string | undefined, maintain?: boolean): CommonEntityCollection;
/** Gets the Own Entities By Type. */
		getOwnEntitiesByType(type: string, maintain?: boolean): CommonEntityCollection;
/** Gets the Own Entities By Class. */
		getOwnEntitiesByClass(cls: string, maintain?: boolean): CommonEntityCollection;
/** Gets the Own Foundations By Class. */
		getOwnFoundationsByClass(cls: string, maintain?: boolean): CommonEntityCollection;
/** Gets the Own Training Facilities. */
		getOwnTrainingFacilities(): CommonEntityCollection;
/** Gets the Own Research Facilities. */
		getOwnResearchFacilities(): CommonEntityCollection;
/** Represents the count Entities By Type. */
		countEntitiesByType(type: string, maintain?: boolean): number;
/** Represents the count Entities And Queued By Type. */
		countEntitiesAndQueuedByType(type: string, maintain?: boolean): number;
/** Represents the count Foundations By Type. */
		countFoundationsByType(type: string, maintain?: boolean): number;
/** Represents the count Own Entities By Role. */
		countOwnEntitiesByRole(role: string): number;
/** Represents the count Own Entities And Queued With Role. */
		countOwnEntitiesAndQueuedWithRole(role: string): number;
/** Represents the count Own Queued Entities With Metadata. */
		countOwnQueuedEntitiesWithMetadata(data: string, value: unknown): number;
/** Gets the Own Foundations. */
		getOwnFoundations(): CommonEntityCollection;
/** Gets the Own Dropsites. */
		getOwnDropsites(resource?: string): CommonEntityCollection;
/** Gets the Any Dropsites. */
		getAnyDropsites(resource?: string): CommonEntityCollection;
/** Gets the Resource Supplies. */
		getResourceSupplies(resource: string): CommonEntityCollection;
/** Gets the Huntable Supplies. */
		getHuntableSupplies(): CommonEntityCollection;
/** Gets the Fishable Supplies. */
		getFishableSupplies(): CommonEntityCollection;
/** Represents the find Trainable Units. */
		findTrainableUnits(classes: Array<string | string[]>, anticlasses?: string[]): Array<[string, CommonTemplate]>;
/** Represents the find Available Tech. */
		findAvailableTech(): Array<[string, CommonTemplate]>;
/** Represents the has Trainer. */
		hasTrainer(template: string): boolean;
/** Represents the find Trainers. */
		findTrainers(template: string): CommonEntityCollection;
/** Represents the find Builder. */
		findBuilder(template: string): CommonEntity | undefined;
/** Represents the has Researchers. */
		hasResearchers(templateName: string, noRequirementCheck?: boolean): boolean;
/** Represents the find Researchers. */
		findResearchers(templateName: string, noRequirementCheck?: boolean): CommonEntityCollection | undefined;
/** Gets the Entity Limits. */
		getEntityLimits(): Record<string, number>;
/** Gets the Entity Match Counts. */
		getEntityMatchCounts(): Record<string, number>;
/** Gets the Entity Counts. */
		getEntityCounts(): Record<string, number>;
/** Represents the is Template Available. */
		isTemplateAvailable(templateName: string): boolean | undefined;
/** Represents the is Template Disabled. */
		isTemplateDisabled(templateName: string): boolean;
/** Represents the is Entity Limit Reached. */
		isEntityLimitReached(category: string): boolean;
		getTraderTemplatesGains(): { landGainMultiplier?: number; navalGainMultiplier?: number };
	}
}

declare module "simulation/ai/common-api/filters.js"
{
/** Represents the by Type. */
	export function byType(type: string): CommonEntityFilter;
/** Represents the by Class. */
	export function byClass(cls: string): CommonEntityFilter;
/** Represents the by Classes. */
	export function byClasses(clsList: string[] | string): CommonEntityFilter;
/** Represents the by Metadata. */
	export function byMetadata(player: number, key: string, value: unknown): CommonEntityFilter;
/** Represents the by Has Metadata. */
	export function byHasMetadata(player: number, key: string): CommonEntityFilter;
/** Represents the and. */
	export function and(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
/** Represents the or. */
	export function or(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
/** Represents the not. */
	export function not(filter: CommonEntityFilter): CommonEntityFilter;
/** Represents the by Owner. */
	export function byOwner(owner: number): CommonEntityFilter;
/** Represents the by Not Owner. */
	export function byNotOwner(owner: number): CommonEntityFilter;
/** Represents the by Owners. */
	export function byOwners(owners: number[]): CommonEntityFilter;
/** Represents the by Can Garrison. */
	export function byCanGarrison(): CommonEntityFilter;
/** Represents the by Training Queue. */
	export function byTrainingQueue(): CommonEntityFilter;
/** Represents the by Research Available. */
	export function byResearchAvailable(gameState: CommonGameState, civ: string): CommonEntityFilter;
/** Represents the by Can Attack Class. */
	export function byCanAttackClass(aClass: string): CommonEntityFilter;
/** Represents the by Can Attack Target. */
	export function byCanAttackTarget(target: CommonEntity): CommonEntityFilter;
/** Represents the is Garrisoned. */
	export function isGarrisoned(): CommonEntityFilter;
/** Represents the is Idle. */
	export function isIdle(): CommonEntityFilter;
/** Represents the is Foundation. */
	export function isFoundation(): CommonEntityFilter;
/** Represents the is Built. */
	export function isBuilt(): CommonEntityFilter;
/** Represents the has Defensive Fire. */
	export function hasDefensiveFire(): CommonEntityFilter;
/** Represents the is Dropsite. */
	export function isDropsite(resourceType?: string): CommonEntityFilter;
/** Represents the is Treasure. */
	export function isTreasure(): CommonEntityFilter;
/** Represents the by Resource. */
	export function byResource(resourceType: string): CommonEntityFilter;
/** Represents the is Huntable. */
	export function isHuntable(): CommonEntityFilter;
/** Represents the is Fishable. */
	export function isFishable(): CommonEntityFilter;
}

declare module "simulation/ai/common-api/entitycollection.js"
{
/** Represents the Entity Collection. */
	export class EntityCollection
	{
/** Initializes the object. */
		constructor(sharedAI: CommonSharedScript, entities?: Map<number, CommonEntity>, filters?: CommonEntityFilter[]);
		readonly length: number;
		frozen: boolean;
		Serialize(): { ents: number[]; frozen: boolean; filters: string[] };
/** Deserializes a saved object state. */
		Deserialize(data: { ents: number[]; frozen: boolean; filters: string[] }, sharedAI: CommonSharedScript): void;
/** Represents the freeze. */
		freeze(): void;
/** Represents the defreeze. */
		defreeze(): void;
/** Represents the to Id Array. */
		toIdArray(): number[];
/** Represents the to Entity Array. */
		toEntityArray(): CommonEntity[];
/** Represents the values. */
		values(): IterableIterator<CommonEntity>;
/** Represents the to String. */
		toString(): string;
/** Represents the filter. */
		filter(filter: CommonEntityFilter | ((entity: CommonEntity, id: number, collection: this) => boolean), thisp?: unknown): EntityCollection;
		filterNearest(targetPos: CommonPosition, n?: number): EntityCollection;
/** Represents the filter raw. */
		filter_raw(callback: (entity: unknown, id: number, collection: this) => boolean, thisp?: unknown): EntityCollection;
/** Represents the for Each. */
		forEach(callback: (entity: CommonEntity) => void): this;
/** Represents the has Entities. */
		hasEntities(): boolean;
/** Represents the move. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Represents the move To Range. */
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
/** Represents the attack Move. */
		attackMove(x: number, z: number, targetClasses: string[] | {
			attack: string[];
			avoid: string[];
			vetoEntities: Record<string, boolean>;
		}, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Represents the move Indiv. */
		moveIndiv(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Represents the garrison. */
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the occupy Turret. */
		occupyTurret(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the destroy. */
		destroy(): this;
/** Represents the attack. */
		attack(unitId: number, queued?: boolean, pushFront?: boolean): this;
/** Sets the Stance. */
		setStance(stance: string): this;
/** Gets the Centre Position. */
		getCentrePosition(): CommonPosition | undefined;
/** Gets the Approximate Position. */
		getApproximatePosition(sample: number): CommonPosition | undefined;
/** Represents the has Ent Id. */
		hasEntId(id: number): boolean;
/** Removes Ent. */
		removeEnt(entity: CommonEntity): boolean;
/** Adds Ent. */
		addEnt(entity: CommonEntity): boolean;
/** Represents the update Ent. */
		updateEnt(entity: CommonEntity, force?: boolean): boolean;
/** Represents the register Updates. */
		registerUpdates(): void;
/** Represents the unregister. */
		unregister(): void;
/** Represents the dynamic Properties. */
		dynamicProperties(): string[];
/** Sets the UID. */
		setUID(id: number): void;
/** Gets the UID. */
		getUID(): number;
	}
}

declare module "simulation/ai/common-api/entity.js"
{
/** Represents the Template. */
	export class Template
	{
/** Initializes the object. */
		constructor(sharedAI: CommonSharedScript, templateName: string, template: Record<string, unknown>);
		_template: CommonTemplateData;
		_templateName?: string;
/** Gets the template value, adjusting for tech. */
		get(path: "Cost/Population"): number | undefined;
		get(path: "UnitAI/DefaultStance"): string | undefined;
		get(path: "ResourceSupply/Type"): string | undefined;
		get(path: "Attack/Melee/Bonuses" | "Attack/Ranged/Bonuses"): Array<{
			Civ?: string;
			Classes?: string[];
			Multiplier: number;
		}> | undefined;
		get(path: string): any;
/** Represents the template Name. */
		templateName(): string;
/** Represents the generic Name. */
		genericName(): string | undefined;
/** Represents the civ. */
		civ(): string | undefined;
/** Represents the match Limit. */
		matchLimit(): number | undefined;
/** Represents the classes. */
		classes(): string[] | undefined;
/** Represents the has Class. */
		hasClass(name: string): boolean | undefined;
/** Represents the has Classes. */
		hasClasses(classes: string[] | string | string[][] | undefined): boolean | undefined;
/** Gets the technology requirements. */
		requirements(): TechnologyRequirements | CommonRequirement[] | undefined;
/** Represents the available. */
		available(gameState: CommonGameState): boolean;
/** Represents the cost. */
		cost(productionQueue?: unknown): CommonResourceAmounts;
/** Gets the total cost of the technology. */
		costSum(productionQueue?: unknown): number;
/** Represents the tech Cost Multiplier. */
		techCostMultiplier(type: string): number;
		obstructionRadius(): { max: number; min: number } | undefined;
/** Represents the footprint Radius. */
		footprintRadius(): number | undefined;
/** Represents the max Hitpoints. */
		maxHitpoints(): number;
/** Represents the is Healable. */
		isHealable(): boolean;
/** Represents the is Repairable. */
		isRepairable(): boolean;
/** Gets the Population Bonus. */
		getPopulationBonus(): number;
/** Represents the resistance Strengths. */
		resistanceStrengths(): { Capture?: number; Damage?: Record<string, number> } | undefined;
/** Represents the attack Types. */
		attackTypes(): string[] | undefined;
		attackRange(type: string): { max: number; min: number } | undefined;
/** Represents the attack Strengths. */
		attackStrengths(type: string): Record<string, number> | undefined;
/** Represents the capture Strength. */
		captureStrength(): number | undefined;
		attackTimes(type: string): Record<string, number> | undefined;
/** Gets the Countered Classes. */
		getCounteredClasses(): Array<[string[], number]> | undefined;
/** Represents the counters. */
		counters(target: CommonTemplate | CommonEntity): boolean;
/** Gets the Multiplier Against. */
		getMultiplierAgainst(type: string, againstClass: string): number | undefined;
/** Represents the buildable Entities. */
		buildableEntities(civ: string): string[];
/** Represents the trainable Entities. */
		trainableEntities(civ: string): string[] | undefined;
/** Represents the researchable Techs. */
		researchableTechs(gameState: CommonGameState, civ: string): string[] | undefined;
/** Represents the resource Supply Type. */
		resourceSupplyType(): CommonResourceSupplyType | undefined;
/** Gets the Resource Type. */
		getResourceType(): string | undefined;
/** Gets the Diminishing Returns. */
		getDiminishingReturns(): number;
/** Represents the resource Supply Max. */
		resourceSupplyMax(): number;
/** Represents the max Gatherers. */
		maxGatherers(): number;
/** Represents the resource Gather Rates. */
		resourceGatherRates(): Record<string, number> | undefined;
/** Represents the resource Dropsite Types. */
		resourceDropsiteTypes(): string[] | undefined;
/** Represents the is Resource Dropsite. */
		isResourceDropsite(resourceType?: string): boolean | undefined;
/** Represents the is Treasure. */
		isTreasure(): boolean;
/** Represents the treasure Resources. */
		treasureResources(): Record<string, number> | undefined;
/** Represents the garrisonable Classes. */
		garrisonableClasses(): string[] | undefined;
/** Represents the garrison Max. */
		garrisonMax(): number;
/** Represents the garrison Size. */
		garrisonSize(): number;
/** Represents the garrison Eject Health. */
		garrisonEjectHealth(): number;
/** Gets the Default Arrow. */
		getDefaultArrow(): number;
/** Gets the Arrow Multiplier. */
		getArrowMultiplier(): number;
/** Gets the Garrison Arrow Classes. */
		getGarrisonArrowClasses(): string[] | undefined;
/** Represents the buff Heal. */
		buffHeal(): number;
/** Represents the promotion. */
		promotion(): string | undefined;
/** Represents the is Packable. */
		isPackable(): boolean;
/** Represents the is Huntable. */
		isHuntable(): boolean;
/** Represents the walk Speed. */
		walkSpeed(): number;
/** Represents the training Category. */
		trainingCategory(): string | undefined;
/** Represents the build Time. */
		buildTime(researcher?: CommonTemplate | CommonEntity): number;
		researchTime(): number;
/** Represents the build Category. */
		buildCategory(): string | undefined;
/** Represents the build Distance. */
		buildDistance(): { MinDistance?: number; FromClass?: string; [key: string]: number | string | undefined } | undefined;
/** Represents the build Placement Type. */
		buildPlacementType(): string | undefined;
/** Represents the build Territories. */
		buildTerritories(): string[] | undefined;
/** Represents the has Build Territory. */
		hasBuildTerritory(territory: string): boolean | undefined;
/** Represents the has Territory Influence. */
		hasTerritoryInfluence(): boolean;
/** Represents the has Defensive Fire. */
		hasDefensiveFire(): number | false;
/** Represents the territory Influence Radius. */
		territoryInfluenceRadius(): number;
/** Represents the territory Influence Weight. */
		territoryInfluenceWeight(): number;
/** Represents the territory Decay Rate. */
		territoryDecayRate(): number;
/** Represents the default Regen Rate. */
		defaultRegenRate(): number;
/** Represents the garrison Regen Rate. */
		garrisonRegenRate(): number;
/** Represents the vision Range. */
		visionRange(): number;
/** Represents the gain Multiplier. */
		gainMultiplier(): number;
/** Represents the is Builder. */
		isBuilder(): boolean;
/** Represents the is Gatherer. */
		isGatherer(): boolean;
/** Represents the can Gather. */
		canGather(type: string): boolean;
/** Represents the is Garrison Holder. */
		isGarrisonHolder(): boolean;
/** Represents the is Turret Holder. */
		isTurretHolder(): boolean;
/** Represents the can Capture. */
		canCapture(target?: CommonTemplate | CommonEntity): boolean;
/** Represents the is Capturable. */
		isCapturable(): boolean;
/** Represents the can Guard. */
		canGuard(): boolean;
/** Represents the can Garrison. */
		canGarrison(): boolean;
/** Represents the can Occupy Turret. */
		canOccupyTurret(): boolean;
/** Represents the is Treasure Collector. */
		isTreasureCollector(): boolean;
/** Represents the has Unit AI. */
		hasUnitAI(): boolean;
	}
/** Represents the Entity. */
	export class Entity extends Template
	{
/** The raw engine entity state (private `_entity` in entity.js). */
		_entity: EngineAIEntityState;
/** Initializes the object. */
		constructor(sharedAI: CommonSharedScript, entity: Record<string, unknown>);
/** Represents the query Interface. */
		queryInterface(iid: string | number): any;
/** Represents the to String. */
		toString(): string;
/** Represents the id. */
		id(): number;
/** Gets metadata for a player and entity. */
		getMetadata<K extends keyof PetraEntityMetadata>(player: number, key: K): PetraEntityMetadata[K] | undefined;
		getMetadata(player: number, key: string): any;
/** Sets the Metadata. */
		setMetadata(player: number, key: string, value: unknown): void;
/** Represents the delete All Metadata. */
		deleteAllMetadata(player: number): void;
/** Represents the delete Metadata. */
		deleteMetadata(player: number, key: string): void;
/** Represents the position. */
		position(): CommonPosition;
/** Represents the angle. */
		angle(): number | undefined;
/** Represents the is Idle. */
		isIdle(): boolean | undefined;
/** Gets the Stance. */
		getStance(): string | undefined;
/** Represents the unit AI State. */
		unitAIState(): string | undefined;
/** Represents the unit AI Order Data. */
		unitAIOrderData(): Array<{ target?: number; force?: boolean; [key: string]: unknown }>;
/** Represents the hitpoints. */
		hitpoints(): number;
/** Represents the is Hurt. */
		isHurt(): boolean;
/** Represents the health Level. */
		healthLevel(): number;
/** Represents the needs Heal. */
		needsHeal(): boolean;
/** Represents the needs Repair. */
		needsRepair(): boolean;
/** Represents the decaying. */
		decaying(): boolean | undefined;
/** Represents the capture Points. */
		capturePoints(): number[] | undefined;
/** Represents the is Invulnerable. */
		isInvulnerable(): boolean;
/** Represents the is Shared Dropsite. */
		isSharedDropsite(): boolean;
/** Represents the training Queue. */
		trainingQueue(): CommonTrainingQueueItem[] | undefined;
/** Represents the training Queue Time. */
		trainingQueueTime(): number | undefined;
/** Represents the foundation Progress. */
		foundationProgress(): number | undefined;
/** Gets the Builders. */
		getBuilders(): number[] | undefined;
/** Gets the Builders Nb. */
		getBuildersNb(): number | undefined;
/** Represents the owner. */
		owner(): number;
/** Represents the is Own. */
		isOwn(player: number): boolean;
/** Represents the resource Supply Amount. */
		resourceSupplyAmount(): number | undefined;
/** Represents the resource Supply Num Gatherers. */
		resourceSupplyNumGatherers(): number | undefined;
/** Represents the is Full. */
		isFull(): boolean | undefined;
		resourceCarrying(): Array<{ class?: string; type: string; amount: number }> | undefined;
/** Represents the current Gather Rate. */
		currentGatherRate(): number | undefined;
/** Represents the garrison Holder ID. */
		garrisonHolderID(): number | undefined;
/** Represents the garrisoned. */
		garrisoned(): number[];
/** Represents the garrisoned Slots. */
		garrisonedSlots(): number;
/** Represents the can Garrison Inside. */
		canGarrisonInside(): boolean;
/** Represents the can Attack Class. */
		canAttackClass(aClass: string): boolean;
/** Represents the can Attack Target. */
		canAttackTarget(target: CommonEntity, allowCapture?: boolean): boolean;
/** Represents the move. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Represents the move To Range. */
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
/** Represents the attack Move. */
		attackMove(x: number, z: number, targetClasses?: string[] | {
			attack: string[];
			avoid?: string[];
			vetoEntities?: Record<string, boolean>;
		}, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Sets the Stance. */
		setStance(stance: string): this | undefined;
/** Represents the stop Moving. */
		stopMoving(): void;
/** Represents the unload. */
		unload(id: number): this | undefined;
/** Represents the unload All. */
		unloadAll(): this | undefined;
/** Represents the garrison. */
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		["occupy-turret"](target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the attack. */
		attack(unitId: number, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Represents the collect Treasure. */
		collectTreasure(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the move Apart. */
		moveApart(point: CommonPosition, distance: number): this;
/** Represents the flee. */
		flee(unitToFleeFrom: CommonEntity): this;
/** Represents the gather. */
		gather(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the repair. */
		repair(target: CommonEntity, autocontinue?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Represents the return Resources. */
		returnResources(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Represents the destroy. */
		destroy(): this;
/** Represents the barter. */
		barter(buyType: string, sellType: string, amount: number): this;
/** Represents the trade Route. */
		tradeRoute(target: CommonEntity, source: CommonEntity): this;
/** Sets the Rally Point. */
		setRallyPoint(target: CommonEntity, command?: string): this;
/** Represents the unset Rally Point. */
		unsetRallyPoint(): this;
/** Represents the train. */
		train(civ: string, type: string, count: number, metadata?: Record<string, unknown>, pushFront?: boolean): this;
/** Represents the construct. */
		construct(template: string, x: number, z: number, angle: number, metadata?: Record<string, unknown>): this;
/** Represents the research. */
		research(template: string, pushFront?: boolean): this;
/** Represents the stop Production. */
		stopProduction(id: number): this;
/** Represents the stop All Production. */
		stopAllProduction(percentToStopAt: number): this | true;
/** Represents the guard. */
		guard(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Removes Guard. */
		removeGuard(): this;
	}
}

declare module "simulation/ai/common-api/baseAI.js"
{
/** Represents the Base AI. */
	export class BaseAI
	{
/** Initializes the object. */
		constructor(settings?: Record<string, unknown>);
		player: number;
		/**
		 * The engine's territory grid, handed to the AI as `{width, height, data}`
		 * (CCmpAIManager, EngineScriptConversions). Not an InfoMap: baseAI assigns
		 * `sharedAI.territoryMap` here without wrapping it.
		 */
		territoryMap: CommonPassabilityMap;
		accessibility: CommonInfoMap;
		gameState: CommonGameState;
		timeElapsed: number;
/** Serializes the object state. */
		Serialize(): Record<string, unknown>;
/** Represents the Deserialize. */
		Deserialize(data: Record<string, unknown>, sharedScript: CommonSharedScript): void;
/** Represents the Init. */
		Init(playerID: number, sharedAI: CommonSharedScript): void;
/** Represents the Custom Init. */
		CustomInit(gameState: CommonGameState): void;
/** Handles Message. */
		HandleMessage(state: Record<string, unknown>, playerID: number, sharedAI: CommonSharedScript): void;
/** Represents the On Update. */
		OnUpdate(sharedAI: CommonSharedScript): void;
/** Represents the chat. */
		chat(message: string): void;
	}
}
