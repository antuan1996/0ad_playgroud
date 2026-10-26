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
import { fake, makeEntity, makeTemplate, type Methods, override } from "./fakes.ts";
import { collectionOf, ENEMY, GAIA, makeWorld, PLAYER, type World, type WorldOptions } from "./world.ts";

import * as apiFilters from "simulation/ai/common-api/filters.js";
import { ResourcesManager } from "simulation/ai/common-api/resources.js";

import { cellIndex, templateName, worldPos } from "../../adapter/brands.ts";
import { requireValue } from "../../adapter/entityExtend.ts";
import type { BaseManager } from "../../decision/baseManager.ts";
import { Config } from "../../decision/config.ts";
import { Headquarters } from "../../decision/headquarters.ts";
import { QueueManager, configuredQueues } from "../../execution/queueManager.ts";

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
	/** the land and sea regions per passability cell, as accessibility holds
	 * them; on the plain the sea map is the land map itself */
	landPassMap: Uint8Array;
	navalPassMap: Uint8Array;
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
		navalPassMap: landPassMap,
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
export function centerOfCell(ix: number, iy: number): WorldPos
{
	return worldPos(TERRITORY_CELL * (ix + 0.5), TERRITORY_CELL * (iy + 0.5));
}

/** A territory cell of the board, by its column and row. */
export function territoryCell(ix: number, iy: number): CellIndex<"territory">
{
	return cellIndex<"territory">({}, ix + iy * MAP_CELLS);
}

/** The territory cell a position falls in, as the territory map rounds it. */
export function territoryCellAt(pos: readonly [number, number] | WorldPos): CellIndex<"territory">
{
	return territoryCell(Math.floor(pos[0] / TERRITORY_CELL), Math.floor(pos[1] / TERRITORY_CELL));
}

/**
 * The real Config, with the emergency factors setConfig computes for MEDIUM
 * difficulty and a fixed personality. Nothing here invents game data; the
 * personality is pinned so tests stay deterministic.
 */
export function makeHQConfig(options: {
	difficulty?: number;
	debug?: number;
	popScaling?: number;
	personality?: Partial<PetraRuntime.Personality>;
} = {}): Config
{
	const config = new Config(options.difficulty ?? 3);
	// setConfig's outcome for difficulty MEDIUM: the entries of
	// factors.criticalRootRatio etc. indexed by 3
	config.emergencyValues = { "population": 0.6, "structures": 0.6, "roots": 0.5 };
	config.personality = {
		"aggressive": 0.4, "defensive": 0.6, "cooperative": 0.5,
		...options.personality
	};
	// what setConfig books at a game start: the cuts that read discontinuous
	// behavior off the personality
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
	/** the population a house adds to the cap (Population/Bonus); default 0, no bonus */
	popBonus?: number;
	/** the units a building trains, with {civ} left for the civ; default none (a non-trainer) */
	trainable?: string[];
	/** whether the building fires arrows at enemies; default no */
	defensiveFire?: boolean;
	/** the gatherers a supply-building feeds (ResourceSupply/MaxGatherers); default 0 */
	maxGatherers?: number;
} = {}): CommonTemplate
{
	const base = makeTemplate(name, detail);
	return fake<CommonTemplate>({
		...base,
		buildPlacementType: () => detail.placement === undefined ? "land" : detail.placement,
		// as common-api Template.getPopulationBonus: zero for a template with no
		// Population node, the declared bonus otherwise
		getPopulationBonus: () => detail.popBonus ?? 0,
		// as common-api Template.trainableEntities: undefined for a building with
		// no Trainer node, the list otherwise
		trainableEntities: (civ: string) => detail.trainable?.map((unit) => unit.replace("{civ}", civ)),
		// as common-api Template.hasDefensiveFire: false without a ranged attack
		hasDefensiveFire: () => detail.defensiveFire ?? false,
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
	});
}

/** An entity as the world makes them, plus the pair of methods the common-api
 * gameState checks on every entity and the manager campaigns never needed. */
export function makeHqEntity(spec: {
	id: number;
	owner: number;
	position?: [number, number] | undefined;
	classes?: string[];
	templateName?: string;
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): CommonEntity
{
	return makeEntity(spec, { ...hqEntityAnswers(spec.owner), ...methods }, metadata);
}

/** What the common-api gameState asks every entity, and the manager campaigns never needed. */
function hqEntityAnswers(owner: number): Methods
{
	return { "isOwn": (player: number) => player === owner, "isTreasure": () => false };
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
}, methods: Methods = {}, metadata: Record<string, unknown> = {}): CommonEntity
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

/** The resources a civil centre takes, as every civil centre template lists them. */
const ALL_RESOURCES = ["food", "wood", "stone", "metal"];

/** The world's civil centre (the seat's anchor), answering as a dropsite for every resource. */
export function dropsiteCC(world: World): CommonEntity
{
	return override(requireValue(world.ents.get(1000)), { "resourceDropsiteTypes": () => [...ALL_RESOURCES] });
}

/**
 * The town's centre as the universal dropsite every civil centre template is,
 * with the map's supplies around it booked into the base's books.
 */
export function bookCentreSupplies(world: World, base: BaseManager): void
{
	override(dropsiteCC(world), {
		// a dropsite is no supply: the common-api answers undefined (entity.js)
		"resourceSupplyType": () => undefined,
		"resourceSupplyNumGatherers": () => undefined,
		"resourceSupplyAmount": () => undefined,
		"isResourceDropsite": (resource?: string) => !resource || ALL_RESOURCES.includes(resource)
	});
	base.assignResourceToDropsite(world.gameState, requireValue(base.anchor), false);
}

/** Lay a sea region map of the test's own over the board. */
export function layNavalPassMap(world: HqWorld, naval: Uint8Array): void
{
	world.map.navalPassMap = naval;
	Object.assign(world.ai.accessibility, { "navalPassMap": naval });
}

/** Extra world-level state the Headquarters tests stop in. */
export interface HqWorldOptions extends MapOptions, WorldOptions
{
	/** resources on hand, as playersData.resourceCounts carries them */
	stock?: Record<string, number>;
	/** the population cap our houses give; default follows populationMax */
	populationLimit?: number;
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
	/** counts the town is queued for, by template (countEntitiesAndQueuedByType) */
	hqKnobs: { queuedTypes: Record<string, number> };
}

/** Build a manager world, then lay the map and the engine answers over it. */
export function makeHqWorld(options: HqWorldOptions = {}): HqWorld
{
	const world = makeWorld(options);
	const map = makeHqMap(options);
	const diplomacyResets: number[] = [];
	const trajectories: Record<string, number[]> = options.trajectories ?? {};
	const disabled = new Set(options.disabledTemplates ?? []);
	// mutable knobs the suites poke: counts the town is queued for by template
	const hqKnobs: HqWorld["hqKnobs"] = { queuedTypes: {} };

	// the seed CC came with the manager world, before this file's entity
	// defaults — give it the same answers (no treasure, its own owner)
	const seedCC = world.ents.get(1000);
	if (seedCC)
		Object.assign(seedCC, hqEntityAnswers(seedCC.owner()));

	// the raw grids, where InfoMap and the map-module functions read them
	Object.assign(world.ai, { "territoryMap": map.territory });
	Object.assign(world.ai.accessibility, {
		landPassMap: map.landPassMap,
		navalPassMap: map.navalPassMap,
		// the passability grid: its width, and the map-module cell of a map position
		width: MAP_CELLS * PASS_RATIO,
		gamePosToMapPos: (p: [number, number]) =>
			[Math.floor(p[0] / (TERRITORY_CELL / PASS_RATIO)), Math.floor(p[1] / (TERRITORY_CELL / PASS_RATIO))],
		regionLinks: options.regionLinks ?? { 2: [2], 3: [3] },
		regionType: options.regionTypes ?? { 2: "land", 3: "land" },
		"getTrajectToIndex": (from: number, to: number) => trajectories[`${from},${to}`] ?? null
	});
	Object.assign(world.gameState.sharedScript, {
		"territoryMap": map.territory,
		"passabilityMap": map.passability,
		"ccResourceMaps": map.ccResourceMaps,
		"resourceMaps": map.resourceMaps,
		"mapSize": MAP_CELLS * TERRITORY_CELL
	});

	// as GameState.prototype.isTemplateDisabled (gamestate.js 943) reads
	// playerData.disabledTemplates: the per-civ disabled-template list the game
	// ships, so a template name mapped to a truthy value is disabled
	const playerData = Object.assign(fake<Record<string, unknown>>(world.gameState.playerData), {
		"disabledTemplates": Object.fromEntries([...disabled].map((name) => [name, true])),
		"isNeutral": [false, false, false, false]
	});
	const diplomacy = fake<{ isEnemy: boolean[]; isNeutral: boolean[]; isMutualAlly: boolean[] }>(playerData);

	const gs = world.gameState;
	const all = () => [...world.ents.values()];
	// as GameState.getOwnEntities and getOwnEntitiesByClass (gamestate.js 488, 583):
	// every entity of ours, units and structures, foundations included
	const ownEntities = () => all().filter((e) => e.owner() === PLAYER);
	const ownFoundations = () => ownEntities().filter((e) => e.foundationProgress() !== undefined);
	const countEntitiesByType = (type: string) => ownEntities().filter((e) => e.templateName() === type).length;
	Object.assign(gs, {
		hqKnobs,
		getPassabilityMap: () => map.passability,
		getPassabilityClassMask: (name: string) =>
		{
			const mask = fake<Record<string, number>>(passMask)[name];
			if (mask === undefined)
				throw new Error(`passability class "${name}" is not defined in tests/harness/hqWorld.ts`);
			return mask;
		},
		circularMap: options.circularMap ?? false,
		// as GameState.prototype.getEnemyStructures (gamestate.js 538): with no
		// owner, the structures of everyone this player's diplomacy calls an
		// enemy; with one, that player's structures
		getEnemyStructures: (owner?: number) => collectionOf(world, world.structures.filter((s) =>
			owner === undefined ? diplomacy.isEnemy[s.owner()] : s.owner() === owner)),
		getNeutralStructures: () => collectionOf(world, world.structures.filter((s) => diplomacy.isNeutral[s.owner()])),
		// as GameState.prototype.getOwnDropsites (gamestate.js 702): the own
		// entities that accept the resource, or any resource when none is named
		getOwnDropsites: (resource?: string) =>
			collectionOf(world, ownEntities().filter((e) => e.isResourceDropsite(resource ?? ""))),
		getExclusiveAllyEntities: () => collectionOf(world, all().filter((e) =>
			diplomacy.isMutualAlly[e.owner()] && e.owner() !== PLAYER)),
		getAlliedVictory: () => options.alliedVictory ?? false,
		getResources: () => new ResourcesManager({ "food": 0, "wood": 0, "stone": 0, "metal": 0, ...options.stock }),
		// as GameState.prototype.getResourceSupplies: the supplies of one resource
		// type, found over the whole world
		getResourceSupplies: (resource: string) =>
			gs.updatingGlobalCollection(`resource-${resource}`, apiFilters.byResource(resource), gs.getEntities()),
		// as GameState.prototype.getHuntableSupplies (gamestate.js 725): the world's
		// cached "resource-hunt" collection — the huntable animals' supplies, with
		// fish and sea-creatures left out (filters.js 217)
		getHuntableSupplies: () => gs.updatingGlobalCollection("resource-hunt", apiFilters.isHuntable(), gs.getEntities()),
		// as GameState.prototype.getFishableSupplies (gamestate.js 730): the world's
		// cached "resource-fish" collection — the still sea-creatures (filters.js 226)
		getFishableSupplies: () => gs.updatingGlobalCollection("resource-fish", apiFilters.isFishable(), gs.getEntities()),
		// the cap our houses give; a town's matching ceiling (populationMax) is a
		// different figure, which the census compares it against
		getPopulationLimit: () => options.populationLimit ?? options.populationMax ?? 400,
		getEntityLimits: () => options.entityLimits ?? {},
		getEntityCounts: () => options.entityCounts ?? {},
		getEntityMatchCounts: () => options.matchCounts ?? {},
		getOwnEntities: () => collectionOf(world, ownEntities()),
		getOwnEntitiesByClass: (cls: string) => collectionOf(world, ownEntities().filter((e) => e.hasClass(cls))),
		getOwnFoundations: () => collectionOf(world, ownFoundations()),
		getOwnFoundationsByClass: (cls: string) => collectionOf(world, ownFoundations().filter((e) => e.hasClass(cls))),
		isTemplateAvailable: (name: string) => !disabled.has(name) && world.templates[name] !== undefined,
		isTemplateDisabled: (name: string) => !!fake<Record<string, unknown>>(playerData["disabledTemplates"])[name],
		isCeasefireActive: () => options.ceasefire !== undefined && options.ceasefire !== false,
		ceasefireTimeRemaining: options.ceasefire === true ? 600 : (options.ceasefire || 0),
		resetOnDiplomacyChanged: () => diplomacyResets.push(world.ai.playedTurn),
		getNumberOfPhases: () => options.numPhases ?? 3,
		getPhaseEntityRequirements: (phase: number) => options.phaseRequirements?.[phase] ?? [],
		// the count of structures our town holds of one type — as the game counts
		// them (by template; foundations carry their final template's name)
		countEntitiesByType,
		// the built form of a foundation: the template its name points at, as the
		// game's foundation names carry the "foundation|" prefix
		getBuiltTemplate: (foundationName: string) =>
			foundationName.startsWith("foundation|") ? world.templates[foundationName.slice("foundation|".length)] ?? null : null,
		// the own entities carrying a metadata value, as the game gathers them for a
		// task keyed by an entity id (a foundation's builders, a repair crew)
		getOwnEntitiesByMetadata: (key: string, value: unknown) =>
			ownEntities().filter((e) => e.getMetadata(PLAYER, key) === value),
		countEntitiesAndQueuedByType: (type: string) => countEntitiesByType(type) + (hqKnobs.queuedTypes[type] ?? 0),
		// as GameState.prototype.findTrainableUnits: every template our own
		// facilities train, filtered by the class rules of the game
		findTrainableUnits: (classes: string[], anticlasses: string[]) =>
		{
			// the training facilities (an own entity whose trainingQueue is
			// truthy), each list of cards
			const allTrainable = new Set(world.structures.filter((s) => s.trainingQueue())
				.flatMap((ent) => ent.trainableEntities("athen") ?? []));
			const limits = gs.getEntityLimits();
			const current = gs.getEntityCounts();
			const matchCounts = gs.getEntityMatchCounts();
			const found: Array<[string, CommonTemplate]> = [];
			for (const trainable of allTrainable)
			{
				if (gs.isTemplateDisabled(templateName(trainable)))
					continue;
				const template = world.templates[trainable];
				if (!template || !template.available(gs))
					continue;
				const limit = template.matchLimit();
				if (limit && matchCounts[trainable] >= limit)
					continue;
				// the class list may nest (a common-api class list carries
				// AND-groups as sub-arrays); MatchesClassList reads both
				if (!template.hasClasses(classes) || template.hasClasses(anticlasses))
					continue;
				// the TrainingRestrictions category, counted like the game counts it
				const category = template.trainingCategory();
				if (category && limits[category] && current[category] >= limits[category])
					continue;
				found.push([trainable, template]);
			}
			return found;
		},
		getTraderTemplatesGains: () =>
		{
			const gains: Record<string, number> = {};
			if (!disabled.has("units/{civ}/support_trader") && world.templates["units/{civ}/support_trader"])
				gains.landGainMultiplier = options.traderGains?.landGainMultiplier ?? 0.7;
			if (!disabled.has("units/{civ}/ship_merchant") && world.templates["units/{civ}/ship_merchant"])
				gains.navalGainMultiplier = options.traderGains?.navalGainMultiplier ?? 0.35;
			return gains;
		}
	});

	return Object.assign(world, { map, trajectories, diplomacyResets, hqKnobs });
}

/**
 * A recorded door: a co-manager out of the suite's walls, whose every call is
 * recorded (`doorCalls`) and whose every field rests at a neutral answer.
 * `extra` carries the fields the code reads without calling.
 */
export function doorStub<T = never>(extra: Record<string, unknown> = {}): T
{
	const calls: Array<[string, unknown[]]> = [];
	const target: Record<string, unknown> = { calls, ...extra };
	return fake<T>(new Proxy(target, {
		get(t, property)
		{
			if (typeof property === "symbol")
				return undefined;
			if (property in t)
				return t[property];
			return (...args: unknown[]) => calls.push([property, args]);
		},
		set(t, property, value)
		{
			t[String(property)] = value;
			return true;
		}
	}));
}

/** The calls recorded on a door stub, oldest first. */
export function doorCalls(stub: object): Array<[string, unknown[]]>
{
	return fake<{ calls: Array<[string, unknown[]]> }>(stub).calls;
}

/**
 * The co-managers a suite usually keeps outside its walls, as recorded doors:
 * naval, trade, research, diplomacy, victory and defense each run their own
 * campaign.
 */
export const doorManagers: readonly string[] = [
	"navalManager", "tradeManager", "researchManager", "diplomacyManager", "victoryManager", "defenseManager"
];

export interface HqSeatOptions
{
	/** the config the HQ is built with; default makeHQConfig() */
	config?: Config;
	/** build it as a deserialized HQ (the constructor takes the flag for its managers) */
	deserialized?: boolean;
	/** the sub-managers to swap for recorded doors */
	stubs?: readonly string[];
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
export function seatHQ(world: HqWorld, options: HqSeatOptions = {}): Headquarters
{
	const config = options.config ?? makeHQConfig();
	// the town's queues, as the bot builds them from the real priorities
	const queues = configuredQueues();
	const queueManager = new QueueManager(config, queues);
	world.ai.queues = queues;
	world.ai.queueManager = queueManager;
	world.ai.Config = config;

	const hq = new Headquarters(config, options.deserialized ?? false);
	world.ai.HQ = hq;

	hq.init(world.gameState, queues);
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

	const managers = fake<Record<string, unknown>>(hq);
	for (const name of options.stubs ?? [])
	{
		// copy the fresh-manager fields per seat: a test that pokes one door
		// (an army raised, a transport fleet) must not leak over the shared
		// record into another seat's fresh manager
		const fields = doorFields[name] ?? {};
		managers[name] = doorStub(Object.fromEntries(Object.entries(fields).map(([field, value]) =>
			[field, Array.isArray(value) ? [...value] : value])));
	}
	return hq;
}
