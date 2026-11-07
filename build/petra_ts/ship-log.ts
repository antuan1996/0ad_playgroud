/**
 * Reads the ships' samples of match.sh -b (ships.txt, bot-state.js shipLine,
 * every 5 game seconds) and finds ships that sail without getting anywhere
 * (PLAN.md §6.2, item 4):
 *
 *   node build/petra_ts/ship-log.ts <match dir | batch dir> [--top N]
 *
 * - no headway: a ship with a transport goal (its boarding or landing point)
 *   that in 60 s sails at least 100 m and gets less than 20 m nearer it, while
 *   more than 40 m away;
 * - still: a ship with a transport goal more than 40 m away that moves less
 *   than 10 m in 60 s;
 * - circling: a ship other than a fishing boat (whose work is a shuttle) that
 *   in 60 s sails at least 100 m and stays within 40 m of where it was.
 *
 * Overlapping windows of one ship join into one episode. It prints, per kind of
 * episode, how many and their ship-minutes, against the ship-minutes of
 * transports with a goal; how long a transport stage lasts for a ship; and
 * the longest episodes, to replay (the match's rerun line, game time given).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One ship in one sample: [id, kind, x, z, angle, state, carried, plan, stage, goalX, goalZ]. */
type ShipRow = [
	number,
	string,
	number,
	number,
	number,
	string,
	number,
	number | null,
	string | null,
	number | null,
	number | null,
];
type Sample = {
	t: number;
	x: number;
	z: number;
	kind: string;
	state: string;
	carried: number;
	plan: number | null;
	stage: string | null;
	goal: [number, number] | null;
};
type Episode = {
	game: string;
	player: number;
	ship: number;
	what: "no headway" | "still" | "circling";
	from: number;
	to: number;
	travelled: number;
	goalFrom?: number;
	goalTo?: number;
	kinds: Set<string>;
	states: Set<string>;
	stage: string | null;
	carried: number;
};

const WINDOW = 60;
const HEADWAY_SAIL = 100;
const HEADWAY_GAIN = 20;
const NEAR_GOAL = 40;
const STILL = 10;
const CIRCLE_RADIUS = 40;

const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

/** Each ship's samples, by "player:ship", in time order. */
export function readShips(text: string): Map<string, Sample[]>
{
	const ships = new Map<string, Sample[]>();
	for (const line of text.split("\n"))
	{
		if (!line.trim())
		{
			continue;
		}
		const row: { t: number; player: number; ships?: ShipRow[]; } = JSON.parse(line);
		for (const [id, kind, x, z, , state, carried, plan, stage, gx, gz] of row.ships ?? [])
		{
			const key = `${row.player}:${id}`;
			const list = ships.get(key) ?? [];
			list.push({
				t: row.t,
				x,
				z,
				kind,
				state,
				carried,
				plan,
				stage,
				goal: gx === null || gz === null ? null : [gx, gz],
			});
			ships.set(key, list);
		}
	}
	return ships;
}

/** The ship's path length from sample i to sample j. */
function travelled(samples: Sample[], i: number, j: number): number
{
	let sum = 0;
	for (let k = i + 1; k <= j; ++k)
	{
		sum += dist(samples[k - 1].x, samples[k - 1].z, samples[k].x, samples[k].z);
	}
	return sum;
}

/** The same goal (and plan and stage) at both samples. */
function sameGoal(a: Sample, b: Sample): boolean
{
	return !!a.goal && !!b.goal && a.plan === b.plan && a.stage === b.stage && a.goal[0] === b.goal[0] &&
		a.goal[1] === b.goal[1];
}

/** What a 60 s window from sample i to sample j shows, if anything. */
function judge(samples: Sample[], i: number, j: number): Episode["what"] | undefined
{
	const a = samples[i];
	const b = samples[j];
	const path = travelled(samples, i, j);
	if (sameGoal(a, b) && b.goal && a.goal)
	{
		const before = dist(a.x, a.z, a.goal[0], a.goal[1]);
		const after = dist(b.x, b.z, b.goal[0], b.goal[1]);
		if (after > NEAR_GOAL && path >= HEADWAY_SAIL && before - after < HEADWAY_GAIN)
		{
			return "no headway";
		}
		if (after > NEAR_GOAL && path < STILL)
		{
			return "still";
		}
	}
	// a fishing boat shuttles between its fish and its dock: that is its work
	if (path >= HEADWAY_SAIL && !samples.slice(i, j + 1).some((s) => s.kind === "fish"))
	{
		let far = 0;
		for (let k = i; k <= j; ++k)
		{
			far = Math.max(far, dist(a.x, a.z, samples[k].x, samples[k].z));
		}
		if (far <= CIRCLE_RADIUS)
		{
			return "circling";
		}
	}
	return undefined;
}

/** A ship's episodes: its flagged windows, those overlapping of one kind joined. */
export function episodesOf(game: string, key: string, samples: Sample[]): Episode[]
{
	const [player, ship] = key.split(":").map(Number);
	const episodes: Episode[] = [];
	let j = 0;
	for (let i = 0; i < samples.length; ++i)
	{
		j = Math.max(j, i);
		while (j < samples.length - 1 && samples[j].t - samples[i].t < WINDOW)
		{
			++j;
		}
		// a gap in the samples (the ship aboard nothing, out of the log): no window across it
		if (samples[j].t - samples[i].t < WINDOW || samples[j].t - samples[i].t > WINDOW + 10)
		{
			continue;
		}
		const what = judge(samples, i, j);
		if (!what)
		{
			continue;
		}
		const last = episodes[episodes.length - 1];
		const a = samples[i];
		const b = samples[j];
		const goalTo = b.goal ? dist(b.x, b.z, b.goal[0], b.goal[1]) : undefined;
		if (last && last.what === what && a.t <= last.to)
		{
			last.travelled += travelled(samples, samples.findIndex((s) => s.t === last.to), j);
			last.to = b.t;
			last.goalTo = goalTo;
			for (let k = i; k <= j; ++k)
			{
				last.kinds.add(samples[k].kind);
				last.states.add(samples[k].state);
			}
			continue;
		}
		const episode: Episode = {
			game,
			player,
			ship,
			what,
			from: a.t,
			to: b.t,
			travelled: travelled(samples, i, j),
			goalFrom: a.goal ? dist(a.x, a.z, a.goal[0], a.goal[1]) : undefined,
			goalTo,
			kinds: new Set(),
			states: new Set(),
			stage: a.stage,
			carried: a.carried,
		};
		for (let k = i; k <= j; ++k)
		{
			episode.kinds.add(samples[k].kind);
			episode.states.add(samples[k].state);
		}
		episodes.push(episode);
	}
	return episodes;
}

/** How long each ship kept one transport goal, in seconds. */
function stageLengths(samples: Sample[]): number[]
{
	const lengths: number[] = [];
	let start = -1;
	for (let k = 0; k < samples.length; ++k)
	{
		const s = samples[k];
		if (start >= 0 && !sameGoal(samples[start], s))
		{
			lengths.push(samples[k - 1].t - samples[start].t);
			start = -1;
		}
		if (start < 0 && s.goal)
		{
			start = k;
		}
	}
	if (start >= 0)
	{
		lengths.push(samples[samples.length - 1].t - samples[start].t);
	}
	return lengths;
}

const quantile = (values: number[], q: number): number =>
{
	if (!values.length)
	{
		return NaN;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const minutes = (s: number): string => (s / 60).toFixed(1);
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** The ships.txt files of a match folder or of a batch's games. */
function shipFiles(dir: string): Array<[string, string]>
{
	const single = join(dir, "ships.txt");
	if (existsSync(single))
	{
		return [[dir, single]];
	}
	const games = join(dir, "games");
	if (!existsSync(games))
	{
		throw new Error(`no ships.txt in ${dir} (record with match.sh -b, or batch.ts --bot-state)`);
	}
	return readdirSync(games).sort().map((g): [string, string] => [g, join(games, g, "ships.txt")]).filter(([, f]) =>
		existsSync(f)
	);
}

/** The report for a match or batch folder. */
export function report(dir: string, top = 10): string
{
	const episodes: Episode[] = [];
	const lengths: number[] = [];
	let goalTime = 0;
	let shipTime = 0;
	for (const [game, file] of shipFiles(dir))
	{
		for (const [key, samples] of readShips(readFileSync(file, "utf8")))
		{
			episodes.push(...episodesOf(game, key, samples));
			lengths.push(...stageLengths(samples));
			for (let k = 1; k < samples.length; ++k)
			{
				const step = Math.min(samples[k].t - samples[k - 1].t, 10);
				shipTime += step;
				if (samples[k].goal)
				{
					goalTime += step;
				}
			}
		}
	}
	const out: string[] = [];
	out.push(`ship-minutes ${minutes(shipTime)}, of which with a transport goal ${minutes(goalTime)}`);
	out.push(
		`transport stages (one goal for one ship): ${lengths.length}, seconds median ${quantile(lengths, 0.5)}, ` +
			`90th ${quantile(lengths, 0.9)}, longest ${Math.max(0, ...lengths)}; over 5 minutes ` +
			`${lengths.filter((l) => l > 300).length}`,
	);
	for (const what of ["no headway", "still", "circling"] as const)
	{
		const list = episodes.filter((e) => e.what === what);
		const time = list.reduce((sum, e) => sum + e.to - e.from, 0);
		const ships = new Set(list.map((e) => `${e.game}:${e.player}:${e.ship}`)).size;
		out.push(`${what}: ${list.length} episodes, ${ships} ships, ${minutes(time)} ship-minutes`);
	}
	out.push("");
	out.push("longest episodes:");
	for (const e of [...episodes].sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, top))
	{
		const goal = e.goalFrom === undefined ?
			"" :
			` goal ${Math.round(e.goalFrom)} m -> ${Math.round(e.goalTo ?? NaN)} m (${e.stage}, ${e.carried} aboard)`;
		out.push(
			`  ${e.game} p${e.player} ship ${e.ship} ${e.what} ${clock(e.from)}-${clock(e.to)} ` +
				`sailed ${Math.round(e.travelled)} m${goal} [${[...e.kinds].join(",")}] ${[...e.states].join(",")}`,
		);
	}
	return out.join("\n");
}

if (import.meta.main)
{
	const args = process.argv.slice(2);
	const topAt = args.indexOf("--top");
	const top = topAt >= 0 ? Number(args[topAt + 1]) : 10;
	const dir = args.find((a, i) => !a.startsWith("--") && (topAt < 0 || i !== topAt + 1));
	if (!dir)
	{
		console.error("usage: node build/petra_ts/ship-log.ts <match dir | batch dir> [--top N]");
		process.exit(2);
	}
	console.log(report(dir, top));
}
