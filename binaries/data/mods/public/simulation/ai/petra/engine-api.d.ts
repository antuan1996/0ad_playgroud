/**
 * Engine and common AI API declarations used by Petra.
 * Keep this file aligned with common-api and Petra's Engine.PostCommand calls.
 */

type Vec2 = [number, number];
type ResourceAmounts = Record<string, number>;
type PlayerId = number;
type EntityId = number;

interface EnginePathPoint
{
	x: number;
	y: number;
}

interface EngineCommandChat
{
	type: "aichat";
	message: string;
	translateMessage?: boolean;
	translateParameters?: string[] | Record<string, string | null>;
	parameters?: Record<string, string | number>;
}

interface EngineCommandSetShadingColor
{
	type: "set-shading-color";
	entities: EntityId[];
	rgb: [number, number, number];
}

interface EngineCommandSetTradingGoods
{
	type: "set-trading-goods";
	tradingGoods: ResourceAmounts;
}

interface EngineCommandTribute
{
	type: "tribute";
	player: PlayerId;
	amounts: ResourceAmounts;
}

interface EngineCommandTributeRequest
{
	type: "tribute-request";
	source: PlayerId;
	player: PlayerId;
	resourceWanted: number;
	resourceType: string;
}

interface EngineCommandDiplomacy
{
	type: "diplomacy" | "diplomacy-request";
	player: PlayerId;
	source?: PlayerId;
	to: string;
}

interface EngineCommandAttackRequest
{
	type: "attack-request";
	source: PlayerId;
	player: PlayerId;
}

interface EngineCommandDropSiteSharing
{
	type: "set-dropsite-sharing";
	entities: EntityId[];
	shared: boolean;
}

/** Union of engine commands explicitly issued by Petra. */
type PetraEngineCommand = EngineCommandChat | EngineCommandSetShadingColor |
	EngineCommandSetTradingGoods | EngineCommandTribute | EngineCommandTributeRequest | EngineCommandDiplomacy |
	EngineCommandAttackRequest | EngineCommandDropSiteSharing;

/** Scripting-engine facilities used directly by Petra. */
declare const Engine: {
	/** Submit a player command to the simulation. */
	PostCommand(player: PlayerId, command: PetraEngineCommand): void;
	/** Start a named profiling scope. */
	ProfileStart(name: string): void;
	/** Finish the current profiling scope. */
	ProfileStop(): void;
	/** Compute a path between world-space points using a passability mask. */
	ComputePath(start: { x: number; y: number }, end: { x: number; y: number },
		passabilityMask: number): EnginePathPoint[];
	/** Write a numeric map to an image for debugging. */
	DumpImage(name: string, data: ArrayLike<number>, width: number, height: number, threshold: number): void;
};

/** Current player id; set by the shared AI runtime before calling an AI. */
declare var PlayerID: PlayerId;

/** Resource catalogue exposed by the simulation scripting runtime. */
declare const Resources: {
	/** Return all resource codes. */
	GetCodes(): string[];
	/** Return resource codes usable for trade. */
	GetTradableCodes(): string[];
	/** Return resource codes usable for barter. */
	GetBarterableCodes(): string[];
	/** Return resource codes usable for tribute. */
	GetTributableCodes(): string[];
	/** Return localized names indexed by resource code. */
	GetNames(): string[];
	/** Look up metadata for one resource. */
	GetResource(code: string): { aiAnalysisInfluenceGroup?: string; [key: string]: unknown } | undefined;
};

/** Simulation entity-component identifiers used when modifying AI bonuses. */
declare const Sim: {
	SYSTEM_ENTITY: EntityId;
	IID_ModifiersManager: string | number;
};

/** Low-level component interface used to apply the difficulty bonus. */
declare const SimEngine: {
	QueryInterface(entity: EntityId, interfaceId: string | number): {
		/** Apply named modifications to simulation templates. */
		AddModifiers(name: string, modifiers: Record<string, unknown>,
			affectedPlayers?: PlayerId[]): void;
	};
};

/** Return a random floating-point value in the requested range. */
declare function randFloat(min: number, max: number): number;
/** Return a random boolean, optionally with the given true probability. */
declare function randBool(probability?: number): boolean;
/** Select a random array item. */
declare function pickRandom<T>(items: readonly T[]): T;
/** Mark a string for translation by the game. */
declare function markForTranslation(message: string): string;
/** Clone serializable game data. */
declare function clone<T>(value: T): T;
/** Format a value using the engine's JavaScript representation. */
declare function uneval(value: unknown): string;
/** Write a message to the engine log. */
declare function warn(message: string): void;
/** Report a scripting error and stop the current operation. */
declare function error(message: string): never;

/** Petra uses this engine-provided helper to square world-space distances. */
interface Math
{
	/** Return the square of a number. */
	square(value: number): number;
}

declare module "simulation/ai/common-api/entitycollection.js"
{
	import { Entity } from "simulation/ai/common-api/entity.js";

	/** Live or snapshot collection of entities with optional update filters. */
	export class EntityCollection
	{
		/** Number of entities in the collection. */
		readonly length: number;
		constructor(sharedAI: object, entities?: Map<EntityId, Entity>, filters?: object[]);
		/** Iterate through member entities. */
		values(): IterableIterator<Entity>;
		/** Return a string representation of this collection. */
		toString(): string;
		/** Convert members to an array of entity ids. */
		toIdArray(): EntityId[];
		/** Convert members to an array of entities. */
		toEntityArray(): Entity[];
		/** Filter members and return a new collection. */
		filter(predicate: ((entity: Entity, id: EntityId, collection: EntityCollection) => boolean) | object,
			thisArg?: object): EntityCollection;
		/** Filter using the underlying raw entity data. */
		filter_raw(predicate: (entity: object, id: EntityId, collection: EntityCollection) => boolean,
			thisArg?: object): EntityCollection;
		/** Return up to n members nearest a world-space position. */
		filterNearest(position: Vec2, n?: number): EntityCollection;
		/** Call a function for each member. */
		forEach(callback: (entity: Entity) => void): this;
		/** Test whether the collection has members. */
		hasEntities(): boolean;
		/** Find whether an entity id is present. */
		hasEntId(id: EntityId): boolean;
		/** Add an entity to the collection. */
		addEnt(entity: Entity): boolean;
		/** Remove an entity from the collection. */
		removeEnt(entity: Entity): boolean;
		/** Register this collection for incremental simulation updates. */
		registerUpdates(): void;
		/** Stop incremental updates for this collection. */
		unregister(): void;
		/** Freeze automatic additions while retaining removals. */
		freeze(): void;
		/** Resume normal incremental updates. */
		defreeze(): void;
		/** Issue a move command to every member. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
		/** Move every member to a range around a point. */
		moveToRange(x: number, z: number, min: number, max: number,
			queued?: boolean, pushFront?: boolean): this;
		/** Issue attack-move orders to every member. */
		attackMove(x: number, z: number, targetClasses: object, allowCapture?: boolean,
			queued?: boolean, pushFront?: boolean): this;
		/** Move members individually to a point. */
		moveIndiv(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
		/** Order all members to garrison in an entity. */
		garrison(target: Entity, queued?: boolean, pushFront?: boolean): this;
		/** Order all members to occupy an entity's turret. */
		occupyTurret(target: Entity, queued?: boolean, pushFront?: boolean): this;
		/** Delete all member entities. */
		destroy(): this;
		/** Order all members to attack an entity id. */
		attack(target: EntityId, queued?: boolean, pushFront?: boolean): this;
		/** Set the stance of all members. */
		setStance(stance: string): this;
		/** Get the average world-space position, if any members are positioned. */
		getCentrePosition(): Vec2 | undefined;
		/** Get an approximate average position from at most n members. */
		getApproximatePosition(sample: number): Vec2 | undefined;
		/** Store this collection in AI serialization data. */
		Serialize(): object;
		/** Restore this collection from AI serialization data. */
		Deserialize(data: object, sharedAI: object): void;
		/** Get the entity ids whose values changed since the last update. */
		dynamicProperties(): EntityId[];
		/** Assign or retrieve a stable collection id. */
		setUID(id: string): void;
		/** Return this collection's stable id. */
		getUID(): string;
	}
}

declare module "simulation/ai/common-api/entity.js"
{
	import { GameState } from "simulation/ai/common-api/gamestate.js";

	/** Template data and helper methods for an entity or technology template. */
	export class Template
	{
		constructor(sharedAI: object, templateName: string, template: object);
		/** Read a template value using a slash-separated component path. */
		get(path: string): any;
		/** Return the engine template name. */
		templateName(): string;
		/** Return the localized generic name. */
		genericName(): string;
		/** Return the civilization code. */
		civ(): string;
		/** Return the training match limit, if any. */
		matchLimit(): number | undefined;
		/** Return identity classes. */
		classes(): string[] | undefined;
		/** Test for one identity class. */
		hasClass(name: string): boolean;
		/** Test a positive/negative class expression. */
		hasClasses(classes: string[]): boolean;
		/** Return template requirements. */
		requirements(): object | undefined;
		/** Test whether requirements are met. */
		available(gameState: GameState): boolean;
		/** Return resource costs, optionally adjusted for a production facility. */
		cost(productionQueue?: Entity): ResourceAmounts;
		/** Sum resource costs. */
		costSum(productionQueue?: Entity): number;
		/** Return a technology cost multiplier. */
		techCostMultiplier(resource: string): number;
		/** Return inner and outer obstruction radii. */
		obstructionRadius(): { max: number; min: number } | undefined;
		/** Return the outer footprint radius. */
		footprintRadius(): number | undefined;
		/** Test whether the entity can be healed. */
		isHealable(): boolean;
		/** Test whether the entity can be repaired. */
		isRepairable(): boolean;
		/** Return population provided by the template. */
		getPopulationBonus(): number;
		/** Return damage resistance data. */
		resistanceStrengths(): object | undefined;
		/** Return the template's attack types. */
		attackTypes(): string[] | undefined;
		/** Return the min/max range for an attack type. */
		attackRange(type: string): { max: number; min: number } | undefined;
		/** Return damage values for an attack type. */
		attackStrengths(type: string): ResourceAmounts | undefined;
		/** Return capture attack strength, if present. */
		captureStrength(): number | undefined;
		/** Return attack prepare and repeat times. */
		attackTimes(type: string): { prepare: number; repeat: number } | undefined;
		/** Return classes countered by the template. */
		getCounteredClasses(): [string[], number][] | undefined;
		/** Test whether this template counters a target. */
		counters(target: Template): boolean;
		/** Get attack multiplier against a class. */
		getMultiplierAgainst(type: string, againstClass: string): number | undefined;
		/** List structures this entity can build. */
		buildableEntities(civ: string): string[];
		/** List units this entity can train. */
		trainableEntities(civ: string): string[] | undefined;
		/** List technologies this entity can research. */
		researchableTechs(gameState: GameState, civ: string): string[] | undefined;
		/** Return the resource-supply category and subtype. */
		resourceSupplyType(): { generic: string; specific: string } | undefined;
		/** Return the generic resource category. */
		getResourceType(): string | undefined;
		/** Return resource gathering rates by resource subtype. */
		resourceGatherRates(): ResourceAmounts | undefined;
		/** Return resource supply diminishing-returns multiplier. */
		getDiminishingReturns(): number;
		/** Return the maximum amount in a resource supply. */
		resourceSupplyMax(): number;
		/** Return the maximum number of gatherers for a supply. */
		maxGatherers(): number;
		/** Return resource amounts carried by a treasure. */
		treasureResources(): ResourceAmounts | undefined;
		/** Return supported dropsite resource types. */
		resourceDropsiteTypes(): string[] | undefined;
		/** Test whether this is a dropsite for a resource. */
		isResourceDropsite(resourceType?: string): boolean;
		/** Test whether the entity can be hunted. */
		isHuntable(): boolean;
		/** Test whether this entity is a treasure object. */
		isTreasure(): boolean;
		/** Return this trader template's trade gain multiplier. */
		gainMultiplier(): number;
		/** Return classes accepted by this garrison holder. */
		garrisonableClasses(): string | undefined;
		/** Return the entity's garrison capacity and unit size. */
		garrisonMax(): number;
		/** Return the garrison size occupied by this unit. */
		garrisonSize(): number;
		/** Return the health fraction at which occupants are ejected. */
		garrisonEjectHealth(): number;
		/** Return default arrows and garrison arrow modifiers/classes. */
		getDefaultArrow(): number;
		/** Return the garrison arrow multiplier. */
		getArrowMultiplier(): number;
		/** Return classes that receive garrison arrows. */
		getGarrisonArrowClasses(): string[] | undefined;
		/** Return the amount of healing granted while garrisoned. */
		buffHeal(): number;
		/** Return the promotion template, if any. */
		promotion(): string | undefined;
		/** Return movement and production categories. */
		walkSpeed(): number;
		/** Return the training category. */
		trainingCategory(): string | undefined;
		/** Return the building category. */
		buildCategory(): string | undefined;
		/** Return the placement type used for construction. */
		buildPlacementType(): string | undefined;
		/** Return build time, adjusted for a researcher where applicable. */
		buildTime(researcher?: Template): number;
		/** Return build-distance constraints. */
		buildDistance(): object | undefined;
		/** Return allowed build territories. */
		buildTerritories(): string[] | undefined;
		/** Test whether a territory is allowed for construction. */
		hasBuildTerritory(territory: string): boolean;
		/** Test whether this template influences territory. */
		hasTerritoryInfluence(): boolean;
		/** Test whether the template has defensive fire. */
		hasDefensiveFire(): boolean;
		/** Test whether this entity has a builder or gatherer component. */
		isBuilder(): boolean;
		/** Test whether this entity gathers resources. */
		isGatherer(): boolean;
		/** Test whether this entity has garrison or turret capacity. */
		isGarrisonHolder(): boolean;
		/** Test whether this entity can hold a turret occupant. */
		isTurretHolder(): boolean;
		/** Test whether this entity can be captured or guarded. */
		isCapturable(): boolean;
		/** Test whether this entity can guard another entity. */
		canGuard(): boolean;
		/** Test whether this entity can garrison inside another entity. */
		canGarrison(): boolean;
		/** Test whether this entity can occupy a turret. */
		canOccupyTurret(): boolean;
		/** Test whether this entity can collect treasure or has UnitAI. */
		isTreasureCollector(): boolean;
		/** Test whether this template has a UnitAI component. */
		hasUnitAI(): boolean;
		/** Return territory influence radius and weight. */
		territoryInfluenceRadius(): number;
		/** Return the territory influence weight. */
		territoryInfluenceWeight(): number;
		/** Return territory decay rate. */
		territoryDecayRate(): number;
		/** Return base and garrison regeneration rates. */
		defaultRegenRate(): number;
		/** Return the regeneration rate while garrisoned. */
		garrisonRegenRate(): number;
		/** Test whether the template gathers a resource type. */
		canGather(type: string): boolean;
		/** Test whether the template can capture a target. */
		canCapture(target?: Template): boolean;
	}

	/** Simulation entity wrapper used by Petra to inspect and command entities. */
	export class Entity extends Template
	{
		constructor(sharedAI: object, entity: object);
		/** Raw entity data used by a few Petra event handlers. */
		_entity: { trainingQueue?: Array<Record<string, any>>; [key: string]: any };
		/** Query an engine component interface on this entity. */
		queryInterface(interfaceId: string | number): object | null;
		/** Return a display representation identifying this entity. */
		toString(): string;
		/** Return the simulation entity id. */
		id(): EntityId;
		/** Read Petra-specific metadata attached to this entity. */
		getMetadata<T = any>(player: PlayerId, key: string): T | undefined;
		/** Set Petra-specific metadata attached to this entity. */
		setMetadata(player: PlayerId, key: string, value: unknown): void;
		/** Delete one metadata field. */
		deleteMetadata(player: PlayerId, key: string): void;
		/** Delete all metadata for one player. */
		deleteAllMetadata(player: PlayerId): void;
		/** Return current world position, or undefined when not positioned. */
		position(): Vec2 | undefined;
		/** Return current entity orientation. */
		angle(): number | undefined;
		/** Test whether the unit is idle. */
		isIdle(): boolean;
		/** Return current unit stance. */
		getStance(): string;
		/** Return the engine UnitAI state. */
		unitAIState(): string | undefined;
		/** Return the current UnitAI order list. */
		unitAIOrderData(): Array<Record<string, any>>;
		/** Return current and maximum health values. */
		hitpoints(): number;
		/** Return maximum hitpoints. */
		maxHitpoints(): number;
		/** Return current hitpoints as a fraction of maximum. */
		healthLevel(): number;
		/** Test whether the entity is below maximum health. */
		isHurt(): boolean;
		/** Test whether the entity can and should be healed. */
		needsHeal(): boolean;
		/** Test whether the entity can and should be repaired. */
		needsRepair(): boolean;
		/** Return whether the entity is decaying or invulnerable. */
		decaying(): boolean;
		/** Test whether the entity is invulnerable. */
		isInvulnerable(): boolean;
		/** Return the entity's current capture points. */
		capturePoints(): number[];
		/** Return the current owner player id. */
		owner(): PlayerId;
		/** Test whether the entity belongs to a player. */
		isOwn(player: PlayerId): boolean;
		/** Return current training queue entries. */
		trainingQueue(): Array<Record<string, any>> | undefined;
		/** Return the remaining training time in seconds. */
		trainingQueueTime(): number | undefined;
		/** Return foundation completion progress. */
		foundationProgress(): number | undefined;
		/** Return ids of units building this foundation. */
		getBuilders(): EntityId[] | undefined;
		/** Return the number of builders assigned to this foundation. */
		getBuildersNb(): number | undefined;
		/** Return resource supply amount and gatherer count. */
		resourceSupplyAmount(): number | undefined;
		/** Return the number of units gathering from this supply. */
		resourceSupplyNumGatherers(): number | undefined;
		/** Test whether the supply has reached its gatherer limit. */
		isFull(): boolean | undefined;
		/** Return resources carried by a unit. */
		resourceCarrying(): Array<Record<string, any>> | undefined;
		/** Return the current gather rate, if gathering. */
		currentGatherRate(): number | undefined;
		/** Return garrisoned entity ids and capacity information. */
		garrisonHolderID(): EntityId | undefined;
		/** Return ids of units currently inside this holder. */
		garrisoned(): EntityId[];
		/** Return the sum of garrison capacity currently occupied. */
		garrisonedSlots(): number;
		/** Test whether another unit can fit inside this holder. */
		canGarrisonInside(): boolean;
		/** Test whether the entity can attack a class or target. */
		canAttackClass(className: string): boolean;
		/** Test whether the entity can attack a specific target. */
		canAttackTarget(target: Entity, allowCapture?: boolean): boolean;
		/** Issue movement, combat, and gathering commands. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): void;
		/** Move the entity until it is within a distance range from a point. */
		moveToRange(x: number, z: number, min: number, max: number,
			queued?: boolean, pushFront?: boolean): void;
		/** Move toward a point while engaging valid targets. */
		attackMove(x: number, z: number, targetClasses: object, allowCapture?: boolean,
			queued?: boolean, pushFront?: boolean): void;
		/** Attack a target entity. */
		attack(target: EntityId, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): void;
		/** Gather from a resource supply. */
		gather(target: EntityId, queued?: boolean, pushFront?: boolean): void;
		/** Repair a target entity or foundation. */
		repair(target: EntityId, autocontinue?: boolean, queued?: boolean, pushFront?: boolean): void;
		/** Return carried resources to a dropsite. */
		returnResources(target: EntityId, queued?: boolean, pushFront?: boolean): void;
		/** Collect treasure from a target. */
		collectTreasure(target: EntityId, queued?: boolean, pushFront?: boolean): void;
		/** Move away from a threatening entity. */
		flee(target: EntityId): void;
		/** Move away from a nearby entity or position. */
		moveApart(position: Vec2, distance: number): void;
		/** Cancel the entity's current movement order. */
		stopMoving(): void;
		/** Set this entity's stance. */
		setStance(stance: string): void;
		/** Manage garrison and rally-point orders. */
		garrison(target: Entity, queued?: boolean, pushFront?: boolean): void;
		/** Unload a specified unit from this holder. */
		unload(entity: EntityId): void;
		/** Unload all units from this holder. */
		unloadAll(): void;
		/** Set a production facility's rally point and command. */
		setRallyPoint(target: Entity, command: string): void;
		/** Clear a production facility's rally point. */
		unsetRallyPoint(): void;
		/** Start training, construction, or research. */
		train(civ: string, type: string, count: number, metadata: object, pushFront?: boolean): void;
		/** Start a building foundation at world coordinates. */
		construct(template: string, x: number, z: number, angle: number, metadata: object): void;
		/** Start researching a technology. */
		research(template: string, pushFront?: boolean): void;
		/** Stop a queued production item. */
		stopProduction(id: number): void;
		/** Stop production after a given progress threshold. */
		stopAllProduction(percentToStopAt?: number): void;
		/** Issue or cancel a guard order. */
		guard(target: EntityId, queued?: boolean, pushFront?: boolean): void;
		/** Cancel a guard order. */
		removeGuard(): void;
		/** Set barter or trade route orders. */
		barter(buyType: string, sellType: string, amount: number): void;
		/** Set a trade route between two markets. */
		tradeRoute(target: EntityId, source: EntityId): void;
		/** Return vision range and packing state. */
		visionRange(): number | undefined;
		/** Test whether the entity can pack and unpack. */
		isPackable(): boolean;
		/** Test whether this dropsite is shared with allies. */
		isSharedDropsite(): boolean;
		/** Remove this entity from the simulation. */
		destroy(): void;
	}
}

declare module "simulation/ai/common-api/map-module.js"
{
	/** Compact byte map used for passability, territory, resource, and influence data. */
	export class InfoMap
	{
		/** Number of map cells along the x axis. */
		width: number;
		/** Number of map cells along the z axis. */
		height: number;
		/** World-space size of each map cell. */
		cellSize: number;
		/** Total number of map cells. */
		length: number;
		/** Maximum value retained by set(). */
		maxVal: number;
		/** Backing cell data. */
		map: Uint8Array;
		constructor(sharedScript: object, type: string, originalMap?: Uint8Array, actualCopy?: boolean);
		/** Set the value ceiling used when writing cells. */
		setMaxVal(value: number): void;
		/** Convert a world-space x/z point to integer map coordinates. */
		gamePosToMapPos(position: Vec2): Vec2;
		/** Read the value at a world-space point. */
		point(position: Vec2): number;
		/** Add a radial influence to cells around a map-space center. */
		addInfluence(x: number, y: number, radius: number, strength?: number, type?: string): void;
		/** Multiply existing values by a radial influence. */
		multiplyInfluence(x: number, y: number, radius: number, strength?: number, type?: string): void;
		/** Visit map cells in a rectangle, skipping cells outside a circular radius. */
		runLoop(x0: number, x1: number, y0: number, y1: number, centerX: number, centerY: number,
			maxDistanceSquared: number, callback: (index: number, distanceSquared: number) => number): void;
		/** Add another map cell by cell. */
		add(map: InfoMap): void;
		/** Write a clamped value to a map index. */
		set(index: number, value: number): void;
		/** Find the highest-valued tile with a valid unobstructed placement. */
		findBestTile(radius: number, obstruction: InfoMap): { idx: number | undefined; val: number };
		/** Find an unobstructed fine-grid tile within a map cell. */
		getNonObstructedTile(index: number, radius: number, obstruction: InfoMap): number;
		/** Return an obstruction position, or null when the area is clear. */
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
		/** Dump this map to an image for debugging. */
		dumpIm(name?: string, threshold?: number): void;
	}
}

declare module "simulation/ai/common-api/terrain-analysis.js"
{
	import { InfoMap } from "simulation/ai/common-api/map-module.js";

	/** World passability classes represented as a compact map. */
	export class TerrainAnalysis extends InfoMap
	{
		constructor(sharedScript: object, rawState: object);
	}

	/** Connected land and water regions used for movement accessibility checks. */
	export class Accessibility extends InfoMap
	{
		landPassMap: Uint16Array;
		navalPassMap: Uint16Array;
		regionSize: number[];
		regionType: string[];
		regionLinks: number[][];
		constructor(rawState: object, terrainAnalyser: TerrainAnalysis);
		/** Return the land or water region containing a world-space position. */
		getAccessValue(position: Vec2, onWater?: boolean): number;
		/** Return region links connecting two region ids, if a route exists. */
		getTrajectToIndex(start: number, end: number): number[] | undefined;
		/** Return the connected-region route between two world positions, if any. */
		getTrajectTo(start: Vec2, end: Vec2): number[] | false | undefined;
		/** Return the size of the region containing a world-space position. */
		getRegionSize(position: Vec2, onWater?: boolean): number;
		/** Return the larger applicable region size at a map index. */
		getRegionSizei(index: number, onWater?: boolean): number;
		/** Label a connected land or water region starting at a map cell. */
		floodFill(startIndex: number, regionId: number, onWater: boolean): boolean;
	}
}

declare module "simulation/ai/common-api/gamestate.js"
{
	import { Entity } from "simulation/ai/common-api/entity.js";
	import { EntityCollection } from "simulation/ai/common-api/entitycollection.js";
	import { ResourcesManager } from "simulation/ai/common-api/resources.js";
	import { Technology } from "simulation/ai/common-api/technology.js";
	import { Template } from "simulation/ai/common-api/entity.js";

	/** Player-specific view of shared simulation state exposed to AI scripts. */
	export class GameState
	{
		/** Petra instance associated with this player. */
		ai: any;
		/** Shared simulation snapshot and event source. */
		sharedScript: any;
		/** Player id represented by this view. */
		player: PlayerId;
		/** Player-specific data supplied by the shared AI runtime. */
		playerData: any;
		/** Get the current simulation time in milliseconds. */
		getTimeElapsed(): number;
		/** Get this player's current barter prices. */
		getBarterPrices(): ResourceAmounts;
		/** Get active victory-condition identifiers. */
		getVictoryConditions(): Set<string>;
		/** Test whether allied victory is enabled. */
		getAlliedVictory(): boolean;
		/** Test whether ceasefire is active. */
		isCeasefireActive(): boolean;
		/** Resolve a unit, building, or technology template. */
		getTemplate(name: string): Template | Technology | null;
		/** Resolve the built template for a foundation template name. */
		getBuiltTemplate(foundationName: string): Template | null;
		/** Substitute this player's civilization code into a template path. */
		applyCiv(path: string): string;
		/** Get this or another player's civilization code. */
		getPlayerCiv(player?: PlayerId): string;
		/** Get the current phase index. */
		currentPhase(): number;
		/** Get the number of phases in this civilization's progression. */
		getNumberOfPhases(): number;
		/** Get the technology name for a phase index. */
		getPhaseName(phase: number): string | undefined;
		/** Get required entity classes and counts for a phase. */
		getPhaseEntityRequirements(phase: number): Array<{ class: string; count: number }>;
		/** Test whether a technology has been researched. */
		isResearched(technology: string): boolean;
		/** Test whether a technology is currently being researched. */
		isResearching(technology: string): boolean;
		/** Test whether a technology can be researched. */
		canResearch(technology: string, noRequirementCheck?: boolean): boolean;
		/** Test a set of technology prerequisites against current state. */
		checkTechRequirements(requirements: object): boolean;
		/** Get the map's passability grid. */
		getPassabilityMap(): { width: number; cellSize: number; [key: string]: any };
		/** Get the passability mask for a named movement class. */
		getPassabilityClassMask(name: string): number;
		/** Get this player's current resource balance. */
		getResources(): ResourcesManager;
		/** Get current population. */
		getPopulation(): number;
		/** Get current population limit. */
		getPopulationLimit(): number;
		/** Get maximum population supported by the map/settings. */
		getPopulationMax(): number;
		/** Get this player's id. */
		getPlayerID(): PlayerId;
		/** Test whether this player has living allies. */
		hasAllies(): boolean;
		/** Test whether this player has living enemies. */
		hasEnemies(): boolean;
		/** Test whether this player has living neutral players. */
		hasNeutrals(): boolean;
		/** Test a player's neutral status. */
		isPlayerNeutral(player: PlayerId): boolean;
		/** Test a player's ally status. */
		isPlayerAlly(player: PlayerId): boolean;
		/** Test whether the alliance is mutual. */
		isPlayerMutualAlly(player: PlayerId): boolean;
		/** Test a player's enemy status. */
		isPlayerEnemy(player: PlayerId): boolean;
		/** Count living enemy players, excluding Gaia. */
		getNumPlayerEnemies(): number;
		/** Get ids of enemy players. */
		getEnemies(): PlayerId[];
		/** Get ids of neutral players. */
		getNeutrals(): PlayerId[];
		/** Get ids of allied players. */
		getAllies(): PlayerId[];
		/** Get ids of allied players other than this player. */
		getExclusiveAllies(): PlayerId[];
		/** Get ids of mutual allies. */
		getMutualAllies(): PlayerId[];
		/** Test an entity's diplomatic relationship to this player. */
		isEntityAlly(entity: Entity): boolean;
		/** Test whether an entity belongs to an ally other than this player. */
		isEntityExclusiveAlly(entity: Entity): boolean;
		/** Test whether an entity belongs to an enemy. */
		isEntityEnemy(entity: Entity): boolean;
		/** Test whether an entity belongs to this player. */
		isEntityOwn(entity: Entity): boolean;
		/** Resolve an entity id to its current entity wrapper. */
		getEntityById(id: EntityId): Entity | undefined;
		/** Get entities owned by a player, or all entities when omitted. */
		getEntities(player?: PlayerId): EntityCollection;
		/** Get all structures. */
		getStructures(): EntityCollection;
		/** Get all entities owned by this player. */
		getOwnEntities(): EntityCollection;
		/** Get owned structures. */
		getOwnStructures(): EntityCollection;
		/** Get owned units. */
		getOwnUnits(): EntityCollection;
		/** Get entities belonging to allies. */
		getAllyEntities(): EntityCollection;
		/** Get entities belonging to exclusive allies. */
		getExclusiveAllyEntities(): EntityCollection;
		/** Get structures belonging to one or all allies. */
		getAllyStructures(player?: PlayerId): EntityCollection;
		/** Get neutral structures. */
		getNeutralStructures(): EntityCollection;
		/** Get enemy entities. */
		getEnemyEntities(): EntityCollection;
		/** Get structures belonging to one or all enemies. */
		getEnemyStructures(player?: PlayerId): EntityCollection;
		/** Get units belonging to one or all enemies. */
		getEnemyUnits(player?: PlayerId): EntityCollection;
		/** Get owned entities with a metadata value. */
		getOwnEntitiesByMetadata(key: string, value: unknown, maintain?: boolean): EntityCollection;
		/** Get owned entities assigned a Petra role. */
		getOwnEntitiesByRole(role: string | undefined, maintain?: boolean): EntityCollection;
		/** Get owned entities of a template type. */
		getOwnEntitiesByType(type: string, maintain?: boolean): EntityCollection;
		/** Get owned entities with a class. */
		getOwnEntitiesByClass(className: string, maintain?: boolean): EntityCollection;
		/** Get owned foundations with a class. */
		getOwnFoundationsByClass(className: string, maintain?: boolean): EntityCollection;
		/** Get owned training facilities. */
		getOwnTrainingFacilities(): EntityCollection;
		/** Get owned research facilities. */
		getOwnResearchFacilities(): EntityCollection;
		/** Count owned entities of a template type. */
		countEntitiesByType(type: string, maintain?: boolean): number;
		/** Count owned and queued entities of a template type. */
		countEntitiesAndQueuedByType(type: string, maintain?: boolean): number;
		/** Count foundations of a template type. */
		countFoundationsByType(type: string, maintain?: boolean): number;
		/** Count owned entities assigned a role. */
		countOwnEntitiesByRole(role: string): number;
		/** Count owned and queued entities assigned a role. */
		countOwnEntitiesAndQueuedWithRole(role: string): number;
		/** Count queued entities with a metadata value. */
		countOwnQueuedEntitiesWithMetadata(key: string, value: unknown): number;
		/** Get owned construction foundations. */
		getOwnFoundations(): EntityCollection;
		/** Get owned dropsites accepting a resource type. */
		getOwnDropsites(resource?: string): EntityCollection;
		/** Get owned and shared dropsites accepting a resource type. */
		getAnyDropsites(resource?: string): EntityCollection;
		/** Get resource supplies of a resource type. */
		getResourceSupplies(resource?: string): EntityCollection;
		/** Get supplies of huntable animals. */
		getHuntableSupplies(): EntityCollection;
		/** Get fish supplies. */
		getFishableSupplies(): EntityCollection;
		/** Find templates matching required and excluded classes. */
		findTrainableUnits(classes: string[], antiClasses?: string[]): string[];
		/** Get currently available technologies. */
		findAvailableTech(): Array<[string, Technology]>;
		/** Test whether any facility can train a template. */
		hasTrainer(template: string): boolean;
		/** Get facilities that can train a template. */
		findTrainers(template: string): EntityCollection;
		/** Find a unit capable of building a template. */
		findBuilder(template: string): Entity | undefined;
		/** Test whether any facility can research a technology. */
		hasResearchers(template: string, noRequirementCheck?: boolean): boolean;
		/** Get facilities capable of researching a technology. */
		findResearchers(template: string, noRequirementCheck?: boolean): EntityCollection;
		/** Get this player's entity limits by category. */
		getEntityLimits(): Record<string, number>;
		/** Get entity match-limit counts. */
		getEntityMatchCounts(): Record<string, number>;
		/** Get current entity counts by category/class. */
		getEntityCounts(): Record<string, number>;
		/** Test whether a unit or structure template is available. */
		isTemplateAvailable(template: string): boolean;
		/** Test whether a template is disabled. */
		isTemplateDisabled(template: string): boolean;
		/** Test whether an entity category limit has been reached. */
		isEntityLimitReached(category: string): boolean;
		/** Get estimated gains for available trader templates. */
		getTraderTemplatesGains(): Record<string, number>;
		/** Create or reuse a per-player incrementally updated collection. */
		updatingCollection(id: string, filter: object, parent?: EntityCollection): EntityCollection;
		/** Create or reuse an incrementally updated global collection. */
		updatingGlobalCollection(id: string, filter: object, parent?: EntityCollection): EntityCollection;
		/** Stop updating and discard a per-player collection. */
		destroyCollection(id: string): void;
		/** Stop updating and discard a global collection. */
		destroyGlobalCollection(id: string): void;
		/** Invalidate cached diplomacy-dependent collections. */
		resetOnDiplomacyChanged(): void;
	}
}

declare module "simulation/ai/common-api/resources.js"
{
	/** Resource amounts tracked by the common AI API. */
	export class ResourcesManager
	{
		/** Resource amounts are also available as named numeric properties. */
		[resource: string]: any;
		/** Create a resource balance, optionally initialized from resource amounts. */
		constructor(amounts?: ResourceAmounts, population?: number);
		/** Test whether the balance can pay a cost. */
		canAfford(cost: ResourcesManager | ResourceAmounts): boolean;
		/** Add another balance or resource map. */
		add(amounts: ResourcesManager | ResourceAmounts): void;
		/** Subtract another balance or resource map. */
		subtract(amounts: ResourcesManager | ResourceAmounts): void;
		/** Scale all resource amounts. */
		multiply(factor: number): void;
		/** Clear all resource amounts. */
		reset(): void;
		/** Return a serializable resource map. */
		Serialize(): { amounts: ResourceAmounts; population: number };
		/** Restore resource balances from serialized data. */
		Deserialize(data: { amounts: ResourceAmounts; population: number }): void;
	}
}

declare module "simulation/ai/common-api/technology.js"
{
	import { Template } from "simulation/ai/common-api/entity.js";

	/** Wrapper around a researchable technology template. */
	export class Technology
	{
		constructor(templateName: string);
		/** Return the generic or civilization-specific technology name. */
		name(civ?: string): string | undefined;
		/** Test whether this template only defines a technology pair. */
		pairDef(): boolean;
		/** Return technologies defined by this pair template. */
		getPairedTechs(): Technology[] | undefined;
		/** Return the name of the parent pair, if any. */
		pair(): string | undefined;
		/** Return the paired technology name. */
		pairedWith(): string | undefined;
		/** Return technology costs, adjusted for a research facility. */
		cost(researcher?: Template): ResourceAmounts | undefined;
		/** Sum the technology costs. */
		costSum(researcher?: Template): number;
		/** Return research time in seconds. */
		researchTime(): number;
		/** Return technology requirements for a civilization. */
		requirements(civ?: string): object;
		/** Return automatic research information, if present. */
		autoResearch(): object | undefined;
		/** Return technologies superseded by this one. */
		supersedes(): string[] | undefined;
		/** Return effects applied by this technology. */
		modifications(): object[] | undefined;
		/** Return classes affected by this technology. */
		affects(): string[] | undefined;
		/** Test whether this technology affects the supplied classes. */
		isAffected(classes: string[]): boolean | undefined;
	}
}

declare module "simulation/ai/common-api/baseAI.js"
{
	import { GameState } from "simulation/ai/common-api/gamestate.js";

	/** Base lifecycle and player context shared by simulation AI implementations. */
	export class BaseAI
	{
		/** Player controlled by this AI instance. */
		player: PlayerId;
		/** Player-specific view of the current simulation state. */
		gameState: GameState;
		/** Initialize the AI after loading shared simulation state. */
		Init(player: PlayerId, sharedAI: object): void;
		/** Handle a simulation update message. */
		HandleMessage(state: object, player: PlayerId, sharedAI: object): void;
		/** Serialize AI-owned state for save games. */
		Serialize(): object;
		/** Restore AI-owned state from a save game. */
		Deserialize(data: object, sharedAI: object): void;
		/** Send an AI chat message. */
		chat(message: string): void;
	}
}
