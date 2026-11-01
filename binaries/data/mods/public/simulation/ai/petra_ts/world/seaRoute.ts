/**
 * Sea routes that keep their distance from enemy shooters (stage 5, world/;
 * FINDINGS §36). A ship sent with one move takes the engine's shortest path,
 * which hugs any coast on the way: transports were sunk by towers, civic
 * centres and archers on the shores they passed. Here a route is searched on
 * the AI's own sea grid (the accessibility's navalPassMap, each cell holding
 * its sea region), over the cells of the ship's sea, a cell within a
 * shooter's range (and a margin; a melee soldier on the shore has range 0)
 * costing DANGER_COST times a free one: the
 * ship still reaches a landing point under fire, but goes round any shooter
 * it can.
 */
import type { Accessibility } from "simulation/ai/common-api/terrain-analysis.js";
import { GAIA, worldPos } from "../adapter/brands.ts";

/** What a cell within a shooter's reach costs, against 1 for a free one. */
export const DANGER_COST = 30;
/** Metres kept beyond a shooter's range. */
export const DANGER_MARGIN = 12;
/** The most waypoints a route is thinned to (the destination included). */
export const MAX_WAYPOINTS = 8;
/** A shooter's reach when its template gives none (a tower's). */
const DEFAULT_RANGE = 60;

/** An enemy that shoots at what passes by: where it stands and how far it reaches. */
export interface Shooter
{
	pos: CommonPosition;
	range: number;
}

/**
 * The enemy buildings with defensive fire, and the enemy units and ships with
 * any attack: those with a ranged one by its range, the others (melee soldiers
 * waiting on the shore) at reach 0, so that a ship keeps the margin from them.
 */
export function shootersOf(gameState: CommonGameState): Shooter[]
{
	const shooters: Shooter[] = [];
	for (const ent of gameState.getEnemyEntities().values())
	{
		const pos = ent.position();
		if (!pos || ent.owner() === GAIA)
			continue;
		if (ent.hasClass("Structure"))
		{
			if (ent.hasDefensiveFire())
				shooters.push({ pos, "range": ent.attackRange("Ranged")?.max ?? DEFAULT_RANGE });
			continue;
		}
		const attacks = ent.attackTypes();
		if (!attacks?.length)
			continue;
		shooters.push({ pos, "range": attacks.includes("Ranged") ? ent.attackRange("Ranged")?.max ?? DEFAULT_RANGE : 0 });
	}
	return shooters;
}

/** A minimal binary heap of cell indices by priority. */
class CellHeap
{
	cells: number[] = [];
	priorities: number[] = [];

	push(cell: number, priority: number): void
	{
		let i = this.cells.length;
		this.cells.push(cell);
		this.priorities.push(priority);
		while (i > 0)
		{
			const parent = (i - 1) >> 1;
			if (this.priorities[parent] <= priority)
				break;
			this.cells[i] = this.cells[parent];
			this.priorities[i] = this.priorities[parent];
			i = parent;
		}
		this.cells[i] = cell;
		this.priorities[i] = priority;
	}

	pop(): number | undefined
	{
		const top = this.cells[0];
		const lastCell = this.cells.pop();
		const lastPriority = this.priorities.pop();
		if (!this.cells.length || lastCell === undefined || lastPriority === undefined)
			return top;
		let i = 0;
		const n = this.cells.length;
		for (;;)
		{
			const left = 2 * i + 1;
			if (left >= n)
				break;
			const right = left + 1;
			const child = right < n && this.priorities[right] < this.priorities[left] ? right : left;
			if (this.priorities[child] >= lastPriority)
				break;
			this.cells[i] = this.cells[child];
			this.priorities[i] = this.priorities[child];
			i = child;
		}
		this.cells[i] = lastCell;
		this.priorities[i] = lastPriority;
		return top;
	}
}

/**
 * Waypoints from `from` to `to` over the cells of sea region `sea`, round the
 * shooters where it can; the last is `to` itself. Undefined when either end is
 * not on that sea or no way joins them: the caller sends the ship straight.
 */
export function seaRoute(access: Readonly<Accessibility>, sea: SeaIndex, from: CommonPosition, to: CommonPosition,
	shooters: readonly Shooter[]): CommonPosition[] | undefined
{
	const width = access.width;
	const height = access.height;
	const cellSize = access.cellSize;
	const cellOf = (pos: CommonPosition): number =>
	{
		const p = access.gamePosToMapPos(pos);
		return p[0] + p[1] * width;
	};
	const start = cellOf(from);
	const goal = cellOf(to);
	const onSea = (cell: number): boolean => access.navalPassMap[cell] === sea;
	if (!onSea(start) || !onSea(goal))
		return undefined;

	const danger = new Uint8Array(width * height);
	for (const shooter of shooters)
	{
		const c = access.gamePosToMapPos(shooter.pos);
		const r = Math.ceil((shooter.range + DANGER_MARGIN) / cellSize);
		for (let y = Math.max(0, c[1] - r); y <= Math.min(height - 1, c[1] + r); ++y)
			for (let x = Math.max(0, c[0] - r); x <= Math.min(width - 1, c[0] + r); ++x)
				if ((x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) <= r * r)
					danger[x + y * width] = 1;
	}

	const goalX = goal % width;
	const goalY = Math.floor(goal / width);
	const estimate = (cell: number): number =>
	{
		const dx = Math.abs(cell % width - goalX);
		const dy = Math.abs(Math.floor(cell / width) - goalY);
		return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
	};
	const cost = new Float64Array(width * height).fill(Infinity);
	const cameFrom = new Int32Array(width * height).fill(-1);
	const heap = new CellHeap();
	cost[start] = 0;
	heap.push(start, estimate(start));
	for (let cell = heap.pop(); cell !== undefined; cell = heap.pop())
	{
		if (cell === goal)
			break;
		const x = cell % width;
		const y = Math.floor(cell / width);
		for (let dy = -1; dy <= 1; ++dy)
			for (let dx = -1; dx <= 1; ++dx)
			{
				const nx = x + dx;
				const ny = y + dy;
				if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= width || ny >= height)
					continue;
				const next = nx + ny * width;
				if (!onSea(next))
					continue;
				const step = (dx && dy ? Math.SQRT2 : 1) * (danger[next] ? DANGER_COST : 1);
				const reached = cost[cell] + step;
				if (reached >= cost[next])
					continue;
				cost[next] = reached;
				cameFrom[next] = cell;
				heap.push(next, reached + estimate(next));
			}
	}
	if (cameFrom[goal] === -1 && goal !== start)
		return undefined;

	const cells: number[] = [];
	for (let cell = goal; cell !== start; cell = cameFrom[cell])
		cells.push(cell);
	cells.reverse();
	const every = Math.max(1, Math.ceil(cells.length / MAX_WAYPOINTS));
	const route: CommonPosition[] = [];
	for (let i = every - 1; i < cells.length - 1; i += every)
	{
		const cell = cells[i];
		route.push(worldPosOf(cell % width, Math.floor(cell / width), cellSize));
	}
	route.push(to);
	return route;
}

/** The centre of a grid cell, in world coordinates. */
function worldPosOf(x: number, y: number, cellSize: number): CommonPosition
{
	return worldPos((x + 0.5) * cellSize, (y + 0.5) * cellSize);
}

