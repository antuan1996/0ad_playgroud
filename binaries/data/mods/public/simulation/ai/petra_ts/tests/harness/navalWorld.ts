/**
 * The board the naval suites play on: our land, a sea, and an island across
 * it, with the ships and soldiers a transport moves.
 *
 *   x <  160   land region 2 (WEST), ours
 *   x >= 160   the sea, region 5 (SEA)
 *   x >= 240   land region 3 (ISLAND)
 *
 * The strips 152 <= x < 160 and 240 <= x < 248 are shallows: both a land
 * region and the sea, as the engine's passability grids overlap at a shore.
 * The naval manager's landing zones are made of exactly those cells. As in the
 * engine's accessibility analysis, a cell that is no land (or no sea) carries
 * region 1 on that grid, never 0. With `island: false` the sea runs to the
 * map's east edge.
 *
 * Two engine behaviours the transport code relies on are mirrored here,
 * because the shared fakes do not need them elsewhere:
 * - SharedScript.setMetadata pushes every metadata change into the updating
 *   entity collections that filter on it (a plan's units are "the units whose
 *   transport is this plan");
 * - SharedScript.ApplyEntitiesDelta puts a new entity into every updating
 *   collection whose filters it passes.
 */
import {
	makeHqEntity, makeHqWorld, seatHQ, MAP_CELLS, PASS_RATIO, PLAYER, passLand, passShore, passWater,
	type HqInstance, type HqWorld, type HqWorldOptions
} from "./hqWorld.ts";
import type { FakeEnt, Methods } from "./attackWorld.ts";

export const WEST = 2;
export const ISLAND = 3;
export const SEA = 5;

const WIDTH = MAP_CELLS * PASS_RATIO;	// passability cells across, 2 map units each
const SHORE_WEST = 76;	// first shallow cell of our coast
const SEA_START = 80;
const ISLAND_START = 120;
const SHORE_ISLAND = 124;	// first island cell past the shallows

/** the land region of a passability column (1: no land there) */
function landOf(px: number, island: boolean): number
{
	if (px < SEA_START)
		return WEST;
	if (island && px >= ISLAND_START)
		return ISLAND;
	return 1;
}

/** the sea region of a passability column: the water and both shallows (1: no sea there) */
function seaOf(px: number, island: boolean): number
{
	return px >= SHORE_WEST && (!island || px < SHORE_ISLAND) ? SEA : 1;
}

interface Collection
{
	dynamicProperties(): string[];
	updateEnt(ent: FakeEnt): unknown;
}

export interface NavalWorld
{
	world: HqWorld;
	hq: HqInstance;
}

/**
 * Seat an office on the naval board. The naval manager is the real one; its
 * init is left to the suite, as the game leaves it to the opening strategy,
 * so the ships and docks of the opening can be placed first.
 */
export function navalWorld(options: {
	island?: boolean;
	worldOptions?: Partial<HqWorldOptions>;
	stubs?: string[];
} = {}): NavalWorld
{
	const island = options.island ?? true;
	const stubs = options.stubs ??
		["tradeManager", "researchManager", "diplomacyManager", "victoryManager", "defenseManager", "attackManager"];
	const land = (px: number) => landOf(px, island);
	const sea = (px: number) => seaOf(px, island);
	const world = makeHqWorld({
		"landPassMap": land,
		"passabilityData": (px: number) => sea(px) > 1 && land(px) > 1 ? passShore : land(px) > 1 ? passLand : passWater,
		"regionTypes": { [WEST]: "land", [ISLAND]: "land", [SEA]: "water" },
		"regionLinks": { [WEST]: [SEA], [ISLAND]: [SEA], [SEA]: [WEST, ISLAND] },
		"trajectories": { "2,3": [WEST, SEA, ISLAND], "3,2": [ISLAND, SEA, WEST] },
		...options.worldOptions
	} as HqWorldOptions);

	const naval = new Uint8Array(WIDTH * WIDTH);
	for (let k = 0; k < naval.length; ++k)
		naval[k] = sea(k % WIDTH);
	const access = world.ai.accessibility as unknown as {
		landPassMap: Uint8Array; gamePosToMapPos(p: [number, number]): [number, number];
	};
	Object.assign(world.ai.accessibility as Record<string, unknown>, {
		"navalPassMap": naval,
		"height": WIDTH,
		// map units per passability cell, as the accessibility map's cellSize
		"cellSize": 2,
		// the engine's per-region sizes: an array indexed by region
		"regionSize": [0, 0, 20000, 20000, 0, 20000],
		// as Accessibility.getAccessValue: the land (or, onWater, the sea) region under a position
		"getAccessValue": (pos: [number, number], onWater?: boolean) =>
		{
			const [px, pz] = access.gamePosToMapPos(pos);
			if (px < 0 || px >= WIDTH || pz < 0 || pz >= WIDTH)
				return 0;
			return onWater ? naval[px + pz * WIDTH] : access.landPassMap[px + pz * WIDTH];
		}
	});
	(world.ai.uniqueIDs as Record<string, number>).transports = 1;

	// the updating collections, as the shared script keeps them
	const shared = world.gameState.sharedScript as unknown as {
		registerUpdatingEntityCollection(c: Collection): void;
	};
	const registered: Collection[] = [];
	const register = shared.registerUpdatingEntityCollection.bind(shared);
	shared.registerUpdatingEntityCollection = (collection: Collection) =>
	{
		register(collection);
		registered.push(collection);
	};
	const addEntity = world.addEntity.bind(world);
	world.addEntity = (ent: FakeEnt) =>
	{
		addEntity(ent);
		const setMetadata = ent.setMetadata.bind(ent);
		(ent as unknown as { setMetadata: typeof setMetadata }).setMetadata = (player: number, key: string, value: unknown) =>
		{
			setMetadata(player, key, value);
			for (const collection of registered)
				if (collection.dynamicProperties().some((p) => p === "metadata" || p === "metadata." + key))
					collection.updateEnt(ent);
		};
		for (const collection of registered)
			collection.updateEnt(ent);
		return ent;
	};

	const hq = seatHQ(world, {
		stubs,
		"landRegions": { [WEST]: true, [ISLAND]: true },
		"navalMap": true,
		"navalRegions": { [SEA]: true }
	});
	hq.updateTerritories(world.gameState);
	return { world, hq };
}

/** what a ship has been told and holds, for the suite to read and to move */
export interface ShipState
{
	pos: [number, number] | undefined;
	garrisoned: number[];
	moves: Array<[number, number]>;
	moveApart: Array<[number, number]>;
	unloaded: number[];
	stance: string;
	aiState: string;
	idle: boolean;
}

/** a ship of ours at sea; a transport (a warship with room aboard) unless told otherwise */
export function ship(world: HqWorld, id: number, position: [number, number] | undefined,
	options: { capacity?: number; classes?: string[]; methods?: Methods; metadata?: Record<string, unknown>; owner?: number } = {})
{
	const state: ShipState = {
		"pos": position, "garrisoned": [], "moves": [], "moveApart": [], "unloaded": [],
		"stance": "aggressive", "aiState": "INDIVIDUAL.IDLE", "idle": true
	};
	const ent = world.addEntity(makeHqEntity({
		id, "owner": options.owner ?? PLAYER, position,
		"classes": options.classes ?? ["Unit", "Ship", "Warship"], "templateName": "units/athen/ship_bireme"
	}, {
		"position": () => state.pos ? [...state.pos] : undefined,
		"garrisonMax": () => options.capacity ?? 20,
		"garrisoned": () => state.garrisoned,
		"isGarrisonHolder": () => true,
		"canGarrison": () => false,
		"move": (x: number, z: number) => state.moves.push([x, z]),
		"moveApart": (pos: [number, number]) => state.moveApart.push(pos),
		"setStance": (stance: string) => { state.stance = stance; },
		"getStance": () => state.stance,
		// as the template's UnitAI/DefaultStance
		"get": (path: string) => path === "UnitAI/DefaultStance" ? "aggressive" : undefined,
		"unload": (entId: number) => state.unloaded.push(entId),
		"unitAIState": () => state.aiState,
		"isIdle": () => state.idle,
		...options.methods
	}, options.metadata ?? {}));
	return { ent, state };
}

/** what a soldier has been told, and where it stands (undefined while aboard) */
export interface UnitState
{
	pos: [number, number] | undefined;
	garrisons: Array<[number, boolean | undefined]>;
	ranges: Array<[number, number, number, number]>;
	stops: number;
	destroyed: boolean;
}

/** a soldier of ours on land */
export function soldier(world: HqWorld, id: number, position: [number, number] | undefined,
	metadata: Record<string, unknown> = {}, methods: Methods = {})
{
	const state: UnitState = { "pos": position, "garrisons": [], "ranges": [], "stops": 0, "destroyed": false };
	const ent = world.addEntity(makeHqEntity({
		id, "owner": PLAYER, position, "classes": ["Unit", "Infantry", "Soldier", "Melee"],
		"templateName": "units/athen/infantry_spearman_b"
	}, {
		"position": () => state.pos ? [...state.pos] : undefined,
		"canGarrison": () => true,
		"garrison": (target: FakeEnt, queued?: boolean) => state.garrisons.push([target.id(), queued]),
		"moveToRange": (x: number, z: number, min: number, max: number) => state.ranges.push([x, z, min, max]),
		"stopMoving": () => { ++state.stops; },
		"destroy": () => { state.destroyed = true; },
		...methods
	}, metadata));
	return { ent, state };
}

/** the engine garrisons the soldier in the ship: it leaves the map */
export function board(unit: { ent: FakeEnt; state: UnitState }, carrier: { state: ShipState }): void
{
	unit.state.pos = undefined;
	carrier.state.garrisoned.push(unit.ent.id());
}

/** the engine unloads the soldier from the ship onto the given spot */
export function disembark(unit: { ent: FakeEnt; state: UnitState }, carrier: { state: ShipState }, at: [number, number]): void
{
	unit.state.pos = at;
	carrier.state.garrisoned = carrier.state.garrisoned.filter((id) => id !== unit.ent.id());
}

export type { HqWorld, HqInstance };
