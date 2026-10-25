/**
 * The map as the AI understands it (PLAN.md §3.4, world/): who owns which
 * ground (the territory map, read again from the engine every HQ update), the
 * border and frontier cells (the border map), and the land and sea regions the
 * AI uses (filled by startingStrategy's map analysis, kept in saves).
 *
 * The headquarters owns one and keeps its old property names for it
 * (HQ.territoryMap, HQ.landRegions, ...), so the managers, the save format and
 * the tests see the same fields as before.
 */
import type { InfoMap } from "simulation/ai/common-api/map-module.js";
import type { TerritoryMap } from "./mapModule.ts";

export class Geography
{
	/** Who owns each territory cell, and whether it is blinking (cut off). Set by the HQ's init and update. */
	declare territoryMap: TerritoryMap;
	/** The map's border and our frontier, cell flags (mapMask.ts). Set by the HQ's init. */
	declare borderMap: InfoMap;
	/** The land regions we use. */
	landRegions: Record<number, boolean> = {};
	/** The sea regions we use. */
	navalRegions: Record<number, boolean> = {};
	/** Whether the map has a sea worth a navy. */
	navalMap = false;
}
