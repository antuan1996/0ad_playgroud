type CommonPosition = [number, number];
type CommonResourceAmounts = Record<string, number>;
type CommonResourcesManager = import("simulation/ai/common-api/resources.js").ResourcesManager;
type CommonEntityFilter = {
	func: (entity: CommonEntity) => boolean;
	dynamicProperties: string[];
};
type CommonPassabilityMap = {
	width: number;
	height: number;
	cellSize: number;
	data?: Uint8Array;
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

interface CommonTechnologyModification
{
	value: string;
	add?: number;
	multiply?: number;
	replace?: string | number;
	tokens?: string;
	affects?: string;
}

type CommonBaseAI = import("simulation/ai/common-api/baseAI.js").BaseAI;

declare module "simulation/ai/common-api/utils.js"
{
	export function aiWarn(output: unknown): void;
	export function exit(exitStatus: number): void;
	export function VectorDistance(a: CommonPosition, b: CommonPosition): number;
	export function SquareVectorDistance(a: CommonPosition, b: CommonPosition): number;
	export function getMapIndices(index: number, map1: CommonMap, map2: CommonMap): number[];
}

declare module "simulation/ai/common-api/terrain-states.js"
{
	export let IMPASSABLE: number;
	export let DEEP_WATER: number;
	export let SHALLOW_WATER: number;
	export let LAND: number;
}

declare module "simulation/ai/common-api/terrain-analysis.js"
{
	export class TerrainAnalysis
	{
		constructor(sharedScript: CommonSharedScript, rawState: Record<string, any>);
		width: number;
		height: number;
		cellSize: number;
		length: number;
		maxVal: number;
		map: Uint8Array;
		setMaxVal(value: number): void;
		gamePosToMapPos(position: CommonPosition): CommonPosition;
		point(position: CommonPosition): number;
		runLoop(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, maxDistSquared: number, callback: (index: number, distanceSquared: number) => number): void;
		addInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
		multiplyInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
		add(map: CommonInfoMap): void;
		set(index: number, value: number): void;
		findBestTile(radius: number, obstruction: CommonInfoMap): { idx: number | undefined; val: number };
		getNonObstructedTile(index: number, radius: number, obstruction: CommonInfoMap): number;
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
		dumpIm(name?: string, threshold?: number): void;
	}
	export class Accessibility extends TerrainAnalysis
	{
		constructor(rawState: Record<string, any>, terrainAnalyzer: TerrainAnalysis);
		landPassMap: Uint16Array;
		navalPassMap: Uint16Array;
		maxRegions: number;
		regionSize: number[];
		regionType: string[];
		regionLinks: number[][];
		regionID: number;
		getAccessValue(position: CommonPosition, onWater: boolean): number;
		getTrajectTo(start: CommonPosition, end: CommonPosition): number[] | false | undefined;
		getTrajectToIndex(startRegion: number, endRegion: number): number[] | undefined;
		getRegionSize(position: CommonPosition, onWater: boolean): number;
		getRegionSizei(index: number, onWater: boolean): number;
		floodFill(startIndex: number, value: number, onWater: boolean): boolean;
	}
}

declare module "simulation/ai/common-api/technology.js"
{
	export class Technology
	{
		constructor(templateName: string);
		_templateName: string;
		_template: Record<string, any>;
		name(civ?: string): string | undefined;
		pairDef(): boolean;
		getPairedTechs(): Technology[] | undefined;
		pair(): string | undefined;
		pairedWith(): string | undefined;
		cost(researcher?: CommonTemplate): CommonResourceAmounts | undefined;
		costSum(researcher?: CommonTemplate): number;
		researchTime(): number;
		requirements(civ?: string): CommonRequirement[] | false;
		autoResearch(): string | undefined;
		supersedes(): string | undefined;
		modifications(): CommonTechnologyModification[] | undefined;
		affects(): string[] | undefined;
		isAffected(classes: string[] | string | undefined): boolean | undefined;
	}
}

declare module "simulation/ai/common-api/shared.js"
{
	export class SharedScript
	{
		constructor(settings?: Record<string, any>);
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
		playersData: Record<number, Record<string, any>>;
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
		Serialize(): Record<string, unknown>;
		Deserialize(data: Record<string, any>): void;
		GetTemplate(name: string): Record<string, unknown> | null;
		init(state: Record<string, any>, deserialization?: boolean): void;
		onUpdate(state: Record<string, any>): void;
		ApplyEntitiesDelta(state: Record<string, any>): void;
		ApplyTemplatesDelta(state: Record<string, any>): void;
		registerUpdatingEntityCollection(collection: CommonEntityCollection): void;
		removeUpdatingEntityCollection(collection: CommonEntityCollection): void;
		updateEntityCollections(property: string, entity: CommonEntity): void;
		setMetadata(player: number, entity: CommonEntity, key: string, value: unknown): void;
		getMetadata(player: number, entity: CommonEntity, key: string): unknown;
		deleteMetadata(player: number, entity: CommonEntity, key: string): boolean;
		createResourceMaps(): void;
		updateResourceMaps(events: Record<string, any>): void;
		addEntityToResourceMap(entity: CommonEntity): void;
		removeEntityFromResourceMap(entity: CommonEntity): void;
		changeEntityInResourceMapHelper(entity: CommonEntity | undefined, multiplication?: number): void;
	}
}

declare module "simulation/ai/common-api/resources.js"
{
	export class ResourcesManager
	{
		constructor(amounts?: CommonResourceAmounts, population?: number);
		[key: string]: number;
		population: number;
		reset(): void;
		canAfford(amounts: CommonResourceAmounts | ResourcesManager): boolean;
		add(amounts: CommonResourceAmounts | ResourcesManager): void;
		subtract(amounts: CommonResourceAmounts | ResourcesManager): void;
		multiply(multiplier: number): void;
		Serialize(): { amounts: CommonResourceAmounts; population: number };
		Deserialize(data: { amounts: CommonResourceAmounts; population: number }): void;
	}
}

declare module "simulation/ai/common-api/map-module.js"
{
	export class InfoMap
	{
		constructor(sharedScript: CommonSharedScript | Record<string, any>, type: string, originalMap?: Uint8Array, actualCopy?: boolean);
		width: number;
		height: number;
		cellSize: number;
		length: number;
		maxVal: number;
		map: Uint8Array;
		pattern?: number[];
		setMaxVal(value: number): void;
		gamePosToMapPos(position: CommonPosition): CommonPosition;
		point(position: CommonPosition): number;
		runLoop(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, maxDistSquared: number, callback: (index: number, distanceSquared: number) => number): void;
		addInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
		multiplyInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
		add(map: CommonInfoMap): void;
		set(index: number, value: number): void;
		findBestTile(radius: number, obstruction: CommonInfoMap): { idx: number | undefined; val: number };
		getNonObstructedTile(index: number, radius: number, obstruction: CommonInfoMap): number;
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
		dumpIm(name?: string, threshold?: number): void;
	}
}

declare module "simulation/ai/common-api/gamestate.js"
{
	export class GameState
	{
		constructor();
		ai: unknown;
		sharedScript: CommonSharedScript;
		entities: CommonEntityCollection;
		EntCollecNames: Map<string, CommonEntityCollection>;
		timeElapsed: number;
		circularMap: boolean;
		templates: Record<string, Record<string, unknown> | null>;
		player: number;
		playerData: Record<string, any>;
		victoryConditions: Set<string>;
		alliedVictory: boolean;
		ceasefireActive: boolean;
		ceasefireTimeRemaining: number;
		phases: Array<{ name: string; requirements: CommonRequirement[] }>;
		init(sharedScript: CommonSharedScript, state: Record<string, any>, player: number): void;
		update(sharedScript: CommonSharedScript): void;
		updatingCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
		destroyCollection(id: string): void;
		updatingGlobalCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
		destroyGlobalCollection(id: string): void;
		resetOnDiplomacyChanged(): void;
		getTimeElapsed(): number;
		getBarterPrices(): number[];
		getVictoryConditions(): Set<string>;
		getAlliedVictory(): boolean;
		isCeasefireActive(): boolean;
		getTemplate(type: string): CommonTemplate | null;
		getBuiltTemplate(foundationName: string): CommonTemplate | null;
		applyCiv(templateName: string): string;
		getPlayerCiv(player?: number): string;
		currentPhase(): number;
		getNumberOfPhases(): number;
		getPhaseName(index: number): string | undefined;
		getPhaseEntityRequirements(index: number): Array<{ class: string; count: number }>;
		isResearched(template: string): boolean;
		isResearching(template: string): boolean;
		canResearch(templateName: string, noRequirementCheck?: boolean): boolean;
		checkTechRequirements(requirements: CommonRequirement[] | false): boolean;
		getPassabilityMap(): CommonPassabilityMap;
		getPassabilityClassMask(name: string): number;
		getResources(): CommonResourcesManager;
		getPopulation(): number;
		getPopulationLimit(): number;
		getPopulationMax(): number;
		getPlayerID(): number;
		hasAllies(): boolean;
		hasEnemies(): boolean;
		hasNeutrals(): boolean;
		isPlayerNeutral(id: number): boolean;
		isPlayerAlly(id: number): boolean;
		isPlayerMutualAlly(id: number): boolean;
		isPlayerEnemy(id: number): boolean;
		getNumPlayerEnemies(): number;
		getEnemies(): number[];
		getNeutrals(): number[];
		getAllies(): number[];
		getExclusiveAllies(): number[];
		getMutualAllies(): number[];
		isEntityAlly(entity: CommonEntity | undefined): boolean;
		isEntityExclusiveAlly(entity: CommonEntity | undefined): boolean;
		isEntityEnemy(entity: CommonEntity | undefined): boolean;
		isEntityOwn(entity: CommonEntity | undefined): boolean;
		getEntityById(id: number): CommonEntity | undefined;
		getEntities(id?: number): CommonEntityCollection;
		getStructures(): CommonEntityCollection;
		getOwnEntities(): CommonEntityCollection;
		getOwnStructures(): CommonEntityCollection;
		getOwnUnits(): CommonEntityCollection;
		getAllyEntities(): CommonEntityCollection;
		getExclusiveAllyEntities(): CommonEntityCollection;
		getAllyStructures(allyID?: number): CommonEntityCollection;
		getNeutralStructures(): CommonEntityCollection;
		getEnemyEntities(): CommonEntityCollection;
		getEnemyStructures(enemyID?: number): CommonEntityCollection;
		getEnemyUnits(enemyID?: number): CommonEntityCollection;
		getOwnEntitiesByMetadata(key: string, value: unknown, maintain?: boolean): CommonEntityCollection;
		getOwnEntitiesByRole(role: string, maintain?: boolean): CommonEntityCollection;
		getOwnEntitiesByType(type: string, maintain?: boolean): CommonEntityCollection;
		getOwnEntitiesByClass(cls: string, maintain?: boolean): CommonEntityCollection;
		getOwnFoundationsByClass(cls: string, maintain?: boolean): CommonEntityCollection;
		getOwnTrainingFacilities(): CommonEntityCollection;
		getOwnResearchFacilities(): CommonEntityCollection;
		countEntitiesByType(type: string, maintain?: boolean): number;
		countEntitiesAndQueuedByType(type: string, maintain?: boolean): number;
		countFoundationsByType(type: string, maintain?: boolean): number;
		countOwnEntitiesByRole(role: string): number;
		countOwnEntitiesAndQueuedWithRole(role: string): number;
		countOwnQueuedEntitiesWithMetadata(data: string, value: unknown): number;
		getOwnFoundations(): CommonEntityCollection;
		getOwnDropsites(resource?: string): CommonEntityCollection;
		getAnyDropsites(resource?: string): CommonEntityCollection;
		getResourceSupplies(resource: string): CommonEntityCollection;
		getHuntableSupplies(): CommonEntityCollection;
		getFishableSupplies(): CommonEntityCollection;
		findTrainableUnits(classes: string[], anticlasses?: string[]): Array<[string, CommonTemplate]>;
		findAvailableTech(): Array<[string, CommonTemplate]>;
		hasTrainer(template: string): boolean;
		findTrainers(template: string): CommonEntityCollection;
		findBuilder(template: string): CommonEntity | undefined;
		hasResearchers(templateName: string, noRequirementCheck?: boolean): boolean;
		findResearchers(templateName: string, noRequirementCheck?: boolean): CommonEntityCollection | undefined;
		getEntityLimits(): Record<string, number>;
		getEntityMatchCounts(): Record<string, number>;
		getEntityCounts(): Record<string, number>;
		isTemplateAvailable(templateName: string): boolean | undefined;
		isTemplateDisabled(templateName: string): boolean;
		isEntityLimitReached(category: string): boolean;
		getTraderTemplatesGains(): { landGainMultiplier?: number; navalGainMultiplier?: number };
	}
}

declare module "simulation/ai/common-api/filters.js"
{
	export function byType(type: string): CommonEntityFilter;
	export function byClass(cls: string): CommonEntityFilter;
	export function byClasses(clsList: string[] | string): CommonEntityFilter;
	export function byMetadata(player: number, key: string, value: unknown): CommonEntityFilter;
	export function byHasMetadata(player: number, key: string): CommonEntityFilter;
	export function and(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
	export function or(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
	export function not(filter: CommonEntityFilter): CommonEntityFilter;
	export function byOwner(owner: number): CommonEntityFilter;
	export function byNotOwner(owner: number): CommonEntityFilter;
	export function byOwners(owners: number[]): CommonEntityFilter;
	export function byCanGarrison(): CommonEntityFilter;
	export function byTrainingQueue(): CommonEntityFilter;
	export function byResearchAvailable(gameState: CommonGameState, civ: string): CommonEntityFilter;
	export function byCanAttackClass(aClass: string): CommonEntityFilter;
	export function byCanAttackTarget(target: CommonEntity): CommonEntityFilter;
	export function isGarrisoned(): CommonEntityFilter;
	export function isIdle(): CommonEntityFilter;
	export function isFoundation(): CommonEntityFilter;
	export function isBuilt(): CommonEntityFilter;
	export function hasDefensiveFire(): CommonEntityFilter;
	export function isDropsite(resourceType?: string): CommonEntityFilter;
	export function isTreasure(): CommonEntityFilter;
	export function byResource(resourceType: string): CommonEntityFilter;
	export function isHuntable(): CommonEntityFilter;
	export function isFishable(): CommonEntityFilter;
}

declare module "simulation/ai/common-api/entitycollection.js"
{
	export class EntityCollection
	{
		constructor(sharedAI: CommonSharedScript, entities?: Map<number, CommonEntity>, filters?: CommonEntityFilter[]);
		readonly length: number;
		frozen: boolean;
		Serialize(): { ents: number[]; frozen: boolean; filters: string[] };
		Deserialize(data: { ents: number[]; frozen: boolean; filters: string[] }, sharedAI: CommonSharedScript): void;
		freeze(): void;
		defreeze(): void;
		toIdArray(): number[];
		toEntityArray(): CommonEntity[];
		values(): IterableIterator<CommonEntity>;
		toString(): string;
		filter(filter: CommonEntityFilter | ((entity: CommonEntity, id: number, collection: this) => boolean), thisp?: unknown): EntityCollection;
		filterNearest(targetPos: CommonPosition, n?: number): EntityCollection;
		filter_raw(callback: (entity: unknown, id: number, collection: this) => boolean, thisp?: unknown): EntityCollection;
		forEach(callback: (entity: CommonEntity) => void): this;
		hasEntities(): boolean;
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
		attackMove(x: number, z: number, targetClasses: string[], allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
		moveIndiv(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		occupyTurret(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		destroy(): this;
		attack(unitId: number, queued?: boolean, pushFront?: boolean): this;
		setStance(stance: string): this;
		getCentrePosition(): CommonPosition | undefined;
		getApproximatePosition(sample: number): CommonPosition | undefined;
		hasEntId(id: number): boolean;
		removeEnt(entity: CommonEntity): boolean;
		addEnt(entity: CommonEntity): boolean;
		updateEnt(entity: CommonEntity, force?: boolean): boolean;
		registerUpdates(): void;
		unregister(): void;
		dynamicProperties(): string[];
		setUID(id: number): void;
		getUID(): number;
	}
}

declare module "simulation/ai/common-api/entity.js"
{
	export class Template
	{
		constructor(sharedAI: CommonSharedScript, templateName: string, template: Record<string, unknown>);
		get(path: string): any;
		templateName(): string;
		genericName(): string | undefined;
		civ(): string | undefined;
		matchLimit(): number | undefined;
		classes(): string[] | undefined;
		hasClass(name: string): boolean | undefined;
		hasClasses(classes: string[] | string | undefined): boolean | undefined;
		requirements(): unknown;
		available(gameState: CommonGameState): boolean;
		cost(productionQueue?: unknown): CommonResourceAmounts;
		costSum(productionQueue?: unknown): number;
		techCostMultiplier(type: string): number;
		obstructionRadius(): { max: number; min: number } | undefined;
		footprintRadius(): number | undefined;
		maxHitpoints(): number;
		isHealable(): boolean;
		isRepairable(): boolean;
		getPopulationBonus(): number;
		resistanceStrengths(): Record<string, unknown> | undefined;
		attackTypes(): string[] | undefined;
		attackRange(type: string): { max: number; min: number } | undefined;
		attackStrengths(type: string): Record<string, number> | undefined;
		captureStrength(): number | undefined;
		attackTimes(type: string): { prepare: number; repeat: number } | undefined;
		getCounteredClasses(): Array<[string[], number]> | undefined;
		counters(target: CommonTemplate): boolean;
		getMultiplierAgainst(type: string, againstClass: string): number | undefined;
		buildableEntities(civ: string): string[];
		trainableEntities(civ: string): string[] | undefined;
		researchableTechs(gameState: CommonGameState, civ: string): string[] | undefined;
		resourceSupplyType(): CommonResourceSupplyType | undefined;
		getResourceType(): string | undefined;
		getDiminishingReturns(): number;
		resourceSupplyMax(): number;
		maxGatherers(): number;
		resourceGatherRates(): Record<string, number> | undefined;
		resourceDropsiteTypes(): string[] | undefined;
		isResourceDropsite(resourceType?: string): boolean | undefined;
		isTreasure(): boolean;
		treasureResources(): Record<string, number> | undefined;
		garrisonableClasses(): string | undefined;
		garrisonMax(): number;
		garrisonSize(): number;
		garrisonEjectHealth(): number;
		getDefaultArrow(): number;
		getArrowMultiplier(): number;
		getGarrisonArrowClasses(): string[] | undefined;
		buffHeal(): number;
		promotion(): string | undefined;
		isPackable(): boolean;
		isHuntable(): boolean | undefined;
		walkSpeed(): number;
		trainingCategory(): string | undefined;
		buildTime(researcher?: CommonTemplate): number;
		buildCategory(): string | undefined;
		buildDistance(): Record<string, unknown> | undefined;
		buildPlacementType(): string | undefined;
		buildTerritories(): string[] | undefined;
		hasBuildTerritory(territory: string): boolean | undefined;
		hasTerritoryInfluence(): boolean;
		hasDefensiveFire(): boolean;
		territoryInfluenceRadius(): number;
		territoryInfluenceWeight(): number;
		territoryDecayRate(): number;
		defaultRegenRate(): number;
		garrisonRegenRate(): number;
		visionRange(): number;
		gainMultiplier(): number;
		isBuilder(): boolean;
		isGatherer(): boolean;
		canGather(type: string): boolean;
		isGarrisonHolder(): boolean;
		isTurretHolder(): boolean;
		canCapture(target?: CommonTemplate): boolean;
		isCapturable(): boolean;
		canGuard(): boolean;
		canGarrison(): boolean;
		canOccupyTurret(): boolean;
		isTreasureCollector(): boolean;
		hasUnitAI(): boolean;
	}
	export class Entity extends Template
	{
		constructor(sharedAI: CommonSharedScript, entity: Record<string, any>);
		queryInterface(iid: string | number): any;
		toString(): string;
		id(): number;
		getMetadata(player: number, key: string): unknown;
		setMetadata(player: number, key: string, value: unknown): void;
		deleteAllMetadata(player: number): void;
		deleteMetadata(player: number, key: string): void;
		position(): CommonPosition | undefined;
		angle(): number | undefined;
		isIdle(): boolean | undefined;
		getStance(): string | undefined;
		unitAIState(): string | undefined;
		unitAIOrderData(): Array<Record<string, unknown>>;
		hitpoints(): number;
		isHurt(): boolean;
		healthLevel(): number;
		needsHeal(): boolean;
		needsRepair(): boolean;
		decaying(): boolean | undefined;
		capturePoints(): number[] | undefined;
		isInvulnerable(): boolean;
		isSharedDropsite(): boolean;
		trainingQueue(): CommonTrainingQueueItem[] | undefined;
		trainingQueueTime(): number | undefined;
		foundationProgress(): number | undefined;
		getBuilders(): number[] | undefined;
		getBuildersNb(): number | undefined;
		owner(): number;
		isOwn(player: number): boolean;
		resourceSupplyAmount(): number | undefined;
		resourceSupplyNumGatherers(): number | undefined;
		isFull(): boolean | undefined;
		resourceCarrying(): Array<{ type: string; amount: number }> | undefined;
		currentGatherRate(): number | undefined;
		garrisonHolderID(): number | undefined;
		garrisoned(): number[] | undefined;
		garrisonedSlots(): number;
		canGarrisonInside(): boolean;
		canAttackClass(aClass: string): boolean;
		canAttackTarget(target: CommonEntity, allowCapture?: boolean): boolean;
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
		attackMove(x: number, z: number, targetClasses: string[], allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
		setStance(stance: string): this | undefined;
		stopMoving(): void;
		unload(id: number): this | undefined;
		unloadAll(): this | undefined;
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		["occupy-turret"](target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		attack(unitId: number, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
		collectTreasure(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		moveApart(point: CommonPosition, distance: number): this;
		flee(unitToFleeFrom: CommonEntity): this;
		gather(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		repair(target: CommonEntity, autocontinue?: boolean, queued?: boolean, pushFront?: boolean): this;
		returnResources(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		destroy(): this;
		barter(buyType: string, sellType: string, amount: number): this;
		tradeRoute(target: CommonEntity, source: CommonEntity): this;
		setRallyPoint(target: CommonEntity, command: Record<string, unknown>): this;
		unsetRallyPoint(): this;
		train(civ: string, type: string, count: number, metadata?: Record<string, unknown>, pushFront?: boolean): this;
		construct(template: string, x: number, z: number, angle: number, metadata?: Record<string, unknown>): this;
		research(template: string, pushFront?: boolean): this;
		stopProduction(id: number): this;
		stopAllProduction(percentToStopAt: number): this | true;
		guard(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		removeGuard(): this;
	}
}

declare module "simulation/ai/common-api/baseAI.js"
{
	export class BaseAI
	{
		constructor(settings?: Record<string, any>);
		player: number;
		territoryMap: CommonInfoMap;
		accessibility: CommonInfoMap;
		gameState: CommonGameState;
		timeElapsed: number;
		Serialize(): Record<string, unknown>;
		Deserialize(data: Record<string, unknown>, sharedScript: CommonSharedScript): void;
		Init(playerID: number, sharedAI: CommonSharedScript): void;
		CustomInit(gameState: CommonGameState): void;
		HandleMessage(state: Record<string, any>, playerID: number, sharedAI: CommonSharedScript): void;
		OnUpdate(sharedAI: CommonSharedScript): void;
		chat(message: string): void;
	}
}