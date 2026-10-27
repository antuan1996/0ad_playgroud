// Ambient type declarations for the common-api JS modules
// (binaries/data/mods/public/simulation/ai/common-api/*.js).
//
// petra_ts runs on top of these unmodified JS files at runtime; they are not
// transpiled, so this file is the single source of truth for their types.
// Every declaration was verified against the actual code of its module; the
// comments state runtime behaviour (including engine-side details such as
// which grid element sizes the engine produces) rather than paraphrasing
// method names.

type CommonPosition = WorldPos;
type CommonResourceAmounts = ResourceAmounts;
type CommonResourcesManager = import("simulation/ai/common-api/resources.js").ResourcesManager;
type CommonEntityFilter = {
	func: (entity: CommonEntity | CommonTemplate) => boolean;
	dynamicProperties: string[];
};
/**
 * A raw engine grid as common-api sees it: `EngineGridMap` (see
 * engine-api.d.ts), with the `cellSize` the engine does NOT send filled in
 * by Petra's common-api/shared.js (world metres per cell, 1 for the navcell
 * passability grid, 4 for the territory grid).
 */
type CommonPassabilityMap = CommonGrid<"passability">;
/**
 * An engine grid of kind G with its cell size filled in. `__grid` exists only
 * for the compiler: grids of different kinds do not pass for each other.
 * The territory grid is a Grid<u8>, the passability one a Grid<NavcellData>
 * (u16; CCmpAIManager).
 */
type CommonGrid<G extends GridKind> = EngineGridMap & {
	cellSize: number;
	data: G extends "territory" ? Uint8Array : Uint16Array;
	readonly __grid?: G;
};
/**
 * An AI-side analysis map: the {width, height, cellSize} dimensions common
 * to every consecutive-collection InfoMap built on top of engine data,
 * indexing an 8-bit `map` array.
 */
type CommonMap = {
	width: number;
	height: number;
	cellSize: number;
	map: Uint8Array;
};
/**
 * The engine's requirement-group shape as documented on `TechnologyRequirements`
 * (globalscripts.d.ts — the two are the same type, aliased for the common-api
 * naming).
 */
type CommonRequirement = TechnologyRequirements;
/**
 * The unit-item projection of `EngineProductionQueueItem` (engine-api.d.ts)
 * that Petra reads out of `Entity.trainingQueue()`: unit batches always carry
 * these fields, while technology items in the same engine queue omit them.
 */
type CommonTrainingQueueItem = {
	id: number;
	unitTemplate: TemplateName;
	count: number;
	progress: number;
	timeRemaining: number;
	metadata?: Record<string, unknown>;
};
/**
 * One order of a unit's UnitAI queue, as `Entity.unitAIOrderData()` returns it
 * since the engine's commit 4b516b336e (UnitAI.GetOrders): its type ("Gather",
 * "Attack", "Walk", ...) and its data, which some orders lack. Read the data
 * through `adapter/orders.ts`.
 */
type CommonUnitOrder = {
	type: string;
	data?: CommonUnitOrderData;
};
/** An order's data: its target entity and the rest of what the order carries. */
type CommonUnitOrderData = { target?: EntityId; force?: boolean; [key: string]: unknown };
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

/** A unit's `role` (Worker.ROLE_*). */
type WorkerRole = "attack" | "trader" | "switchToTrader" | "worker" | "criticalEntGuard" | "criticalEntHealer";
/** A unit's `subrole` (Worker.SUBROLE_*). */
type WorkerSubrole = "defender" | "idle" | "builder" | "completing" | "walking" | "attacking" | "gatherer" |
	"hunter" | "fisher" | "garrisoning";

/**
 * Petra's own metadata namespace: every key Petra ever stores through
 * setMetadata / sharedScript.setMetadata. All declared fields are optional at
 * runtime (metadata is a plain per-(player, entity) JS object that Petra
 * fills lazily); access through getMetadata typed by the key returns the
 * declared value type when the key was set, undefined otherwise.
 */
interface PetraEntityMetadata
{
	[key: string]: unknown;
	plan: UnitPlan;
	base: BaseId;
	transport: TransportPlanId;
	/** on a ship: the id of the transport plan it serves (a plan, not an entity) */
	transporter: TransportPlanId;
	sea: SeaIndex;
	access: AccessIndex;
	PartOfArmy: ArmyId;
	"target-foundation": EntityId;
	supply: EntityId;
	treasure: EntityId;
	garrisonHolder: EntityId;
	guardedEnt: EntityId;
	distance: number;
	lastAttackPlanUpdateTime: GameSeconds;
	inaccessibleTime: GameSeconds;
	approachingTime: GameSeconds;
	timeGarrison: GameSeconds;
	holderTimeUpdate: GameSeconds;
	turnPreviousPosition: number;
	nextMoveToGatherer: GameSeconds;
	lastHuntSearch: GameSeconds;
	role: WorkerRole;
	subrole: WorkerSubrole;
	"gather-type": string;
	garrisonType: string;
	onBoard: EntityId | "onBoard";
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
	route: { source: EntityId; target: EntityId; gain: number; land?: number; sea?: number };
	lastGathered: GameSeconds;
	carriedBefore: number;
/** The subrole of the entity before it was turned into a defender. */
	formerSubrole?: WorkerSubrole;
}

/**
 * Data extracted from a template by the wrappers in entity.js / shared.js
 * (each wrapper object embeds the raw template plus precomputed fields).
 * Loose by design: only the fields Petra actually reads are declared.
 */
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
	/** per attack type, its bonuses keyed by name; parsed leaves are strings (adapter/templateData.ts reads them) */
	Attack?: Record<string, { Bonuses?: Record<string, {
		Civ?: string;
		Classes?: string;
		Multiplier: string;
	}> }>;
}

/** One modification entry of a tech/aura template (engine-side shapes, see TechnologyModification in globalscripts.d.ts). */
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

/**
 * A tech template's `modifications` list, as stored by shared.js
 * modification caches: an array whose prototype also carries per-value-path
 * sub-lists attached as properties by DeriveModifications helpers.
 */
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
type PetraBaseManager = import("./decision/baseManager.ts").BaseManager;

declare module "simulation/ai/common-api/utils.js"
{
/** Logs a warning from AI script code (prefix-tagged for script debugging). */
	export function aiWarn(output: unknown): void;
/** Stops the AI script with the given exit code (only used for fatal errors). */
	export function exit(exitStatus: number): void;
/** Euclidean distance between two [x, z] positions (uses the deterministic Math.euclidDistance2D). */
	export function VectorDistance(a: CommonPosition, b: CommonPosition): number;
/** Squared Euclidean distance between two [x, z] positions. */
	export function SquareVectorDistance(a: CommonPosition, b: CommonPosition): number;
/**
 * All indices of `map2` covered by cell `index` of `map1`; `map1.cellSize`
 * must be an integer multiple of `map2.cellSize` (typically 4x navcells).
 */
	export function getMapIndices<A extends GridKind, B extends GridKind>(index: CellIndex<A>,
		map1: import("simulation/ai/common-api/map-module.js").InfoMap<A> | CommonGrid<A>,
		map2: import("simulation/ai/common-api/map-module.js").InfoMap<B> | CommonGrid<B>): Array<CellIndex<B>>;
}

declare module "simulation/ai/common-api/terrain-states.js"
{
/** Terrain value marking a navcell as impassable (0). */
	export let IMPASSABLE: number;
/** Terrain value marking a navcell as deep water (200). */
	export let DEEP_WATER: number;
/** Terrain value marking a navcell as shallow/fordable water (201). */
	export let SHALLOW_WATER: number;
/** Terrain value marking a navcell as walkable land (255). */
	export let LAND: number;
}

declare module "simulation/ai/common-api/terrain-analysis.js"
{
/**
 * Region/terrain analyzers over the classified passability data. Both classes
 * extend InfoMap in the actual JS (terrain-analysis.js); two "extends
 * CommonInfoMap" interfaces are merged with the classes below because an
 * ambient module block cannot reference the sibling map-module.js class for
 * a heritage clause.
 */
	interface TerrainAnalysis extends CommonInfoMap
	{
	}
/**
 * Terrain analyzer built once per game by shared.js from the raw state: for
 * every passability-grid navcell it classifies IMPASSABLE / DEEP_WATER /
 * SHALLOW_WATER / LAND (terrain-states.js values) using the
 * "default-terrain-only" land mask and the "ship-terrain-only" water mask.
 * Note the data flow: the passability grid data is uint16 bit-masked,
 * narrowed into an 8-bit classified `map`.
 */
	export class TerrainAnalysis
	{
		constructor(sharedScript: CommonSharedScript, rawState: EngineAIState);
	}
/**
 * Region passability analyzer built over a fresh TerrainAnalysis map: every
 * connected area of passable land/navcell water gets a unique region id, an
 * area size and optionally links to adjacent regions of the other domain.
 */
	interface Accessibility extends CommonInfoMap
	{
	}
	export class Accessibility
	{
		constructor(rawState: EngineAIState, terrainAnalyzer: TerrainAnalysis);
/** Per-region id of each navcell for land movement (region 1 = impassable, ids start at 2). */
		landPassMap: CellGrid<AccessIndex>;
/** Per-region id of each navcell for naval movement. */
		navalPassMap: CellGrid<SeaIndex>;
/** Constant ceiling of region ids (65535; Uint16 region maps). */
		maxRegions: number;
/** Total navcell count per region index ([0] and [1] unused). */
		regionSize: number[];
/** "land" / "water" / "inaccessible" classification per region index. */
		regionType: string[];
/** Region ids adjacent to the region of a given index (e.g. across a navigable river). */
		regionLinks: RegionIndex[][];
/** Id the next floodFill will allocate (starts at 2: 0 unknown, 1 impassable). */
		regionID: number;
/** Region id of the cell containing `position` (of the land or, with `onWater`, the naval map). */
		getAccessValue(position: CommonPosition, onWater?: false): AccessIndex;
		getAccessValue(position: CommonPosition, onWater: true): SeaIndex;
		getAccessValue(position: CommonPosition, onWater: boolean): RegionIndex;
/** Chain of region ids to travel from `start` to `end` (crossing linked regions); false when unreachable, undefined for invalid regions. */
		getTrajectTo(start: CommonPosition, end: CommonPosition): RegionIndex[] | false | undefined;
/** getTrajectTo for already-known region indices. */
		getTrajectToIndex(startRegion: RegionIndex, endRegion: RegionIndex): RegionIndex[] | undefined;
/** Navcell count of the region containing `position` (land or water map). */
		getRegionSize(position: CommonPosition, onWater: boolean): number;
/** getRegionSize for an already-known region index. */
		getRegionSizei(index: RegionIndex, onWater: boolean): number;
/** Flood-fills one region from `startIndex` on the land or naval map; true when a region was (re)allocated. */
		floodFill(startIndex: number, value: number, onWater: boolean): boolean;
	}
}

declare module "simulation/ai/common-api/technology.js"
{
/**
 * Wrapper around one technology template from the global TechnologyTemplates
 * cache. Note the constructor resolves `partOfPair` links; a template name
 * that is not a loaded technology yields undefined template accesses.
 */
	export class Technology
	{
		constructor(templateName: TechName);
		_templateName: TechName;
		_template: CommonTechnologyTemplate;
/** Generic display name, or the civ-specific one when `civ` is given (undefined when no such name exists). */
		name(civ?: string): string | undefined;
/** Whether this template only defines a pair of technologies and nothing else. */
		pairDef(): boolean;
/** The two technologies this pair-defining template groups; undefined for any other template. */
		getPairedTechs(): Technology[] | undefined;
/** The `partOfPair` name this tech is grouped under (undefined for unpaired techs). */
		pair(): string | undefined;
/** The sibling technology name resolved from `partOfPair` at construction (undefined for unpaired techs). */
		pairedWith(): string | undefined;
/** Per-resource cost with unary + coercion, multiplied by `researcher`'s tech-cost multipliers; undefined when the tech has no cost entry. */
		cost(researcher?: CommonTemplate | CommonEntity): CommonResourceAmounts | undefined;
/** Sum of `cost(researcher)`, 0 when there is none. */
		costSum(researcher?: CommonTemplate | CommonEntity): number;
/** Base research time in seconds (0 when the tech sets none). */
		researchTime(): number;
/** DeriveTechnologyRequirements applied to this tech, or false if impossible for `civ`. */
		requirements(civ?: string): TechnologyRequirements | false;
/** The `autoResearch` marker of the template (undefined unless set; stored verbatim, historically also as string). */
		autoResearch(): boolean | string | undefined;
/** Names of techs this tech supersedes (undefined when it supersedes none). */
		supersedes(): string[] | string | undefined;
/** The template's modification list (undefined when it modifies nothing). */
		modifications(): CommonTechnologyModificationList | undefined;
/** The template's `affects` specification (undefined when it affects all). */
		affects(): Array<string | string[]> | undefined;
/** Whether any `affects` entry of the template matches `classes`; undefined when the template lists no affects. */
		isAffected(classes: string[] | string | undefined): boolean | undefined;
	}
}

declare module "simulation/ai/common-api/shared.js"
{
/**
 * Shared per-game AI data, instanced once per AI script (per player): the raw
 * entity snapshots kept in lockstep with the engine, template and metadata
 * caches, per-player derived GameState objects and the resource maps.
 */
	export class SharedScript
	{
		constructor(settings?: Record<string, unknown>);
/** Events collected since the last processed turn (as pushed by the engine's message list). */
		events: EngineAIEvents;
/** Player ids Petra owns, read from the settings' players map. */
		_players: PlayerId[];
/** Cache of all entity templates ever requested, keyed by template name; null entries mark failed downloads. */
		_templates: Record<string, Record<string, unknown> | null>;
/** All alive entity snapshot objects, keyed by entity id. */
		_entities: Map<EntityId, CommonEntity>;
/** Collection of all currently-visible entities. */
		entities: CommonEntityCollection;
		_entityCollections: Map<number, CommonEntityCollection>;
		_entityCollectionsName: Map<string, CommonEntityCollection>;
		_entityCollectionsByDynProp: Record<string, Map<number, CommonEntityCollection>>;
		_entityCollectionsUID: number;
/** Modification caches per entity template and per entity instance (values keyed by tech). */
		_entitiesModifications: Map<EntityId, Map<string, unknown>>;
		_templatesModifications: Record<string, Record<number, Map<string, unknown>>>;
/** Metadata store: [player id][entity id][key]. */
		_entityMetadata: Record<number, Record<number, Record<string, unknown>>>;
/** Pass-class masks keyed by class name as given by the engine passability data. */
		passabilityClasses: Record<string, number>;
		playersData: EnginePlayerState[];
/** Game time in seconds at the last processed turn. */
		timeElapsed: GameMs;
/** Whether the map wraps around horizontally. */
		circularMap: boolean;
/** Map size in metres. */
		mapSize: number;
/** The victory conditions active in the game ("conquest", "wonder", ...). */
		victoryConditions: Set<string>;
		alliedVictory: boolean;
		ceasefireActive: boolean;
/** Seconds of ceasefire remaining, when ceasefire was set. */
		ceasefireTimeRemaining: number;
	/** Latest barter exchange prices as pushed by the engine (list of per-resource amount objects). */
		barterPrices: number[];
/** Terrain passability flags per navcell (engine Grid), with cellSize added. */
		passabilityMap: CommonPassabilityMap;
/** Territory ownership flags per tile (engine Grid), with cellSize added. */
		territoryMap: CommonGrid<"territory">;
/** Terrain-type analyzer over the classified passability data (built once at init). */
		terrainAnalyzer: CommonInfoMap;
/** Region analyzer built over the terrain analyzer (built once at init). */
		accessibility: CommonInfoMap;
/** Per-player derived GameState objects, created lazily per AI player id. */
		gameState: Record<PlayerId, CommonGameState>;
/** Entity ids of all supplies covered by the resource influence maps. */
		resources: number[];
/** Gather-rate influence maps per resource type, keyed "food"/"wood"/... */
		resourceMaps: Record<string, CommonInfoMap>;
/** Same maps, cut to civil-centre influence ranges (Tier-1 civ centre proximity). */
		ccResourceMaps: Record<string, CommonInfoMap>;
		normalizationFactor: Record<string, number>;
		influenceRadius: Record<string, number>;
		ccInfluenceRadius: Record<string, number>;
/** Serializes everything Petra persists between turns (entities' metadata, collections, caches). */
		Serialize(): Record<string, unknown>;
/** Restores the object from Serialize()'s output. */
		Deserialize(data: Record<string, unknown>): void;
/**
 * Downloads and caches the entity template `name` via Engine.GetTemplate;
 * caches null for missing templates. Returns the data or null afterwards;
 * the AI never reads the engine's templates without going through here.
 */
		GetTemplate(name: string): Record<string, unknown> | null;
/** Fills all per-game caches from a fresh `state` dump; with `deserialization`, skips creating derived entities (they arrive through Deserialize). */
		init(state: EngineAIState, deserialization?: boolean): void;
/** Processes a full state dump for a new turn: applies events, deltas of entities and templates, then bumps derived per-player states. */
		onUpdate(state: EngineAIState): void;
/** Applies the entity changes received since the last turn (arrival/attribute/foundation updates). */
		ApplyEntitiesDelta(state: EngineAIState): void;
/** Applies the `changedTemplateInfo` of the last state dump to the per-template, per-player modification caches. */
		ApplyTemplatesDelta(state: EngineAIState): void;
/** Registers a collection to receive automatic updates when its stored filters change membership. */
		registerUpdatingEntityCollection(collection: CommonEntityCollection): void;
/** Unregisters a previously registered updating collection. */
		removeUpdatingEntityCollection(collection: CommonEntityCollection): void;
/** Updates the metadata-keyed collections after a metadata change for `property`. */
		updateEntityCollections(property: string, entity: CommonEntity): void;
/** Assigns Petra's custom metadata for a player+entity+key triple (extending/creating the per-entity metadata object). */
		setMetadata(player: PlayerId, entity: CommonEntity, key: string, value: unknown): void;
/** Reads metadata for a player+entity; undefined when never set. */
		getMetadata<K extends keyof PetraEntityMetadata>(player: PlayerId, entity: CommonEntity, key: K): PetraEntityMetadata[K] | undefined;
		getMetadata(player: PlayerId, entity: CommonEntity, key: string): unknown;
/** Deletes one metadata key; returns whether a value was actually removed. */
		deleteMetadata(player: PlayerId, entity: CommonEntity, key: string): boolean;
/** Rebuilds the resource influence maps from scratch (used at init). */
		createResourceMaps(): void;
/** Applies Destroy/Gathering progress events to the influence maps. */
		updateResourceMaps(events: EngineAIEvents): void;
/** Adds the contribution of a living supply entity to the resource influence maps. */
		addEntityToResourceMap(entity: CommonEntity): void;
/** Removes a supply entity's contribution from the resource influence maps. */
		removeEntityFromResourceMap(entity: CommonEntity): void;
/** Adds (or, with `multiplication`, subtracts) one entity's contribution to the influence maps. */
		changeEntityInResourceMapHelper(entity: CommonEntity | undefined, multiplication?: number): void;
	}
}

declare module "simulation/ai/common-api/resources.js"
{
/**
 * Plain resource amount account (also used for costs and gather-rate quotas).
 * Amounts live on the object itself, keyed by resource code, so mod-added
 * resources work through the index. A class whose methods share the object
 * cannot give its string index the type `number`, so the instance type is
 * the methods intersected with the amounts.
 */
	interface ResourcesManagerMethods
	{
		population: number;
		food: number;
		wood: number;
		stone: number;
		metal: number;
/** Zeroes all amounts and population. */
		reset(): void;
/** Whether every resource code currently defined (Resources.GetCodes()) is held in at least the requested amount. */
		canAfford(amounts: CommonResourceAmounts | ResourcesManager): boolean;
/** Adds the given amounts; `population` is added too, resource entries added by name. */
		add(amounts: CommonResourceAmounts | ResourcesManager): void;
/** Subtracts the given amounts (population subtracted as well). */
		subtract(amounts: CommonResourceAmounts | ResourcesManager): void;
/** Multiplies every resource amount by `multiplier`. */
		multiply(multiplier: number): void;
/** Round-trips the account (amounts keyed by resource name, plus population). */
		Serialize(): { amounts: CommonResourceAmounts; population: number };
/** Restores the account from Serialize()'s output. */
		Deserialize(data: { amounts: CommonResourceAmounts; population: number }): void;
	}
	export type ResourcesManager = ResourcesManagerMethods & { [resource: string]: number };
	export const ResourcesManager: new (amounts?: CommonResourceAmounts, population?: number) => ResourcesManager;
}

declare module "simulation/ai/common-api/map-module.js"
{
/**
 * Single-channel 8-bit value map over the game world: the base class behind
 * the gather-rate resource maps, the territory influence maps, obstruction
 * analyses (TerrainAnalysis/Accessibility) and the maps Petra builds for base
 * placement. Resolution varies by instantiation — navcell-sized (cellSize 1)
 * for accessibility, tile-sized (cellSize 4) for most influence maps.
 */
	export class InfoMap<G extends GridKind = GridKind>
	{
/** Exists only for the compiler: the kind of grid this map covers. */
		readonly __grid?: G;
/**
 * When `sharedScript` is a SharedScript, dimensions and cell size are read
 * from its passability map; when it is a plain object, its {width, height,
 * cellSize} triple is used instead. `originalMap` seeds `map` from a real
 * engine grid (`actualCopy` decides between copying and aliasing it).
 */
		constructor(sharedScript: CommonSharedScript | Record<string, unknown>, type: G, originalMap?: Uint8Array, actualCopy?: boolean);
		width: number;
		height: number;
/** World-metre size of one cell of this map (1 = navcell, 4 = terrain tile in practice). */
		cellSize: number;
/** width * height in cells. */
		length: number;
/** Highest value any operation has written (influences may regenerate it). */
		maxVal: number;
		map: Uint8Array;
/** Precomputed per-distance circle widths used by the obstruction searches (see findBestTile; index = distance). */
		pattern?: number[];
/** Re-declares the highest possible map value (used by influence maths). */
		setMaxVal(value: number): void;
/** Converts a world [x, z] position to its [x, z] map coordinates. */
		gamePosToMapPos(position: CommonPosition): MapPos;
/** Map value at the cell containing `position`. */
		point(position: CommonPosition): number;
/** Iterates the cells within `maxDistSquared` around (cx, cy) calling `callback` (whose return value is added to the cell). */
		runLoop(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, maxDistSquared: number, callback: (index: number, distanceSquared: number) => number): void;
/** Adds an influence profile ("linear"/"constant"/"inverted") around (cx, cy) with radius maxDist. */
		addInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Multiplies an influence profile ("constant"/"linear") around (cx, cy). */
		multiplyInfluence(cx: number, cy: number, maxDist: number, strength?: number, type?: string): void;
/** Adds the values of another InfoMap into this one (element-wise sum, clamped to [0, maxVal]). */
		add(map: CommonInfoMap): void;
/** Overwrites the value of cell `index` (clamped to [0, maxVal]). */
		set(index: CellIndex<G>, value: number): void;
/** Finds the best cell for a building of `radius` inside `obstruction`'s constraint map (winning cell index and its valuation; idx undefined when nothing fits). */
		findBestTile<O extends GridKind>(radius: number, obstruction: InfoMap<O>): { idx: CellIndex<O> | undefined; val: number };
/** Searches the nearest non-obstructed tile of radius `radius` around the cell `index`. */
		getNonObstructedTile<O extends GridKind>(index: CellIndex<G>, radius: number, obstruction: InfoMap<O>): CellIndex<O>;
/** Tests whether a circular building at (x, y) overlaps an obstruction in the map, returning one blocked cell. */
		isObstructedTile(x: number, y: number, radius: number): { x: number; y: number } | null;
/** Writes the map out as a PNG via Engine.DumpImage (debugging helper; values above `threshold`, or at maxVal when omitted). */
		dumpIm(name?: string, threshold?: number): void;
	}
}

declare module "simulation/ai/common-api/gamestate.js"
{
/**
 * Per-player view of the shared game state: diplomacy queries, entity and
 * resource lookups and train/research helpers. Built per player against the
 * shared script (init once, then update() each turn).
 */
	export class GameState
	{
		constructor();
/** The bot's persistent state object (PetraRuntime.AIState). */
		ai: PetraRuntime.AIState;
		sharedScript: CommonSharedScript;
/** All entities of the game (as collection). */
		entities: CommonEntityCollection;
		EntCollecNames: Map<string, CommonEntityCollection>;
/** Shared-script game time in milliseconds. */
		timeElapsed: GameMs;
		circularMap: boolean;
		templates: Record<string, Record<string, unknown> | null>;
/** Player id of this view (gameState.player). */
		player: PlayerId;
		playerData: EnginePlayerState;
		victoryConditions: Set<string>;
		alliedVictory: boolean;
		ceasefireActive: boolean;
		ceasefireTimeRemaining: number;
/** Phase progression of this civ, precomputed at init from the civil centre's researchable techs ({name, requirements} in research order). */
		phases: Array<{ name: string; requirements: CommonRequirement[] }>;
/** Fills this per-player state from the shared script (and refreshes the phases list). */
		init(sharedScript: CommonSharedScript, state: Record<string, unknown>, player: PlayerId): void;
/** Copies the shared script's current values into this object (per-turn refresh). */
		update(sharedScript: CommonSharedScript): void;
/** Registers a named, auto-updating entity collection filtered by `filter`, derived from `parentCollection` (or the own entities). */
		updatingCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
/** Unregisters a per-player updating collection by id. */
		destroyCollection(id: string): void;
/** Updating collection filtered over the whole map's entities instead of one player's. */
		updatingGlobalCollection(id: string, filter: CommonEntityFilter, parentCollection?: CommonEntityCollection): CommonEntityCollection;
/** destroys a global updating collection by id. */
		destroyGlobalCollection(id: string): void;
/** Rebuilds auto-updating collections after a diplomacy change reclassifies owners. */
		resetOnDiplomacyChanged(): void;
/** Time since the game started, in milliseconds. */
		getTimeElapsed(): GameMs;
/** Current barter prices as {buy, sell} per-resource-value objects. */
		getBarterPrices(): { buy: CommonResourceAmounts; sell: CommonResourceAmounts };
/** The set of active victory condition codes shared by all players. */
		getVictoryConditions(): Set<string>;
/** Whether team-victory (allied victory) is enabled. */
		getAlliedVictory(): boolean;
/** Whether a ceasefire is running in the current game. */
		isCeasefireActive(): boolean;
/**
 * The wrapper for one template name: a Technology for a technology name (the
 * implementation asks TechnologyTemplates first), a Template for an entity
 * template name; null for a name that names neither.
 */
		getTemplate(type: TechName): CommonTechnology | null;
		getTemplate(type: TemplateName): CommonTemplate | null;
/** Template of the structure a foundation builds (strips the "foundation|" filter prefix); null for a bogus name or unknown template. */
		getBuiltTemplate(foundationName: TemplateName): CommonTemplate | null;
/** Replaces the {civ} wildcard in a template name with this player's civ. */
		applyCiv(templateName: string): TemplateName;
/** Civ of `player` (this player's own when omitted). */
		getPlayerCiv(player?: PlayerId): string;
/** Number of the last researched phase (1-based); 0 when none reached yet. */
		currentPhase(): number;
/** Count of this civ's phases. */
		getNumberOfPhases(): number;
/** Name of phase `i` (1-based); undefined when out of range. */
		getPhaseName(index: number): TechName | undefined;
/** Entity-class requirements ("check: count" entries only) of phase `i`, flattened to {class, count} pairs. */
		getPhaseEntityRequirements(index: number): Array<{ class: string; count: number }>;
/** Whether `template` is already researched by this player. */
		isResearched(template: TechName): boolean;
/** Whether `template` is currently being researched (by anyone in this player's queues). */
		isResearching(template: TechName): boolean;
/**
 * Whether this player may research `techTemplateName`: requirement checks
 * against the phase chain, completeness of researcher production, and
 * template availability; `noRequirementCheck` skips only the requirement
 * subtree.
 */
		canResearch(templateName: TechName, noRequirementCheck?: boolean): boolean;
/** Whether a requirement list (as produced by DeriveTechnologyRequirements) is satisfiable; false values give false. */
		checkTechRequirements(requirements: CommonRequirement[] | false): boolean;
/** Terrain passability grid of the map (engine Grid, cellSize added by shared.js). */
		getPassabilityMap(): CommonPassabilityMap;
/** Access bit mask handed by the engine for a named pathfinding pass class. */
		getPassabilityClassMask(name: string): number;
/** Own resource stock (shortcuts this player's current amounts entry). */
		getResources(): CommonResourcesManager;
/** Current population count of the player (playerData.popCount). */
		getPopulation(): number;
/** Current population limit of the player, i.e. including housing already built (playerData.popLimit). */
		getPopulationLimit(): number;
/** Total population the player may ever reach, incl. everything still building (playerData.popMax). */
		getPopulationMax(): number;
/** Own player id (shortcuts `this.player`). */
		getPlayerID(): PlayerId;
/** Whether the player has current-game allies. */
		hasAllies(): boolean;
/** Whether the player has current-game enemies. */
		hasEnemies(): boolean;
/** Whether the player has current-game neutral parties. */
		hasNeutrals(): boolean;
/** Diplomacy relationship checks by id (gaia is neither ally, enemy nor neutral). */
		isPlayerNeutral(id: PlayerId): boolean;
		isPlayerAlly(id: PlayerId): boolean;
		isPlayerMutualAlly(id: PlayerId): boolean;
		isPlayerEnemy(id: PlayerId): boolean;
/** Count of enemy players (everyone listed in getEnemies). */
		getNumPlayerEnemies(): number;
/** Player ids whose isEnemy flag is set in this player's diplomacy data. */
		getEnemies(): PlayerId[];
/** Player ids whose isNeutral flag is set. */
		getNeutrals(): PlayerId[];
/** Player ids whose isAlly flag is set (includes the player itself). */
		getAllies(): PlayerId[];
/** getAllies without this player's own id. */
		getExclusiveAllies(): PlayerId[];
/** Player ids with mutual ally relationships (both directions true), used by Petra for trade planning. */
		getMutualAllies(): PlayerId[];
/** Diplomacy checks for an entity's owner (undefined/false-y entities are safe). */
		isEntityAlly(entity: CommonEntity | undefined): boolean;
		isEntityExclusiveAlly(entity: CommonEntity | undefined): boolean;
		isEntityEnemy(entity: CommonEntity | undefined): boolean;
/** Whether the entity belongs to this player (its own). */
		isEntityOwn(entity: CommonEntity | undefined): boolean;
/** Live entity by id (undefined/0/stale ids give undefined). */
		getEntityById(id: EntityId | undefined): CommonEntity | undefined;
/** Updating collection keyed over all entities: entities of owner `id`, or the whole world collection when omitted. */
		getEntities(id?: PlayerId): CommonEntityCollection;
/** All structures of the world (any owner, as global collection). */
		getStructures(): CommonEntityCollection;
/** All entities owned by the AI player. */
		getOwnEntities(): CommonEntityCollection;
/** Structures of the AI player. */
		getOwnStructures(): CommonEntityCollection;
/** Units of the AI player. */
		getOwnUnits(): CommonEntityCollection;
/** Entities of all non-enemy allied players (global view). */
		getAllyEntities(): CommonEntityCollection;
/** Entity ids of exclusive allies. */
		getExclusiveAllyEntities(): CommonEntityCollection;
/** Structures of ally `allyID` or of all allies. */
		getAllyStructures(allyID?: PlayerId): CommonEntityCollection;
/** All structures of neutral players as global collection. */
		getNeutralStructures(): CommonEntityCollection;
/** Entities/structures/units of all enemy players (global view). */
		getEnemyEntities(): CommonEntityCollection;
		getEnemyStructures(enemyID?: PlayerId): CommonEntityCollection;
		getEnemyUnits(enemyID?: PlayerId): CommonEntityCollection;
/** Auto-updating collections of Petra's own entities whose metadata key matches `value`. */
		getOwnEntitiesByMetadata(key: string, value: unknown, maintain?: boolean): CommonEntityCollection;
/** By `role` metadata (helper over getOwnEntitiesByMetadata). */
		getOwnEntitiesByRole(role: WorkerRole | undefined, maintain?: boolean): CommonEntityCollection;
/** By template name, included in the collection when `maintain` is set. */
		getOwnEntitiesByType(type: string, maintain?: boolean): CommonEntityCollection;
/** By Identity class single (Collection filtered by class). */
		getOwnEntitiesByClass(cls: string, maintain?: boolean): CommonEntityCollection;
/** Foundations of the AI player with a given identity class (placement helpers). */
		getOwnFoundationsByClass(cls: string, maintain?: boolean): CommonEntityCollection;
/** Own structures able to train (has Trainer). */
		getOwnTrainingFacilities(): CommonEntityCollection;
/** Own structures able to research. */
		getOwnResearchFacilities(): CommonEntityCollection;
/** Count of the AI player's entities of one template. */
		countEntitiesByType(type: string, maintain?: boolean): number;
/** Count including currently-queued units (training queue of the AI's structures). */
		countEntitiesAndQueuedByType(type: string, maintain?: boolean): number;
/** Count of foundations of one template. */
		countFoundationsByType(type: string, maintain?: boolean): number;
/** Own entities with the given role metadata. */
		countOwnEntitiesByRole(role: WorkerRole): number;
/** countOwnEntitiesByRole plus queued role units. */
		countOwnEntitiesAndQueuedWithRole(role: WorkerRole): number;
/** countOwnEntitiesAndQueuedWithRole parameterized on arbitrary metadata. */
		countOwnQueuedEntitiesWithMetadata(data: string, value: unknown): number;
/** Own foundations. */
		getOwnFoundations(): CommonEntityCollection;
/** Own dropsite structures (optionally for one resource). */
		getOwnDropsites(resource?: string): CommonEntityCollection;
/** Dropsites of all players (any owner). */
		getAnyDropsites(resource?: string): CommonEntityCollection;
/** Supplies of one resource (auto-updating collection over all entities). */
		getResourceSupplies(resource: string): CommonEntityCollection;
/** Animal resource supplies ("huntable" — non-defensive, killable prey). */
		getHuntableSupplies(): CommonEntityCollection;
/** Fish resource supplies. */
		getFishableSupplies(): CommonEntityCollection;
/**
 * Aggregate list of all units the AI's own structures train, filtered by
 * class affinity (`classes` vs `anticlasses` matches-class-list specs) and by
 * the player's entity limits; [templateName, Template] pairs in iteration
 * order (no cost weighting happens here).
 */
		findTrainableUnits(classes: Array<string | string[]>, anticlasses?: string[]): Array<[TemplateName, CommonTemplate]>;
/** Available technologies across all own researchable structures, deduplicated and not disabled; [name, Technology] pairs (the wrapper for tech names is a Technology). */
		findAvailableTech(): Array<[TechName, CommonTechnology]>;
/** Whether one of the AI's structures can train `template`. */
		hasTrainer(template: string): boolean;
/** Own structures able to train `template`, as collection. */
		findTrainers(template: string): CommonEntityCollection;
/** One builder able to construct `template`, preferring the nearest idle one. */
		findBuilder(template: string): CommonEntity | undefined;
/** Whether one of the AI's structures can research `templateName`. */
		hasResearchers(templateName: TechName, noRequirementCheck?: boolean): boolean;
/** Own structures able to research `templateName` (undefined when the tech is not available). */
		findResearchers(templateName: TechName, noRequirementCheck?: boolean): CommonEntityCollection | undefined;
/** Per-template entity limit categories, straight from this player's engine player state. */
		getEntityLimits(): Record<string, number>;
/** Per-template counts of existing entities with active match markers (playerData.matchEntityCounts). */
		getEntityMatchCounts(): Record<string, number>;
/** Per-template existing entity counts (playerData.entityCounts). */
		getEntityCounts(): Record<string, number>;
/** Whether a template is both downloaded and not disabled by the player; undefined (truthy template object, etc.) otherwise. */
		isTemplateAvailable(templateName: TemplateName): boolean | Record<string, unknown> | null | undefined;
/** Whether a template is disabled by this player (the disabled-templates data of game settings). */
		isTemplateDisabled(templateName: TemplateName): boolean;
/** Whether category `category` has reached its entity limit. */
		isEntityLimitReached(category: string): boolean;
/** Trade-gain multipliers of the trainable trader templates, keyed by land/naval transport. */
		getTraderTemplatesGains(): { landGainMultiplier?: number; navalGainMultiplier?: number };
	}
}

declare module "simulation/ai/common-api/filters.js"
{
/**
 * Filter descriptors consumed by GameState.updatingCollection and
 * EntityCollection.filter. Each returns a {func, dynamicProperties} pair:
 * `func` is the predicate, `dynamicProperties` the list of entity fields
 * whose changes should re-evaluate members of auto-updating collections.
 * By convention `by*` filters select by structure (type, class, owner) while
 * `is*`/`has*` filters assert a state (idle, foundation, dropsite...); all
 * are plain positive predicates.
 */
	export function byType(type: string): CommonEntityFilter;
/** Matches entities whose template's identity class list contains `cls` (exact, case-sensitive). */
	export function byClass(cls: string): CommonEntityFilter;
/** byClass with a matches-class-list specification ("Class1+Class2 Class3" etc.). */
	export function byClasses(clsList: string[] | string): CommonEntityFilter;
/** Matches own entities whose metadata `key` equals `value`. */
	export function byMetadata(player: PlayerId, key: string, value: unknown): CommonEntityFilter;
/** Matches entities that have any value for the metadata `key` of `player`. */
	export function byHasMetadata(player: PlayerId, key: string): CommonEntityFilter;
/** Logical AND of two filters (dynamic properties merged). */
	export function and(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
/** Logical OR of two filters. */
	export function or(filter1: CommonEntityFilter, filter2: CommonEntityFilter): CommonEntityFilter;
/** Inverts a filter over the same entity universe. */
	export function not(filter: CommonEntityFilter): CommonEntityFilter;
/** Owner checks by player id, sets of ids, and negated variants. */
	export function byOwner(owner: PlayerId): CommonEntityFilter;
	export function byNotOwner(owner: PlayerId): CommonEntityFilter;
	export function byOwners(owners: PlayerId[]): CommonEntityFilter;
/** Matches entities that can garrison (Garrisonable classes non-empty). */
	export function byCanGarrison(): CommonEntityFilter;
/** Matches own structures with a non-empty production queue. */
	export function byTrainingQueue(): CommonEntityFilter;
/** Matches structures that can research from `gameState` for civ `civ`. */
	export function byResearchAvailable(gameState: CommonGameState, civ: string): CommonEntityFilter;
/** Matches entities with an Attack component able to hit identity class `aClass`. */
	export function byCanAttackClass(aClass: string): CommonEntityFilter;
/** Matches entities able to damage `target`. */
	export function byCanAttackTarget(target: CommonEntity): CommonEntityFilter;
/** Matches units currently garrisoned inside another entity. */
	export function isGarrisoned(): CommonEntityFilter;
/** Matches own units that have no task and stand idle. */
	export function isIdle(): CommonEntityFilter;
/** Matches foundations (unit/building being built). */
	export function isFoundation(): CommonEntityFilter;
/** Matches built structures (non-foundation). */
	export function isBuilt(): CommonEntityFilter;
/** Matches structures able to fire arrows from their own defence. */
	export function hasDefensiveFire(): CommonEntityFilter;
/** Matches dropsite structures (optionally only for one resource). */
	export function isDropsite(resourceType?: string): CommonEntityFilter;
/** Matches treasure-collectible entities (Treasure components). */
	export function isTreasure(): CommonEntityFilter;
/** Matches resource-supply entities of `resourceType`. */
	export function byResource(resourceType: string): CommonEntityFilter;
/** Matches huntable animals (killable, non-defensive fauna). */
	export function isHuntable(): CommonEntityFilter;
/** Matches fisher-resource fish (water supplies). */
	export function isFishable(): CommonEntityFilter;
}

declare module "simulation/ai/common-api/entitycollection.js"
{
/**
 * A set of entities with cached filters and optional auto-updating
 * behaviour. When frozen, updates received from the engine queue up until
 * defreeze. The class also provides the formation move/attack command helpers
 * (each issuing a PostCommand for all members at once).
 */
	export class EntityCollection
	{
/**
 * Builds the collection from the given map of entities (default: an empty
 * map) and initial filters. `sharedAI` is required to enable membership
 * tracking of dynamic filters and the registration updates.
 */
		constructor(sharedAI: CommonSharedScript, entities?: Map<EntityId, CommonEntity>, filters?: CommonEntityFilter[]);
/** Number of entities in the collection (a getter backed by the entity map). */
		readonly length: number;
/** Whether updates from the engine are queued (deferred) rather than applied instantly. */
		frozen: boolean;
/** Round-trips the entity ids, the frozen flag and the filter specs by name. */
		Serialize(): { ents: EntityId[]; frozen: boolean; filters: string[] };
/** Restores the collection from Serialize()'s output. */
		Deserialize(data: { ents: EntityId[]; frozen: boolean; filters: string[] }, sharedAI: CommonSharedScript): void;
/** Freeze: auto-updates stop adding entities (removals still happen), so dead members are cleaned up automatically. */
		freeze(): void;
/** Applies all deferred updates. */
		defreeze(): void;
/** Entity ids as plain array. */
		toIdArray(): EntityId[];
/** Entity objects as plain array. */
		toEntityArray(): CommonEntity[];
/** Iterates over the entities (unsorted). */
		values(): IterableIterator<CommonEntity>;
/** Debug helper printing the template names of the members. */
		toString(): string;
/**
 * Returns a new collection limited to the entities for which `filter` holds;
 * the entries of `dynamicProperties` of CommonEntityFilter cause re-checking
 * on the listed entity field changes.
 */
		filter(filter: CommonEntityFilter | ((entity: CommonEntity, id: EntityId, collection: this) => boolean), thisp?: unknown): EntityCollection;
/** The entities of the collection nearest to `targetPos` (all of them when `n` is omitted; entities without a position are skipped), as a new collection. */
		filterNearest(targetPos: CommonPosition, n?: number): EntityCollection;
/** filter() with a raw function that receives the raw entity object rather than the wrapper (faster, e.g. velocity check). */
		filter_raw(callback: (entity: unknown, id: EntityId, collection: this) => boolean, thisp?: unknown): EntityCollection;
/** Runs `callback` on each member entity and returns the collection. */
		forEach(callback: (entity: CommonEntity) => void): this;
/** Whether the collection holds at least one entity. */
		hasEntities(): boolean;
/** Move in formation to (x, z) in world coordinates. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Move to the edge of a range band `(min, max)` around (x, z). */
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
/** Attack-move toward (x, z); targetClasses either a plain class list, or an object with attack/avoid lists and vetoEntity overrides. */
		attackMove(x: number, z: number, targetClasses: string[] | {
			attack: string[];
			avoid: string[];
			vetoEntities: Record<string, boolean>;
		}, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Same as move but issuing each order individually so that stragglers do not queue via others. */
		moveIndiv(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Garrison all entities into `target`. */
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Occupy the turret point of `target` with the relevant subset of the collection. */
		occupyTurret(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Destroys all members (via the engine "delete-entity" command). */
		destroy(): this;
/** Orders all members to attack `unitId` (entity id, not wrapper). */
		attack(unitId: EntityId, queued?: boolean, pushFront?: boolean): this;
/** Sets a stance for all members (only meaningful for unit members with a stance component). */
		setStance(stance: string): this;
/** Average position of all positioned members; undefined when the collection is empty. */
		getCentrePosition(): CommonPosition | undefined;
/** Average over the first `sample` positioned members (faster, but less exact); undefined when empty. */
		getApproximatePosition(sample: number): CommonPosition | undefined;
/** Whether the collection includes the entity id `id`. */
		hasEntId(id: EntityId): boolean;
/** Removes one entity from the collection (entity wrapper); true actually removed. */
		removeEnt(entity: CommonEntity): boolean;
/** Adds one entity (when not already in); true added. */
		addEnt(entity: CommonEntity): boolean;
/** Re-evaluates a member against the collection's filters; true kept, false dropped. */
		updateEnt(entity: CommonEntity, force?: boolean): boolean;
/** Registers this collection with the shared script for automatic updates. */
		registerUpdates(): void;
/** Unregisters this collection. */
		unregister(): void;
/** Dynamic properties of the filters of this collection. */
		dynamicProperties(): string[];
/** Sets the collection's registration uid (collection re-created after autoload). */
		setUID(id: number): void;
/** Returns the registration uid. */
		getUID(): number;
	}
}

declare module "simulation/ai/common-api/entity.js"
{
/**
 * Wrapper around one entity template with tech-modification support: the
 * owning template's per-player modifications are checked first on every
 * get() path, then the raw template value (per path cached in _tpCache).
 */
	export class Template
	{
/** Holds the sharedAI template-name → modifications registry and a per-path value cache (see the override in Entity for the per-entity variant). */
		constructor(sharedAI: CommonSharedScript, templateName: string, template: Record<string, unknown>);
		_template: CommonTemplateData;
		_templateName?: string;
/**
 * Dotted-path template lookup (e.g. "Cost/Population"), with per-owner tech
 * modifications from _templateModif (and — for entities — _entityModif)
 * applied before the raw walk; per-path results are cached. Note the loose
 * overloads: the typed ones exist for the paths where a return type is
 * statically known; the generic overload returns whatever the template holds.
 */
		get(path: "Cost/Population"): string | undefined;
		get(path: "UnitAI/DefaultStance"): string | undefined;
		get(path: "ResourceSupply/Type"): string | undefined;
/** Anything else: whatever the template holds there, read through adapter/templateData.ts. */
		get(path: string): unknown;
/** Full template name (civ or wildcard substitution already applied where appropriate). */
		templateName(): TemplateName;
/** Display name from the template (undefined if absent). */
		genericName(): string | undefined;
/** Template civ restriction from Identity/Civ (undefined when the template sets none). */
		civ(): string | undefined;
/** Numeric limit attached by a TrainingRestrictions block (undefined when the template sets none). */
		matchLimit(): number | undefined;
/** All identity classes of the template (undefined for templates without an Identity block). */
		classes(): string[] | undefined;
/** Whether the template's class list includes `name` (exact, case-sensitive). */
		hasClass(name: string): boolean | undefined;
/** Whether the class list matches a nested matches-class-list specification ("Hero"/"Unit" strings or [[Class1],[Class2]] arrays). */
		hasClasses(classes: string[] | string | string[][] | undefined): boolean | undefined;
/** Identity/Requirements spec of the template, verbatim (undefined when none); see DeriveTechnologyRequirements in globalscripts.d.ts for evaluation. */
		requirements(): TechnologyRequirements | CommonRequirement[] | undefined;
/** Whether the template is available for `gameState` (not disabled, applicable for this player's phase). */
		available(gameState: CommonGameState): boolean;
/** Resource cost of the template (with Technology-researcher cost multipliers ignored for undefined productionQueue). */
		cost(productionQueue?: unknown): CommonResourceAmounts;
/** Total resource cost of the template. */
		costSum(productionQueue?: unknown): number;
/** Technician "Researcher/TechCostMultiplier/<type>" of the template, coerced to number with default 1. */
		techCostMultiplier(type: string): number;
/** Obstruction radii derived from the template's footprint; undefined for structures without a footprint. */
		obstructionRadius(): { max: number; min: number } | undefined;
/** Inscribed circle radius of the footprint (half the shorter side). */
		footprintRadius(): number | undefined;
/** Max hitpoints of the template (0 when the template has none). */
		maxHitpoints(): number;
/** Whether the template has a Health block that isn't marked Unhealable. */
		isHealable(): boolean;
/** Whether the template can be repaired. */
		isRepairable(): boolean;
/** Population/Bonus of the template (0 when it adds none). */
		getPopulationBonus(): number;
/** Damage/Capture resistances of the template (undefined for templates without a Resistance component). */
		resistanceStrengths(): { Capture?: number; Damage?: Record<string, number> } | undefined;
/** Names of the attack types the template performs (Melee, Ranged, Capture, ...). */
		attackTypes(): string[] | undefined;
/** Range (min/max) of one attack type; undefined when the type has no Range. */
		attackRange(type: string): { max: number; min: number } | undefined;
/** Damage strengths (Hack, Pierce, Crush...) of one attack type. */
		attackStrengths(type: string): Record<string, number> | undefined;
/** Capture-attack strength of the template (undefined when it has none). */
		captureStrength(): number | undefined;
/** Repeat times of one attack type (prepare/repeat/recover delays). */
		attackTimes(type: string): Record<string, number> | undefined;
/** Classes this template deals bonus damage against, as [classes, multiplier] pairs (undefined without bonuses). */
		getCounteredClasses(): Array<[string[], number]> | undefined;
/** Whether the template deals any significant bonus damage against `target`'s classes. */
		counters(target: CommonTemplate | CommonEntity): boolean;
/** Bonus multiplier of a given attack type against one identity class (undefined without a matching bonus entry). */
		getMultiplierAgainst(type: string, againstClass: string): number | undefined;
/** All structure templates a builder-class template can construct for a civ. */
		buildableEntities(civ: string): TemplateName[];
/** All units trainable by the template for a civ (undefined when it trains none). */
		trainableEntities(civ: string): TemplateName[] | undefined;
/** Techs researchable by the template for `gameState` and civ (undefined when it researches none). */
		researchableTechs(gameState: CommonGameState, civ: string): TechName[] | undefined;
/** {generic, specific} resource names the template supplies (undefined when it supplies nothing). */
		resourceSupplyType(): CommonResourceSupplyType | undefined;
/** Generic part of ResourceSupply/Type (everything before the first dot); undefined when the template supplies nothing. */
		getResourceType(): string | undefined;
/** DiminishingReturns factor of the supply, coerced to number, default 1 (no change). */
		getDiminishingReturns(): number;
/** Total amount supplied (integer >= 1; 0 when the template is not a supply). */
		resourceSupplyMax(): number;
/** Maximum simultaneous gatherers (undefined when there is no limit marker). */
		maxGatherers(): number;
/** Gather rates by resource category for a gatherer (undefined when the template cannot gather). */
		resourceGatherRates(): Record<string, number> | undefined;
/** Resources the template receives when used as a dropsite (undefined when it is none). */
		resourceDropsiteTypes(): string[] | undefined;
/** Whether the template accepts the given resource (undefined unless dropsite). */
		isResourceDropsite(resourceType?: string): boolean | undefined;
/** Whether the template is a treasure (collectible goodwill resource). */
		isTreasure(): boolean;
/** Treasure resources carried by the template (undefined when it is not a treasure). */
		treasureResources(): Record<string, number> | undefined;
/** Classes garrisonable into this garrison holder (undefined when it garrisons none). */
		garrisonableClasses(): string[] | undefined;
/** Garrisoning capacity of the holder as capacity in entity slots. */
		garrisonMax(): number;
/** Capacity each garrisoned entity consumes (default 1). */
		garrisonSize(): number;
/** Health fraction of garrisoned members returned to them on eject (ejection damage fraction). */
		garrisonEjectHealth(): number;
/** Default arrow count of an attack-defending structure (0 unless it has defensive fire). */
		getDefaultArrow(): number;
/** Bonus arrow count multiplier given by garrisoned archers (0 unless defined). */
		getArrowMultiplier(): number;
/** Class list whose members add bonus arrows when garrisoned (undefined when it garrisons none). */
		getGarrisonArrowClasses(): string[] | undefined;
/** Heal rate of a garrison/aura buffing healer (0 when none). */
		buffHeal(): number;
/** Template this one promotes to (undefined when there is no promotion). */
		promotion(): string | undefined;
/** Whether the template can be packed/unpacked (siege units etc). */
		isPackable(): boolean;
/** Whether the template is a huntable animal (by its classes and walk speed). */
		isHuntable(): boolean;
/** Walk speed in metres per second as declared by the template (structures have none). */
		walkSpeed(): number;
/** TrainingRestrictions/Category marker of the template (e.g. "Hero"), undefined when unrestricted. */
		trainingCategory(): string | undefined;
/** Construction time in seconds, optionally scaled by `researcher`'s tech-cost multipliers. */
		buildTime(researcher?: CommonTemplate | CommonEntity): number;
/** Research time of the template ([0 when none is defined]). */
		researchTime(): number;
/** Build category marker class of the template (used to match foundations matching build limits). */
		buildCategory(): string | undefined;
/** Minimum-distance build constraint {MinDistance, FromClass}; undefined when unconstrained. */
		buildDistance(): { MinDistance?: number; FromClass?: string; [key: string]: number | string | undefined } | undefined;
/** Placement type marker ("shore" for shore-constrained structures), undefined for normal structures. */
		buildPlacementType(): string | undefined;
/** Buildable territory strings (own, allied, neutral, enemy) from the template. */
		buildTerritories(): string[] | undefined;
/** Whether the template can be built on the named territory. */
		hasBuildTerritory(territory: string): boolean | undefined;
/** Whether the template carries a TerritoryInfluence block (radius, weight). */
		hasTerritoryInfluence(): boolean;
/** Whether the template has defensive fire (mixed returns: arrow count, or false when none). */
		hasDefensiveFire(): number | false;
/** Territory influence radius (0 when none). */
		territoryInfluenceRadius(): number;
/** Territory influence weight (0 when none). */
		territoryInfluenceWeight(): number;
/** Territory decay rate of the template (0 default decay of structures). */
		territoryDecayRate(): number;
/** Base health-regeneration rate (0 unless defined). */
		defaultRegenRate(): number;
/** Additional health-regeneration per garrisoned entity (0 unless defined). */
		garrisonRegenRate(): number;
/** Vision range in metres. */
		visionRange(): number;
/** Trade gain multiplier of a trader (1 default; modified by traders' upgrades). */
		gainMultiplier(): number;
/** Whether this template can build (has the Builder component). */
		isBuilder(): boolean;
/** Whether this template can gather (has the Gatherer component). */
		isGatherer(): boolean;
/** Whether this template can gather the given resource type. */
		canGather(type: string): boolean;
/** Whether this template can garrison other entities (a garrison holder). */
		isGarrisonHolder(): boolean;
/** Whether this template has a turret point. */
		isTurretHolder(): boolean;
/** Whether the template can capture (has a Capture attack against the given optional target). */
		canCapture(target?: CommonTemplate | CommonEntity): boolean;
/** Whether the template is capturable (has capture points). */
		isCapturable(): boolean;
/** Whether the template can guard another entity (has a Guard component). */
		canGuard(): boolean;
/** Whether this template can be garrisoned into other entities (a garrisonable unit). */
		canGarrison(): boolean;
/** Whether this template can occupy a turret (generally a projectile weapon). */
		canOccupyTurret(): boolean;
/** Whether this template can collect treasures (a "collector"). */
		isTreasureCollector(): boolean;
/** Whether the template has a UnitAI component (comparable to hasClass("Unit")). */
		hasUnitAI(): boolean;
	}
/**
 * Wrapper around one live engine entity. All read-only data comes from the
 * engine snapshot in `_entity`; commands are sent via PostCommand (Petra's
 * AI-side command channel). Metadata accessors rely on the shared script's
 * per-(player, entity) metadata store.
 */
	export class Entity extends Template
	{
/** The raw engine entity snapshot (private `_entity` in entity.js). */
		_entity: EngineAIEntityState;
		constructor(sharedAI: CommonSharedScript, entity: Record<string, unknown>);
/** Live component query straight into the running simulation (SimEngine.QueryInterface of the entity id); the returned object is the raw component interface. */
		queryInterface(iid: string | number): unknown;
/** Debug helper "\<template> (id)" describing the entity briefly. */
		toString(): string;
/** The entity id (INVALID_ENTITY never occurs inside a collection — dead entities are removed). */
		id(): EntityId;
/** Metadata for a player+entity pair from the shared script's metadata cache (undefined unless set). */
		getMetadata<K extends keyof PetraEntityMetadata>(player: PlayerId, key: K): PetraEntityMetadata[K] | undefined;
		getMetadata(player: PlayerId, key: string): unknown;
/** Sets metadata for a player+entity via the shared script (undefined clears a key). */
		setMetadata<K extends keyof PetraEntityMetadata>(player: PlayerId, key: K, value: PetraEntityMetadata[K] | undefined): void;
/** Deletes all metadata of one player+entity pair. */
		deleteAllMetadata(player: PlayerId): void;
/** Deletes one metadata key of a player+entity pair. */
		deleteMetadata(player: PlayerId, key: string): void;
/** World position [x, z]. Entities without a position component (rare, mostly short-lived effects) are not usable here. */
		position(): CommonPosition;
/** Facing angle in radians (built from the position coordinates of the engine direction data). */
		angle(): number | undefined;
/** Whether the entity is currently idle (undefined when it has no UnitAI). */
		isIdle(): boolean | undefined;
/** Current stance name (undefined when it has no UnitAI). */
		getStance(): string | undefined;
/** UnitAI state name (undefined unless the UnitAI is active). */
		unitAIState(): string | undefined;
/** The UnitAI's orders, live (UnitAI.GetOrders: type and data, not the data alone): read them through adapter/orders.ts. */
		unitAIOrderData(): CommonUnitOrder[];
/** Current hitpoints from the snapshot (0 for entities the engine reports none for). */
		hitpoints(): number;
/** Whether the entity is below full health. */
		isHurt(): boolean;
/** Health fraction in (0, 1]. */
		healthLevel(): number;
/** Whether the entity needs healing: isHurt and not unhealable. */
		needsHeal(): boolean;
/** Whether the entity needs repairing: isHurt and repairable. */
		needsRepair(): boolean;
/** Whether the entity's territory decay currently runs (undefined when inapplicable). */
		decaying(): boolean | undefined;
/** Capture points of the entity, as the per-player value list (undefined unless capturable). */
		capturePoints(): number[] | undefined;
/** Whether the entity is invulnerable to further damage (the engine's Invulnerability marker). */
		isInvulnerable(): boolean;
/** Whether this entity is a shared (team-shared) dropsite, i.e. allied players can deposit here. */
		isSharedDropsite(): boolean;
/** Training production queue of a structure as reported by the snapshot (undefined for entities without one). */
		trainingQueue(): CommonTrainingQueueItem[] | undefined;
/** Seconds the head of the training queue needs (undefined for a non-producer). */
		trainingQueueTime(): number | undefined;
/** Completion fraction [0, 1] of a foundation (undefined once built, for fully-built structures). */
		foundationProgress(): number | undefined;
/** Entity ids currently building the structure (undefined unless a foundation). */
		getBuilders(): EntityId[] | undefined;
/** Number of currently paired builders (undefined unless a foundation). */
		getBuildersNb(): number | undefined;
/** Owner player id straight from the snapshot (0 = gaia). */
		owner(): PlayerId;
/** Whether the owner is `player`. */
		isOwn(player: PlayerId): boolean;
/** Amount of the supply remaining (undefined for non-supplies). */
		resourceSupplyAmount(): number | undefined;
/** Number of units currently gathering the supply (undefined for non-supplies). */
		resourceSupplyNumGatherers(): number | undefined;
/** Whether the supply has the maximum simultaneous gatherers (undefined without gatherers). */
		isFull(): boolean | undefined;
/** Carried resources of a gatherer ({class, type, amount} entries; undefined for non-gatherers). */
		resourceCarrying(): Array<{ class?: string; type: string; amount: number }> | undefined;
/** Id of the entity this unit is garrisoned in (undefined unless garrisoned). */
		garrisonHolderID(): EntityId | undefined;
/** Entity ids of the units garrisoned in this holder (empty for empty holder). */
		garrisoned(): EntityId[];
/** Summed garrison slots currently occupied (0 for empty holders). */
		garrisonedSlots(): number;
/** Whether this entity can garrison other entities (garrisoning capacity > 0). */
		canGarrisonInside(): boolean;
/** Whether this entity can damage identity class `aClass`. */
		canAttackClass(aClass: string): boolean;
/** Whether this entity can damage `target` (optional allowCapture vs. unit-only capture weapons). */
		canAttackTarget(target: CommonEntity, allowCapture?: boolean): boolean;
/** Move in formation to (x, z) in world coordinates. */
		move(x: number, z: number, queued?: boolean, pushFront?: boolean): this;
/** Move to the edge of a range band `(min, max)` around (x, z). */
		moveToRange(x: number, z: number, min: number, max: number, queued?: boolean, pushFront?: boolean): this;
/** Attack-move toward (x, z); targetClasses can be a plain class list or the {attack, avoid, vetoEntities} object. */
		attackMove(x: number, z: number, targetClasses: string[] | {
			attack: string[];
			avoid?: string[];
			vetoEntities?: Record<string, boolean>;
		}, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Sets a stance; undefined (with the order swallowed) when the entity has no stance set. */
		setStance(stance: string): this | undefined;
/** Issues a stop order, cancelling the unit's current movement. */
		stopMoving(): void;
/** Orders entity `id` (one unit garrisoned here) out of this holder. */
		unload(id: EntityId): this | undefined;
/** Ejects every garrisoned entity of this holder. */
		unloadAll(): this | undefined;
/** Garrison (move inside) into `target` with optional queue/pushFront handling. */
		garrison(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
		["occupy-turret"](target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Attacks the entity with id `unitId` (a raw entity id, not another wrapper). */
		attack(unitId: EntityId, allowCapture?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Moves to and collects treasure `target`. */
		collectTreasure(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Moves at least `distance` metres away from `point`. */
		moveApart(point: CommonPosition, distance: number): this;
/** Flees from `unitToFleeFrom` to a safe distance outside its attack range. */
		flee(unitToFleeFrom: CommonEntity): this;
/** Move to and gather `target`. */
		gather(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Move to and repair/continue the building `target`. */
		repair(target: CommonEntity, autocontinue?: boolean, queued?: boolean, pushFront?: boolean): this;
/** Move to and deposit the carried resources at `target`. */
		returnResources(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Destroys this entity via the engine "delete-entity" command. */
		destroy(): this;
/** Barter transaction with the market: buys `amount` of `buyType` paying in `sellType`. */
		barter(buyType: string, sellType: string, amount: number): this;
/** Sets up this trader to run goods between `source` and `target` (both markets). */
		tradeRoute(target: CommonEntity, source: CommonEntity): this;
/** Sets the rally point of a producer to `target`. */
		setRallyPoint(target: CommonEntity, command?: string): this;
/** Clears the rally point. */
		unsetRallyPoint(): this;
/** Trains `count` units of `type`, attaching `metadata` to their training batches. */
		train(civ: string, type: string, count: number, metadata?: Partial<PetraEntityMetadata>, pushFront?: boolean): this;
/** Places a building foundation of `template` at (x, z), rotated by `angle`, with this entity as builder. */
		construct(template: string, x: number, z: number, angle: number, metadata?: Partial<PetraEntityMetadata>): this;
/** Starts researching `template` in this structure. */
		research(template: TechName, pushFront?: boolean): this;
/** Cancels the training/research production with queue id `id`. */
		stopProduction(id: number): this;
/** Cancels productions of this structure under `percentToStopAt` completion (returning true when there was no queue). */
		stopAllProduction(percentToStopAt: number): this | true;
/** Orders this unit to guard `target`. */
		guard(target: CommonEntity, queued?: boolean, pushFront?: boolean): this;
/** Releases this unit's current guard assignment. */
		removeGuard(): this;
	}
}

declare module "simulation/ai/common-api/baseAI.js"
{
/**
 * Common base of all per-player AI bot scripts (Petra extends it). baseAI
 * holds references to the shared territory grid and accessibility analyzer
 * (refreshed each turn by HandleMessage) and defines the
 * Init/CustomInit/OnUpdate integration points a concrete AI fills in.
 */
	export class BaseAI
	{
		constructor(settings?: Record<string, unknown>);
/** Player id passed when the AI was instantiated. */
		player: PlayerId;
		/**
		 * The engine's territory grid, handed to the AI as `{width, height, data}`
		 * (CCmpAIManager, EngineScriptConversions). Not an InfoMap: baseAI assigns
		 * `sharedAI.territoryMap` here without wrapping it.
		 */
		territoryMap: CommonGrid<"territory">;
/** Copy of the shared accessibility analyzer (read-only use). */
		accessibility: CommonInfoMap;
/** Shared territory/accessibility references and the per-player GameState (this.ai State for Petra's code paths through gameState.ai). */
		gameState: CommonGameState;
/** Time elapsed at the last turn's update. */
		timeElapsed: GameMs;
/** Serializes the base class state (empty by default; AIs extend it via their own Serialize). */
		Serialize(): Record<string, unknown>;
/** Restores the serialized base state (empty by default; no-op common services). */
		Deserialize(data: Record<string, unknown>, sharedScript: CommonSharedScript): void;
/** Binds this AI to `sharedAI` and `playerID`, copies the territory/accessibility references and creates its GameState; ends in CustomInit. */
		Init(playerID: PlayerId, sharedAI: CommonSharedScript): void;
/** Hook the concrete AI implements to fill its own state (called once at init). */
		CustomInit(gameState: CommonGameState): void;
/** Turn integration point: refreshes PlayerID and the territory grid copy, then calls OnUpdate. */
		HandleMessage(state: Record<string, unknown>, playerID: PlayerId, sharedAI: CommonSharedScript): void;
/** Per-turn drive of the custom AI update. */
		OnUpdate(sharedAI: CommonSharedScript): void;
/** Sends a chat line as this player (through the engine Chat command). */
		chat(message: string): void;
	}
}
