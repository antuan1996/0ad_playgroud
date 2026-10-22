/**
 * A world a real Headquarters can sit in: a small engine-truthful map (the
 * real InfoMap machinery over tiny territory and passability grids), the
 * town's queues, and resources counted the way the game counts them.
 *
 * The Headquarters class is the module under test. Its sub-managers are its
 * staff: each suite keeps the ones inside its walls real and swaps the ones
 * out of scope for recorded doors (`doorStub`), so a suite never re-runs a
 * manager whose own campaign verifies it.
 *
 * Map conventions (the engine's own numbers, on a small board):
 *  - the territory grid has 8x8-map-unit cells (the engine's territory
 *    cellSize), so one territory cell holds 4x4 passability cells of 2;
 *  - unless a test pokes a tile, every land cell is ours, unaffected by
 *    decay, and open buildable ground (passability bytes hold the bits of
 *    the classes the cell is impassable for, as the engine fills them —
 *    open land `passLand`, water `passWater`, shore strip `passShore`);
 *  - the border ring (engine: 80 map units) is 10 territory cells wide and
 *    marked `border` by the engine's createBorderMap (a square world's
 *    ring tiles still hold unrestricted-passable mini-cells, which is what
 *    upgrades `outside` to `border`);
 *  - the base CC the seat provides sits at [10,10] — inside the border ring,
 *    so CC-placement tests find free interior ground.
 */
import {
	ENEMY, GAIA, makeEntity, makeTemplate, makeWorld, mapOf, PLAYER,
	type FakeEnt, type FakeTemplateLike, type Methods, type World, type WorldOptions
} from "./attackWorld.ts";
import { loadCommonModule, loadPetraModule } from "./target.ts";

/** re-exported so the suites draw every name from one place */
export { ENEMY, GAIA, PLAYER };

/** territory grid: engine constants, on a small board */
export const TERRITORY_CELL = 8;
export const MAP_CELLS = 40;	// territory width; the map is 320x320 map units
export const PASS_RATIO = 4;	// passability cells per territory cell (cellSize 2)

/** passability class bits, the way getPassabilityClassMask answers — a
 * renumbered subset of the engine's alphabetical masks
 * (CCmpPathfinder.cpp assigns bits by class name order). A passability byte
 * stores the bits of the classes the tile is IMPASSABLE for; the engine
 * fills it exactly that way (`if (!passability.IsPassable(...)) t |= mask`,
 * CCmpPathfinder TerrainUpdateHelper), which is what makes the AI's
 * obstruction convention coherent: buildings stand where the building-land
 * bit is clear, createObstructionMap marks such tiles 255 = free, and
 * InfoMap.isObstructedTile treats 0 = blocked. */
export const passMask = {
	"building-land": 0x1,
	"building-shore": 0x2,
	"ship": 0x4,
	"unrestricted": 0x8
} as const;

/** engine-truthful tile bytes for the three grounds a suite distinguishes:
 * open buildable land (no water near: only the shore-capable and ship
 * classes are impassable), deep water, and the shore strip (water within
 * the building-shore reach but deeper than buildings can stand). */
export const passLand = passMask["building-shore"] | passMask["ship"];		// 0x6
export const passWater = passMask["building-land"] | passMask["building-shore"] | passMask["unrestricted"];	// 0xB
export const passShore = passMask["building-land"] | passMask["ship"];		// 0x5

/** the engine grid the InfoMap machinery is built over */
export interface MapGrid
{
	width: number;
	height: number;
	cellSize: number;
	data: Uint8Array;
}

/** what a suite can poke on the map between calls */
export interface HqMap
{
	/** the raw grids, also installed on sharedScript and ai */
	territory: MapGrid;
	passability: MapGrid;
	landPassMap: Uint8Array;
	ccResourceMaps: Record<string, { width: number; length: number; cellSize: number; map: Float32Array }>;
	/** the gather-estimation maps (wood/metal/stone) as HQ.updateResources keeps them */
	resourceMaps: Record<string, { width: number; length: number; cellSize: number; map: Float32Array }>;
	/** set a territory cell's owner (bit-true, keeps the decaying bit) */
	setTerritoryOwner(ix: number, iy: number, owner: number): void;
	/** flag a territory cell as decaying (or not) */
	setBlinking(ix: number, iy: number, blink: boolean): void;
	/** poke a passability cell: bits set where the tile is impassable for
	 * the class (open land `passLand` 0x6, water `passWater` 0xB, shore
	 * strip `passShore` 0x5) */
	setPassData(px: number, pz: number, value: number): void;
	/** move a passability cell to another land region */
	setLandPass(px: number, pz: number, region: number): void;
}

export interface MapOptions
{
	/** the owner of a territory cell; default every cell is ours */
	territoryOwner?: (ix: number, iy: number) => number;
	/** cells whose owner blinks (decay), keyed "ix,iy" */
	blinkingCells?: string[];
	/** the data byte of a passability cell */
	passabilityData?: (px: number, pz: number) => number;
	/** the land region of a passability cell; default region 2 */
	landPassMap?: (px: number, pz: number) => number;
	/** the value every cell of each ccResourceMap carries */
	ccResourceValue?: number;
}

/** Build the map grids a real `createTerritoryMap`/`createBorderMap`/`createObstructionMap` walk over. */
export function makeHqMap(options: MapOptions = {}): HqMap
{
	const passWidth = MAP_CELLS * PASS_RATIO;
	const territory: MapGrid = {
		width: MAP_CELLS,
		height: MAP_CELLS,
		cellSize: TERRITORY_CELL,
		data: new Uint8Array(MAP_CELLS * MAP_CELLS)
	};
	for (let j = 0; j < territory.data.length; ++j)
	{
		const ix = j % MAP_CELLS;
		const iy = Math.floor(j / MAP_CELLS);
		// the engine stores the owner in the low five bits, decay in bit 6
		territory.data[j] = ((options.territoryOwner?.(ix, iy) ?? PLAYER) & 0x1F) |
			(options.blinkingCells?.includes(`${ix},${iy}`) ? 0x40 : 0);
	}
	const passability: MapGrid = {
		width: passWidth,
		height: passWidth,
		cellSize: 2,
		data: new Uint8Array(passWidth * passWidth)
	};
	const landPassMap = new Uint8Array(passWidth * passWidth);
	for (let k = 0; k < passability.data.length; ++k)
	{
		const px = k % passWidth;
		const pz = Math.floor(k / passWidth);
		passability.data[k] = options.passabilityData?.(px, pz) ?? passLand;
		landPassMap[k] = options.landPassMap?.(px, pz) ?? 2;
	}
	// the gather-estimation maps as the influence maps of the game look: one
	// flat value per cell (a test that wants a gradient pokes .map[j])
	const ccResourceValue = options.ccResourceValue ?? 40;
	const ccResourceMaps: HqMap["ccResourceMaps"] = Object.fromEntries(
		["food", "wood", "stone", "metal"].map((res) => [res, {
			width: MAP_CELLS,
			length: MAP_CELLS * MAP_CELLS,
			cellSize: TERRITORY_CELL,
			map: new Float32Array(MAP_CELLS * MAP_CELLS).fill(ccResourceValue)
		}]));
	// the dropsite-estimation maps start flat (nothing recorded yet), as the
	// first turn of a game does before updateResources writes them
	const resourceMaps: HqMap["resourceMaps"] = Object.fromEntries(
		["wood", "stone", "metal"].map((res) => [res, {
			width: MAP_CELLS,
			length: MAP_CELLS * MAP_CELLS,
			cellSize: TERRITORY_CELL,
			map: new Float32Array(MAP_CELLS * MAP_CELLS)
		}]));
	return {
		territory,
		passability,
		landPassMap,
		ccResourceMaps,
		resourceMaps,
		setTerritoryOwner(ix: number, iy: number, owner: number)
		{
			const j = ix + iy * MAP_CELLS;
			territory.data[j] = (territory.data[j] & 0x40) | (owner & 0x1F);
		},
		setBlinking(ix: number, iy: number, blink: boolean)
		{
			const j = ix + iy * MAP_CELLS;
			territory.data[j] = blink ? territory.data[j] | 0x40 : territory.data[j] & ~0x40;
		},
		setPassData(px: number, pz: number, value: number)
		{
			passability.data[px + pz * passWidth] = value;
		},
		setLandPass(px: number, pz: number, region: number)
		{
			landPassMap[px + pz * passWidth] = region;
		}
	};
}

/** The center position of a territory cell, as the code reads back from indices. */
export function centerOfCell(ix: number, iy: number): [number, number]
{
	return [TERRITORY_CELL * (ix + 0.5), TERRITORY_CELL * (iy + 0.5)];
}

/** the passability index a position falls in, as map-module rounds it */
export function passIndexAt(pos: [number, number]): number
{
	const px = Math.min(MAP_CELLS * PASS_RATIO - 1, Math.floor(pos[0] / 2));
	const pz = Math.min(MAP_CELLS * PASS_RATIO - 1, Math.floor(pos[1] / 2));
	return px + pz * MAP_CELLS * PASS_RATIO;
}

const { Headquarters } = await loadPetraModule<{
	Headquarters: new (config: unknown, deserialized?: boolean) => HqInstance;
}>("headquarters");
const { Config } = await loadPetraModule<{ Config: new (difficulty?: number) => unknown; }>("config");
const { QueueManager } = await loadPetraModule<{
	QueueManager: new (config: unknown, queues: Record<string, unknown>) => {
		addQueue(name: string, priority: number): void;
		getPriority(name: string): number;
		changePriority(name: string, priority: number, metadata: unknown): void;
		[key: string]: unknown;
	};
}>("queueManager");
const EntityCollection = (await loadCommonModule<{
	EntityCollection: new (sharedAI: unknown, ents?: Map<number, FakeEnt>, filters?: unknown[]) => unknown;
}>("entitycollection")).EntityCollection;
const ResourcesManager = (await loadCommonModule<{
	ResourcesManager: new (amounts?: Record<string, number>) =>
		Record<string, number> & { canAfford(that: unknown): boolean; subtract(that: unknown): void };
}>("resources")).ResourcesManager;
const apiFilters = await loadCommonModule<{
	byResource(resourceType: string): { func: (ent: FakeEnt) => boolean };
}>("filters");

export type HqConfig = Record<string, any>;

/**
 * The real Config, with the emergency factors setConfig computes for MEDIUM
 * difficulty and a fixed personality. Nothing here invents game data; the
 * personality is pinned so tests stay deterministic.
 */
export function makeHQConfig(options: {
	difficulty?: number;
	debug?: number;
	popScaling?: number;
	personality?: Partial<{ aggressive: number; defensive: number; cooperative: number; military: number }>;
} = {}): HqConfig
{
	const config = new Config(options.difficulty ?? 3) as HqConfig;
	// setConfig's outcome for difficulty MEDIUM: the entries of
	// factors.criticalRootRatio etc. indexed by 3
	config.emergencyValues = { "population": 0.6, "structures": 0.6, "roots": 0.5 };
	config.personality = {
		"aggressive": 0.4, "defensive": 0.6, "cooperative": 0.5, "military": 0.5,
		...options.personality
	};
	// what setConfig books at a game start: the cuts that read discontinuous
	// behavior off the personality. (The port's Config shoulders the cuts as
	// a class field; the ref only creates them inside setConfig, so a
	// production seat — and this harness — must have them set.)
	config.personalityCut = { "weak": 0.3, "medium": 0.5, "strong": 0.7 };
	if (options.debug !== undefined)
		config.debug = options.debug;
	if (options.popScaling !== undefined)
		config.popScaling = options.popScaling;
	return config;
}

/** A template as the buildings HQ judges need: the placement surface added. */
export function structureTemplate(name: string, detail: {
	classes?: string[];
	cost?: Record<string, number>;
	popCost?: number;
	getPaths?: Record<string, unknown>;
	available?: boolean;
	/** the buildPlacementType answer; default "land" */
	placement?: string | undefined;
	/** the build territories; default [own], as the engine's
	 * template_structure.xml declares (<BuildRestrictions><Territory>own) */
	territories?: string[];
	/** the build distance rule (FromClass/MinDistance walked by the template get) */
	buildDistance?: { MinDistance?: number; FromClass?: string } | undefined;
	/** the physical size, as the game returns {min, max}; default 1..2 */
	obstruction?: { min: number; max: number };
	/** the cost category m_entityCounts is indexed with */
	buildCategory?: string | undefined;
	/** the resources a dropsite template accepts; default no dropsite tag */
	dropsiteTypes?: string[];
} = {}): FakeTemplateLike
{
	const base = makeTemplate(name, detail);
	return {
		...base,
		buildPlacementType: () => detail.placement === undefined ? "land" : detail.placement,
		// hasBuildTerritory is the common-api read of BuildRestrictions/Territory
		// (entity.js 501): undefined when the node is missing, otherwise a
		// membership test on the declared list. Every buildable structure
		// carries template_structure's <Territory>own</Territory>, so the
		// default mirrors that; createObstructionMap consumes the four
		// answers directly.
		hasBuildTerritory: (territory: string) =>
			(detail.territories ?? ["own"]).includes(territory),
		territoryList: () => detail.territories,
		// as the common-api Template.buildTerritories (entity.js 493): the raw
		// BuildRestrictions/Territory list. The `territories` option is the
		// template's declared leaf — every real structure inherits
		// template_structure.xml's <Territory>own</Territory> when its own
		// declares nothing — so the default mirrors that (canBuild's
		// no-active-base branch reads this exact answer).
		buildTerritories: (): string[] => detail.territories ? [...detail.territories] : ["own"],
		buildDistance: () => detail.buildDistance,
		obstructionRadius: () => detail.obstruction ?? { "min": 1, "max": 2 },
		buildCategory: () => detail.buildCategory,
		trainingCategory: () => undefined,
		matchLimit: () => undefined,
		// as the common-api Entity asks of a template: a dropsite lists the
		// resources it accepts, a non-dropsite none
		resourceDropsiteTypes: () => detail.dropsiteTypes,
		isResourceDropsite: (resource: string) =>
			detail.dropsiteTypes !== undefined && (!resource || detail.dropsiteTypes.includes(resource))
	} as unknown as FakeTemplateLike;
}

/** An entity as the world makes them, plus the pair of methods the common-api
 * gameState checks on every entity and the manager campaigns never needed. */
export function makeHqEntity(spec: {
	id: number;
	owner: number;
	position?: [number, number] | undefined;
	classes?: string[];
	templateName?: string;
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): FakeEnt
{
	const ent = makeEntity(spec, methods, metadata) as FakeEnt & Record<string, (...args: any[]) => unknown>;
	if (!("isOwn" in methods))
		ent.isOwn = (player: number) => player === ent.owner();
	if (!("isTreasure" in methods))
		ent.isTreasure = () => false;
	return ent;
}

/**
 * A gaia resource the map places: a tree, a berry bush, a stone mine.
 *
 * The common-api reads template leaves as strings, so the game's own
 * `isHuntable()` (ResourceSupply/KillBeforeGather is the truthy string
 * "false", and neither Health nor Attack is present) answers true for trees
 * and bushes; the fixture answers what the game answers.
 */
export function makeGaiaSupply(spec: {
	id: number;
	position: [number, number];
	/** the supply's generic type: "wood", "food", "stone" … */
	generic: string;
	/** the supply's specific type, e.g. "tree"; default the generic */
	specific?: string;
	classes?: string[];
	/** the remaining amount; the map places full stocks, default 1000 */
	amount?: number;
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): FakeEnt
{
	return makeHqEntity({
		id: spec.id,
		owner: GAIA,
		position: spec.position,
		classes: spec.classes ?? [],
	}, {
		resourceSupplyType: () => ({ "generic": spec.generic, "specific": spec.specific ?? spec.generic }),
		resourceSupplyMax: () => spec.amount ?? 1000,
		resourceSupplyAmount: () => spec.amount ?? 1000,
		// the common-api's own answer for non-animal supplies (see docstring)
		isHuntable: () => true,
		...methods,
	}, metadata);
}

/** Extra world-level state the Headquarters tests stop in. */
export interface HqWorldOptions extends MapOptions, WorldOptions
{
	/** resources on hand, as playersData.resourceCounts carries them */
	stock?: Record<string, number>;
	/** the class-threshold tables canBuild consults */
	entityLimits?: Record<string, number>;
	entityCounts?: Record<string, number>;
	matchCounts?: Record<string, number>;
	/** the disabled-template list the game ships per civ */
	disabledTemplates?: string[];
	/** what a template's gainMultiplier is worth (trader gains) */
	traderGains?: { landGainMultiplier?: number; navalGainMultiplier?: number };
	/** whether the ceasefire is active (and for how long) */
	ceasefire?: boolean | number;
	/** the phase-entity requirements per phase, keyed by phase number */
	phaseRequirements?: Record<number, { class: string; count: number }[]>;
	/** the phases the game declares; default 3 */
	numPhases?: number;
	/** whether victory is shared with allies; default false */
	alliedVictory?: boolean;
	/** whether the map is round; default square */
	circularMap?: boolean;
	/** trajectories getTrajectToIndex answers, keyed "from,to" */
	trajectories?: Record<string, number[]>;
	/** region types, keyed by region; default every region "land" */
	regionTypes?: Record<number, string>;
	/** region links, keyed by region */
	regionLinks?: Record<number, number[]>;
}

export interface HqWorld extends World
{
	map: HqMap;
	/** the trajectories getTrajectToIndex answers, keyed "from,to" — a suite sets them */
	trajectories: Record<string, number[]>;
	/** the resets gameState.resetOnDiplomacyChanged recorded */
	diplomacyResets: number[];
}

/** Build a manager world, then lay the map and the engine answers over it. */
export function makeHqWorld(options: HqWorldOptions = {}): HqWorld
{
	const world = makeWorld(options) as UnknownWorld;
	const map = makeHqMap(options);
	const diplomacyResets: number[] = [];
	const trajectories: Record<string, number[]> = options.trajectories ?? {};
	const disabled = new Set(options.disabledTemplates ?? []);
	// mutable knobs the suites poke: counts the town is queued for by template
	const hqKnobs: { queuedTypes: Record<string, number> } = { queuedTypes: {} };

	// the seed CC came with the manager world, before this file's entity
	// defaults — give it the same answers (no treasure, its own owner)
	const seedCC = world.ents.get(1000) as FakeEnt & Record<string, (...args: any[]) => unknown> | undefined;
	if (seedCC)
	{
		seedCC.isTreasure = () => false;
		seedCC.isOwn = (player: number) => player === seedCC.owner();
	}

	// the raw grids, where InfoMap and the map-module functions read them
	Object.assign(world.ai as unknown as Record<string, unknown>, { "territoryMap": map.territory });
	Object.assign(world.ai.accessibility, {
		landPassMap: map.landPassMap,
		navalPassMap: map.landPassMap,
		regionLinks: options.regionLinks ?? { 2: [2], 3: [3] },
		regionType: options.regionTypes ?? { 2: "land", 3: "land" },
		"getTrajectToIndex": (from: number, to: number) => trajectories[`${from},${to}`] ?? null
	});
	Object.assign(world.gameState.sharedScript as unknown as Record<string, unknown>, {
		"territoryMap": map.territory,
		"passabilityMap": map.passability,
		"ccResourceMaps": map.ccResourceMaps,
		"resourceMaps": map.resourceMaps,
		"mapSize": MAP_CELLS * TERRITORY_CELL
	});

	const gs = world.gameState as unknown as Record<string, unknown>;
	gs.getPassabilityMap = () => map.passability;
	gs.getPassabilityClassMask = (name: string) =>
	{
		const mask = (passMask as Record<string, number>)[name];
		if (mask === undefined)
			throw new Error(`passability class "${name}" is not defined in tests/harness/hqWorld.ts`);
		return mask;
	};
	gs.circularMap = options.circularMap ?? false;
	// as GameState.prototype.getEnemyStructures (gamestate.js 538): with no
	// owner, the structures of everyone this player's diplomacy calls an
	// enemy; with one, that player's structures
	gs.getEnemyStructures = (owner?: number) =>
	{
		void owner;
		return new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
			world.gameState.sharedScript,
			mapOf(world.structures.filter((s) =>
				(world.gameState.playerData as { isEnemy: boolean[] }).isEnemy[s.owner()])));
	};
	gs.getNeutralStructures = () => new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
		world.gameState.sharedScript,
		mapOf(world.structures.filter((s) =>
			(world.gameState.playerData as { isNeutral: boolean[] }).isNeutral[s.owner()])));
	// as GameState.prototype.getOwnDropsites (gamestate.js 702): the own
	// entities that accept the resource, or any resource when none is named
	gs.getOwnDropsites = (resource?: string) =>
	{
		const owns = [...world.ents.values()].filter((e) => e.owner() === PLAYER &&
			(e.isResourceDropsite ? e.isResourceDropsite(resource ?? "") : false));
		return new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
			world.gameState.sharedScript, mapOf(owns));
	};
	gs.getExclusiveAllyEntities = () => new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
		world.gameState.sharedScript,
		mapOf([...world.ents.values()].filter((e) =>
			(world.gameState.playerData as { isMutualAlly: boolean[] }).isMutualAlly[e.owner()] && e.owner() !== PLAYER)));
	gs.getAlliedVictory = () => options.alliedVictory ?? false;
	gs.getResources = () => new (ResourcesManager as new (amounts?: Record<string, number>) => unknown)({
		"food": 0, "wood": 0, "stone": 0, "metal": 0, ...options.stock } as Record<string, number>);
	// as GameState.prototype.getResourceSupplies: the supplies of one resource
	// type, found over the whole world
	gs.getResourceSupplies = (resource: string) =>
		(gs.updatingGlobalCollection as (key: string, filter: unknown, collection: unknown) => unknown)(
			`resource-${resource}`, apiFilters.byResource(resource), (gs.getEntities as () => unknown)());
	gs.getPopulationLimit = () => options.populationMax ?? 400;
	gs.getEntityLimits = () => options.entityLimits ?? {};
	gs.getEntityCounts = () => options.entityCounts ?? {};
	gs.getEntityMatchCounts = () => options.matchCounts ?? {};
	gs.getOwnFoundations = () => new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
		world.gameState.sharedScript,
		mapOf([...world.ents.values()].filter((e) =>
			e.owner() === PLAYER && e.foundationProgress() !== undefined)));
	gs.getOwnFoundationsByClass = (cls: string) => new (EntityCollection as new (ai: unknown, ents?: Map<number, FakeEnt>) => unknown)(
		world.gameState.sharedScript,
		mapOf([...world.ents.values()].filter((e) =>
			e.owner() === PLAYER && e.foundationProgress() !== undefined && e.hasClass(cls))));
	gs.isTemplateAvailable = (name: string) => !disabled.has(name) && world.templates[name] !== undefined;
	// as GameState.prototype.isTemplateDisabled (gamestate.js 943) reads
	// playerData.disabledTemplates: the per-civ disabled-template list the game
	// ships, so a template name mapped to a truthy value is disabled
	(world.gameState.playerData as Record<string, unknown>).disabledTemplates =
		Object.fromEntries([...disabled].map((name: string) => [name, true]));
	gs.isTemplateDisabled = (name: string) =>
		!!((world.gameState.playerData as { disabledTemplates: Record<string, unknown> })
			.disabledTemplates[name]);
	gs.isCeasefireActive = () => options.ceasefire !== undefined && options.ceasefire !== false;
	gs.ceasefireTimeRemaining = options.ceasefire === true ? 600 : (options.ceasefire ?? 0);
	gs.resetOnDiplomacyChanged = () => diplomacyResets.push(world.ai.playedTurn);
	gs.getNumberOfPhases = () => options.numPhases ?? 3;
	gs.getPhaseEntityRequirements = (phase: number) => options.phaseRequirements?.[phase] ?? [];
	// the count of structures our town holds of one type — as the game counts
	// them (by template; foundations carry their final template's name)
	gs.countEntitiesByType = (type: string) =>
		[...world.ents.values()].filter((e) => e.owner() === PLAYER && e.templateName() === type).length;
	gs.countEntitiesAndQueuedByType = (type: string) => (gs.countEntitiesByType as (t: string) => number)(type) +
		(hqKnobs.queuedTypes[type] ?? 0);
	gs.hqKnobs = hqKnobs;
	// as GameState.prototype.findTrainableUnits: every template our own
	// facilities train, filtered by the class rules of the game
	gs.findTrainableUnits = (classes: Array<string | string[]>, anticlasses: string[]) =>
	{
		const allTrainable: string[] = [];
		// as GameState.prototype.findTrainableUnits: the training facilities
		// (an own entity whose trainingQueue is truthy), each list of cards
		for (const ent of world.structures.filter((s) =>
			((s as unknown as Record<string, (player: number) => unknown>).trainingQueue)(PLAYER)))
			for (const trainable of (ent.trainableEntities as (civ: string) => string[] | undefined)("athen") ?? [])
				if (!allTrainable.includes(trainable))
					allTrainable.push(trainable);
		const found: Array<[string, FakeTemplateLike]> = [];
		const limits = (gs.getEntityLimits as unknown as () =>
			Record<string, number>)();
		const current = (gs.getEntityCounts as unknown as () =>
			Record<string, number>)();
		const matchCounts = (gs.getEntityMatchCounts as unknown as () =>
			Record<string, number> | undefined)();
		for (const trainable of allTrainable)
		{
			if (world.gameState.isTemplateDisabled(trainable))
				continue;
			const template = world.templates[trainable];
			if (!template || !template.available(world.gameState))
				continue;
			const limit = template.matchLimit();
			if (matchCounts && limit && matchCounts[trainable] >= limit)
				continue;
			// the class list may nest (a common-api class list carries
			// AND-groups as sub-arrays); MatchesClassList reads both
			if (!template.hasClasses(classes as string[]) || template.hasClasses(anticlasses))
				continue;
			// the TrainingRestrictions category, counted like the game counts it
			const category = template.trainingCategory();
			if (category && limits[category] && current[category] >= limits[category])
				continue;
			found.push([trainable, template]);
		}
		return found;
	};
	gs.getTraderTemplatesGains = () =>
	{
		const shipMerchant = disabled.has("units/{civ}/ship_merchant") ? undefined :
			world.templates["units/{civ}/ship_merchant"];
		const supportTrader = disabled.has("units/{civ}/support_trader") ? undefined :
			world.templates["units/{civ}/support_trader"];
		const ret: Record<string, number> = {};
		if (supportTrader)
			ret.landGainMultiplier = (options.traderGains?.landGainMultiplier ?? 0.7);
		if (shipMerchant)
			ret.navalGainMultiplier = (options.traderGains?.navalGainMultiplier ?? 0.35);
		return ret;
	};
	(world.gameState.playerData as Record<string, unknown>).isNeutral = [false, false, false, false];

	const hqWorld = world as unknown as HqWorld;
	hqWorld.map = map;
	hqWorld.trajectories = trajectories;
	hqWorld.diplomacyResets = diplomacyResets;
	return hqWorld;
}

type UnknownWorld = World & {
	ai: World["ai"] & {
		accessibility: World["ai"]["accessibility"] & {
			landPassMap: Uint8Array; navalPassMap: Uint8Array;
			regionLinks: Record<number, number[]>; regionType: Record<number, string>;
			getTrajectToIndex(from: number, to: number): number[] | null;
		};
	};
	gameState: CommonGameState & {
		sharedScript: Record<string, unknown>;
		playerData: Record<string, unknown>;
		hqKnobs: Record<string, unknown>;
	};
};

/**
 * A recorded door: a co-manager out of the suite's walls, whose every call is
 * written to `<name>Calls` and whose every field rests at a neutral answer.
 * `extra` carries the fields the code reads without calling.
 */
export function doorStub(name: string, extra: Record<string, unknown> = {}): never
{
	const calls: Array<[string, unknown[]]> = [];
	const target = { calls, ...extra } as Record<string, unknown>;
	return new Proxy(target, {
		get(t, property)
		{
			if (typeof property === "symbol")
				return undefined;
			if (property in t)
				return t[String(property)];
			return (...args: unknown[]) => calls.push([`${String(property)}`, args]);
		},
		set(t, property, value)
		{
			t[String(property)] = value;
			return true;
		}
	}) as never;
}

/** The calls recorded on a door stub, oldest first. */
export function doorCalls(stub: never): Array<[string, unknown[]]>
{
	return (stub as unknown as { calls: Array<[string, unknown[]]> }).calls;
}

/** What a Headquarters instance looks like to its suites. */
export interface HqInstance extends Record<string, any>
{
	Config: HqConfig;
	landRegions: Record<number, boolean>;
	navalMap: boolean;
	navalRegions: Record<number, boolean>;
	currentPhase: number;
	maxFields: boolean | number;
	basesManager: Record<string, any>;
	attackManager: Record<string, any>;
	buildManager: Record<string, any>;
	defenseManager: Record<string, any>;
	tradeManager: Record<string, any>;
	navalManager: Record<string, any>;
	researchManager: Record<string, any>;
	diplomacyManager: Record<string, any>;
	garrisonManager: Record<string, any>;
	victoryManager: Record<string, any>;
	emergencyManager: Record<string, any>;
	capturableTargets: Map<number, Record<string, unknown>>;
	decayingStructures: Set<number>;
	treasures: unknown;
	territoryMap: Record<string, any>;
	borderMap: Record<string, any>;
	[key: string]: any;
}

export interface HqSeatOptions
{
	/** the config the HQ is built with; default makeHQConfig() */
	config?: HqConfig;
	/** build it as a deserialized HQ (the constructor takes the flag for its managers) */
	deserialized?: boolean;
	/** the sub-managers to swap for recorded doors */
	stubs?: string[];
	/** seat the real BasesManager on the world's CC; default true (gameAnalysis does) */
	seatBases?: boolean;
	/** land/naval regions, as regionAnalysis would fill; defaults land region 2, no navy */
	landRegions?: Record<number, boolean>;
	navalMap?: boolean;
	navalRegions?: Record<number, boolean>;
}

/** Fields HQ reads without calling on a co-manager; a door holds the
 * fresh-manager answers (an unfilled field would come back as a recording
 * function, whose truthiness or arity would silently flip a branch).
 * Keyed by manager name. */
const doorFields: Record<string, Record<string, unknown>> = {
	// a fresh DefenseManager has raised no armies yet
	"defenseManager": { "armies": [] },
	// a fresh NavalManager has no transports (find*Location counts them)
	"navalManager": { "transportShips": [] },
	// a fresh TradeManager books its minimal gain from navalMap
	"tradeManager": { "minimalGain": 5 }
};

/**
 * Build a real Headquarters over the world: construct it, run the module's
 * own init, seat the real BasesManager on the world's CC the way
 * regionAnalysis/gameAnalysis do, then fill what they would fill (the land
 * and naval regions) with test-shaped answers.
 */
export function seatHQ(world: HqWorld, options: HqSeatOptions = {}): HqInstance
{
	const config = options.config ?? makeHQConfig();
	// the town's queues, as queueManager builds them from the real priorities
	const queues: Record<string, unknown> = {};
	const queueManager = new QueueManager(config, queues) as unknown as {
		addQueue(name: string, priority: number): void;
	};
	for (const [name, priority] of Object.entries((config as Record<string, Record<string, number>>).priorities))
		queueManager.addQueue(name, priority);
	world.ai.queues = queues as World["ai"]["queues"];
	world.ai.queueManager = queueManager as unknown as World["ai"]["queueManager"];
	world.ai.Config = config as World["ai"]["Config"];

	const hq = new Headquarters(config, options.deserialized ?? false) as HqInstance;
	world.ai.HQ = hq as unknown as World["ai"]["HQ"];

	hq.init(world.gameState, world.ai.queues as never);
	if (options.seatBases ?? true)
		hq.basesManager.init(world.gameState);

	// what regionAnalysis fills before the first update of a game
	hq.landRegions = options.landRegions ?? { 2: true };
	hq.navalMap = options.navalMap ?? false;
	hq.navalRegions = options.navalRegions ?? {};
	// what gameAnalysis bookends the seat with: the AI explores and builds
	// unless a test disables it
	hq.canBuildUnits = true;
	hq.canExpand = true;

	for (const name of options.stubs ?? [])
	{
		// copy the fresh-manager fields per seat: a test that pokes one door
		// (an army raised, a transport fleet) must not leak over the shared
		// record into another seat's fresh manager
		const fields = doorFields[name] ?? {};
		const extra = Object.fromEntries(Object.entries(fields).map(([field, value]) =>
			[field, Array.isArray(value) ? [...(value as unknown[])] : value]));
		const stub = doorStub(name, extra);
		hq[name] = stub;
		hq[name + "Calls"] = doorCalls(stub as never);
	}
	return hq;
}
