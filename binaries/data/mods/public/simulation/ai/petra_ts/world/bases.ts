/**
 * The bases as the layers above them see them (PLAN.md §3.4, world/).
 *
 * A base (decision/baseManager.ts) is the AI's model of one of its towns: its
 * anchor, its land, the resource supplies within reach of its dropsites. The
 * code that steers units (execution/) reads that model through BaseView,
 * whose lists are read-only, and changes it only through the narrow
 * capabilities below. BaseManager has every member, so it is one of these
 * as it is; the interfaces only limit what the reader may do with it.
 */
import type { ResourceSupply } from "../decision/baseManager.ts";

/** A base's resource supplies by resource, then by band of distance ("nearby", "medium", "faraway"). */
export type SupplyBands = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<Readonly<ResourceSupply>>>>>>;

/** What a base is, for reading. */
export interface BaseView
{
	readonly ID: BaseId;
	/** The land the base stands on; undefined for the baseless pool. */
	readonly accessIndex: AccessIndex | undefined;
	readonly anchor: CommonEntity | undefined;
	/** The supplies within reach of its dropsites (world/baseResources.ts), read-only. */
	readonly resources: { readonly dropsiteSupplies: SupplyBands };
	/** How many of our gatherers this turn are booked on `supply` beyond what the engine counts. */
	GetTCGatherer(supply: EntityId): number;
	workersBySubrole(gameState: CommonGameState, subrole: WorkerSubrole): CommonEntityCollection;
	/** The base's workers (a live collection the base keeps up to date). */
	readonly workers: CommonEntityCollection;
	/** Where a dropsite for `resource` of this template would serve the base best (a search; it changes nothing). */
	findBestDropsiteLocation(gameState: CommonGameState, resource: string, templateName: TemplateName): { quality: number; pos: CommonPosition };
}

/** Booking a supply for a gatherer this turn, so the next one counts it as taken. */
export interface SupplyBooking
{
	AddTCGatherer(supply: EntityId): void;
	RemoveTCGatherer(supply: EntityId): void;
}

/** Dropping a supply whose entity is gone (gathered out, destroyed) from a base's list. */
export interface SupplyUpkeep
{
	forgetSupplyAt(resource: string, band: string, index: number): void;
}

/** Handing idle workers back to the base, which finds them work. */
export interface IdleWorkers
{
	reassignIdleWorkers(gameState: CommonGameState, idleWorkers?: Iterable<CommonEntity>): void;
}

/** A worker's own base: read, book its supplies, hand back the idle. */
export type WorkerBase = BaseView & SupplyBooking & SupplyUpkeep & IdleWorkers;

/** All our bases, for reading and for dropping gone supplies from their lists. */
export function basesOf(gameState: CommonGameState): ReadonlyArray<BaseView & SupplyUpkeep>
{
	return gameState.ai.HQ.baseManagers();
}
