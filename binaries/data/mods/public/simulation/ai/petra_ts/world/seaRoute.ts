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
 * it can, however long the way round (the user's watch of a 4-player
 * Dodecanese game: transports passed towers they could have sailed round an
 * island to avoid). The path is then cut to its corners: a waypoint is kept
 * wherever the straight way to the next would leave the sea or pass more
 * danger than the path does, since the engine sails each leg by its own
 * shortest way, along any coast.
 */
import type { Accessibility } from "simulation/ai/common-api/terrain-analysis.js";
import { GAIA, worldPos } from "../adapter/brands.ts";

/** What a cell within a shooter's reach costs, against 1 for a free one: any way round that exists is taken. */
const DANGER_COST = 200;
/** Metres kept beyond a shooter's range. */
export const DANGER_MARGIN = 12;
/** The most waypoints a route keeps (the destination included); a longer list of corners is thinned evenly. */
export const MAX_WAYPOINTS = 40;
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
		shooters.push({
			pos,
			"range": attacks.includes("Ranged") ? ent.attackRange("Ranged")?.max ?? DEFAULT_RANGE : 0,
		});
	}
	return shooters;
}

/** How many shooters reach a point: within their range and the margin. */
export function threatsAt(pos: CommonPosition, shooters: readonly Shooter[]): number
{
	let threats = 0;
	for (const shooter of shooters)
	{
		const reach = shooter.range + DANGER_MARGIN;
		const dx = pos[0] - shooter.pos[0];
		const dz = pos[1] - shooter.pos[1];
		if (dx * dx + dz * dz <= reach * reach)
			++threats;
	}
	return threats;
}

/** The distance from a point to the segment a-b. */
function segmentDistance(p: CommonPosition, a: CommonPosition, b: CommonPosition): number
{
	const abx = b[0] - a[0];
	const abz = b[1] - a[1];
	const length2 = abx * abx + abz * abz;
	const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / length2)) : 0;
	return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * abz);
}

/** How many shooters reach the way from `from` through the waypoints, its end included. */
export function threatsAlong(
	from: CommonPosition,
	waypoints: readonly CommonPosition[],
	shooters: readonly Shooter[],
): number
{
	let threats = 0;
	for (const shooter of shooters)
	{
		let previous = from;
		for (const point of waypoints)
		{
			if (segmentDistance(shooter.pos, previous, point) <= shooter.range + DANGER_MARGIN)
			{
				++threats;
				break;
			}
			previous = point;
		}
	}
	return threats;
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

/** The sea's grid as the route search reads it. */
type SeaGrid = {
	access: Readonly<Accessibility>;
	sea: SeaIndex;
	width: number;
	height: number;
	/** 1 on the cells within a shooter's range and the margin */
	danger: Uint8Array;
};

function onSea(grid: SeaGrid, cell: number): boolean
{
	return grid.access.navalPassMap[cell] === grid.sea;
}

/**
 * Waypoints from `from` to `to` over the cells of sea region `sea`, round the
 * shooters where it can; the last is `to` itself. Undefined when either end is
 * not on that sea or no way joins them: the caller sends the ship straight.
 */
export function seaRoute(
	access: Readonly<Accessibility>,
	sea: SeaIndex,
	from: CommonPosition,
	to: CommonPosition,
	shooters: readonly Shooter[],
): CommonPosition[] | undefined
{
	const width = access.width;
	const cellOf = (pos: CommonPosition): number =>
	{
		const p = access.gamePosToMapPos(pos);
		return p[0] + p[1] * width;
	};
	const start = cellOf(from);
	const goal = cellOf(to);
	const grid: SeaGrid = {
		access,
		sea,
		width,
		"height": access.height,
		"danger": new Uint8Array(width * access.height),
	};
	if (!onSea(grid, start) || !onSea(grid, goal))
		return undefined;
	markDanger(grid, shooters);

	const cells = searchPath(grid, start, goal);
	if (!cells)
		return undefined;
	const corners = pathCorners(grid, cells);
	const every = Math.max(1, Math.ceil((corners.length + 1) / MAX_WAYPOINTS));
	const route: CommonPosition[] = [];
	for (let i = every - 1; i < corners.length; i += every)
		route.push(worldPosOf(corners[i] % width, Math.floor(corners[i] / width), access.cellSize));
	route.push(to);
	return route;
}

/** Marks the cells within each shooter's range, and the margin, as in danger. */
function markDanger(grid: SeaGrid, shooters: readonly Shooter[]): void
{
	const { access, width, height, danger } = grid;
	for (const shooter of shooters)
	{
		const c = access.gamePosToMapPos(shooter.pos);
		const r = Math.ceil((shooter.range + DANGER_MARGIN) / access.cellSize);
		for (let y = Math.max(0, c[1] - r); y <= Math.min(height - 1, c[1] + r); ++y)
			for (let x = Math.max(0, c[0] - r); x <= Math.min(width - 1, c[0] + r); ++x)
				if ((x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) <= r * r)
					danger[x + y * width] = 1;
	}
}

/** The cheapest way from cell start to cell goal over the sea (A*, danger costly), start and goal included. */
function searchPath(grid: SeaGrid, start: number, goal: number): number[] | undefined
{
	const { width, height } = grid;
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
		relaxNeighbours(grid, cell, cost, cameFrom, (next, reached) => heap.push(next, reached + estimate(next)));
	}
	if (cameFrom[goal] === -1 && goal !== start)
		return undefined;

	const cells: number[] = [start];
	for (let cell = goal; cell !== start; cell = cameFrom[cell])
		cells.splice(1, 0, cell);
	return cells;
}

/** Lowers the cost of each sea neighbour of `cell` reached cheaper through it, and queues it. */
function relaxNeighbours(
	grid: SeaGrid,
	cell: number,
	cost: Float64Array,
	cameFrom: Int32Array,
	queue: (next: number, reached: number) => void,
): void
{
	const { width, height, danger } = grid;
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
			if (!onSea(grid, next))
				continue;
			const step = (dx && dy ? Math.SQRT2 : 1) * (danger[next] ? DANGER_COST : 1);
			const reached = cost[cell] + step;
			if (reached >= cost[next])
				continue;
			cost[next] = reached;
			cameFrom[next] = cell;
			queue(next, reached);
		}
}

/** The cells a straight leg from cell a to cell b crosses: all at sea, and how many in danger (undefined: not at sea). */
function legDanger(grid: SeaGrid, a: number, b: number): number | undefined
{
	const width = grid.width;
	const ax = a % width + 0.5;
	const ay = Math.floor(a / width) + 0.5;
	const dx = b % width + 0.5 - ax;
	const dy = Math.floor(b / width) + 0.5 - ay;
	const steps = Math.max(1, Math.ceil(2 * Math.max(Math.abs(dx), Math.abs(dy))));
	let count = 0;
	let previous = -1;
	for (let k = 1; k <= steps; ++k)
	{
		const cell = Math.floor(ax + dx * k / steps) + Math.floor(ay + dy * k / steps) * width;
		if (cell === previous)
			continue;
		previous = cell;
		if (!onSea(grid, cell))
			return undefined;
		count += grid.danger[cell];
	}
	return count;
}

/**
 * The corners of a path: from each kept cell, the leg goes on along the path
 * while the straight way stays at sea with no more danger than the path's own;
 * the cell before the first that fails is the next corner (a scan forward: its
 * cost grows with the legs, not the path).
 */
function pathCorners(grid: SeaGrid, cells: number[]): number[]
{
	// danger cells along the path up to each cell
	const dangerBefore = new Int32Array(cells.length);
	for (let i = 1; i < cells.length; ++i)
		dangerBefore[i] = dangerBefore[i - 1] + grid.danger[cells[i]];
	const corners: number[] = [];
	for (let anchor = 0; anchor < cells.length - 1;)
	{
		let next = anchor + 1;
		for (let j = anchor + 2; j < cells.length; ++j)
		{
			const leg = legDanger(grid, cells[anchor], cells[j]);
			if (leg === undefined || leg > dangerBefore[j] - dangerBefore[anchor])
				break;
			next = j;
		}
		if (next < cells.length - 1)
			corners.push(cells[next]);
		anchor = next;
	}
	return corners;
}

/** The centre of a grid cell, in world coordinates. */
function worldPosOf(x: number, y: number, cellSize: number): CommonPosition
{
	return worldPos((x + 0.5) * cellSize, (y + 0.5) * cellSize);
}
