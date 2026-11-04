/**
 * Where the enemy's ships go (stage 5, world/; FINDINGS §38): a coarse grid
 * of the map, each cell holding the ship-seconds enemy ships spent in it,
 * fading by half every TRAFFIC_HALF_LIFE seconds, so that it follows the
 * passages in use. Owned by the HQ on naval maps and not saved: after a load
 * it fills again within minutes. A tower on a shore is worth its cost when
 * the ships pass within its reach (the user's watch of a 4-player Dodecanese
 * game: "some passages are used a lot by ships while others are barely
 * used"); findShoreTowerLocation reads it.
 */
import { GAIA } from "../adapter/brands.ts";

/** The grid's cell, in metres. */
export const TRAFFIC_CELL = 16;
/** Seconds for the traffic to fade by half. */
export const TRAFFIC_HALF_LIFE = 300;
/** What a ship counts per second, by kind: those that carry or fight the most. */
const FISHING_WEIGHT = 0.25;
const TRADER_WEIGHT = 0.5;

export class ShipTraffic
{
	readonly width: number;
	readonly height: number;
	readonly cells: Float32Array;
	/** Game seconds of the last sample. */
	lastSample: number | undefined = undefined;

	constructor(mapWidth: number, mapHeight: number)
	{
		this.width = Math.max(1, Math.ceil(mapWidth / TRAFFIC_CELL));
		this.height = Math.max(1, Math.ceil(mapHeight / TRAFFIC_CELL));
		this.cells = new Float32Array(this.width * this.height);
	}

	cellAt(pos: CommonPosition): number | undefined
	{
		const x = Math.floor(pos[0] / TRAFFIC_CELL);
		const z = Math.floor(pos[1] / TRAFFIC_CELL);
		if (x < 0 || z < 0 || x >= this.width || z >= this.height)
			return undefined;
		return x + z * this.width;
	}

	/** Fades the traffic for the time since the last sample, then adds each enemy ship's time there. */
	sample(gameState: CommonGameState): void
	{
		const now = gameState.ai.elapsedTime;
		const dt = this.lastSample === undefined ? 0 : now - this.lastSample;
		this.lastSample = now;
		if (dt <= 0)
			return;
		const fade = Math.pow(0.5, dt / TRAFFIC_HALF_LIFE);
		for (let i = 0; i < this.cells.length; ++i)
			this.cells[i] *= fade;
		for (const ship of gameState.getEnemyUnits().values())
		{
			if (!ship.hasClass("Ship") || ship.owner() === GAIA)
				continue;
			const pos = ship.position();
			const cell = pos && this.cellAt(pos);
			if (cell === undefined)
				continue;
			const weight = ship.hasClass("FishingBoat") ? FISHING_WEIGHT : ship.hasClass("Trader") ? TRADER_WEIGHT : 1;
			this.cells[cell] += weight * dt;
		}
	}

	/**
	 * The traffic within `range` of a point: the cells whose centre is in
	 * reach, each counted `coveredWeight` times when within reach of one of the
	 * `covered` points too (a stretch an existing tower already watches).
	 */
	within(pos: CommonPosition, range: number, covered: readonly CommonPosition[] = [], coveredWeight = 1 / 3): number
	{
		const reach = Math.ceil(range / TRAFFIC_CELL);
		const cx = Math.floor(pos[0] / TRAFFIC_CELL);
		const cz = Math.floor(pos[1] / TRAFFIC_CELL);
		const range2 = range * range;
		let total = 0;
		for (let z = Math.max(0, cz - reach); z <= Math.min(this.height - 1, cz + reach); ++z)
			for (let x = Math.max(0, cx - reach); x <= Math.min(this.width - 1, cx + reach); ++x)
			{
				const value = this.cells[x + z * this.width];
				if (!value)
					continue;
				const px = (x + 0.5) * TRAFFIC_CELL;
				const pz = (z + 0.5) * TRAFFIC_CELL;
				if ((px - pos[0]) ** 2 + (pz - pos[1]) ** 2 > range2)
					continue;
				const isCovered = covered.some(c => (px - c[0]) ** 2 + (pz - c[1]) ** 2 <= range2);
				total += isCovered ? value * coveredWeight : value;
			}
		return total;
	}

	/** The busiest cells, for the bot's state dump: [x, z, ship-seconds] of the `count` highest. */
	busiest(count: number): Array<[number, number, number]>
	{
		const order = [...this.cells.keys()].filter(i => this.cells[i] >= 1).sort((a, b) =>
			this.cells[b] - this.cells[a]
		);
		return order.slice(0, count).map(
			i => [
				(i % this.width + 0.5) * TRAFFIC_CELL,
				(Math.floor(i / this.width) + 0.5) * TRAFFIC_CELL,
				Math.round(this.cells[i]),
			]
		);
	}
}
