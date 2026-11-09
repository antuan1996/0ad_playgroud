/**
 * Which base each territory cell of ours belongs to (PLAN.md §3.4, world/): a
 * map of the territory grid holding a base id per cell, NO_BASE where no base
 * claims it. The bases manager (decision/basesManager.ts) owns it and decides
 * which base claims a cell; the layers below read it as
 * `gameState.ai.bases.territory`. Not saved: a load rebuilds it from each
 * base's cells.
 */
import { InfoMap } from "simulation/ai/common-api/map-module.js";
import { NO_BASE, baseId } from "../adapter/brands.ts";

export class BaseTerritory
{
	/** Each territory cell's base id, 0 for none */
	private readonly cells: InfoMap;

	constructor(gameState: CommonGameState)
	{
		this.cells = new InfoMap(gameState.sharedScript, "territory");
	}

	/** The base that claims the cell, NO_BASE for none */
	baseAt(territoryIndex: CellIndex<"territory">): BaseId
	{
		return baseId(this.cells.map[territoryIndex]);
	}

	/** The cell is the base's */
	assign(territoryIndex: CellIndex<"territory">, base: BaseId): void
	{
		this.cells.map[territoryIndex] = base;
	}

	/** The cell is no base's */
	clear(territoryIndex: CellIndex<"territory">): void
	{
		this.cells.map[territoryIndex] = NO_BASE;
	}
}
