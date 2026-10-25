/**
 * How long the AIs took per turn in a match recorded with match.sh -P
 * (PLAN.md §4: the turn budget).
 *
 *   node build/petra_ts/ai-times.ts <match dir>...
 *   node build/petra_ts/ai-times.ts --compare <batch dir>
 *
 * Reads <match dir>/aitimes.txt, written by the engine (CCmpAIManager.cpp,
 * PYROGENESIS_AI_TIMES): one line per AI computation and AI,
 * "<computation> <player> <microseconds>", player 0 being the shared
 * component. The engine runs one computation per simulation turn (200 ms of
 * game time), and times only the scripts' own calls, two clock reads around
 * each; nothing is printed during the game, so the times are the bots'.
 *
 * Prints, for each AI and for the turn as a whole (the shared component and
 * every AI, what the simulation waits on): the number of turns, the mean, the
 * median, the 90th, 99th and 99.9th percentiles and the maximum, in
 * milliseconds; then the same per ten game minutes, since the cost grows with
 * the game. With several match folders the samples are pooled.
 *
 * --compare: for a batch (batch.ts ... -- -P) of two bots, each bot's own
 * script time per turn, pooled over every game and both slots, and the ratio
 * of the first bot's (blue's) figures to the second's. With two bots that play
 * the same games (stage 3 against petra_parity: the same fingerprint), every
 * turn is timed for both on the same game, the fairest comparison there is;
 * this is the turn budget's check (PLAN.md §4).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TURN_MS = 200;
const WINDOW_MINUTES = 10;

export interface TimeSample
{
	computation: number;
	player: number;
	microseconds: number;
}

export function readTimes(dir: string): TimeSample[]
{
	const file = join(dir, "aitimes.txt");
	if (!existsSync(file))
		return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line =>
	{
		const [computation, player, microseconds] = line.split(" ").map(Number);
		return { computation, player, microseconds };
	});
}

/** The value below which a fraction q of the sorted values lie (nearest rank). */
export function percentile(sorted: number[], q: number): number
{
	if (!sorted.length)
		return NaN;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export interface TimeStats
{
	turns: number;
	mean: number;
	p50: number;
	p90: number;
	p99: number;
	p999: number;
	max: number;
}

/** Statistics of durations in milliseconds. */
export function stats(milliseconds: number[]): TimeStats
{
	const sorted = [...milliseconds].sort((a, b) => a - b);
	return {
		"turns": sorted.length,
		"mean": sorted.reduce((sum, x) => sum + x, 0) / (sorted.length || 1),
		"p50": percentile(sorted, 0.5),
		"p90": percentile(sorted, 0.9),
		"p99": percentile(sorted, 0.99),
		"p999": percentile(sorted, 0.999),
		"max": sorted[sorted.length - 1] ?? NaN
	};
}

/** Per AI (by player, 0 = shared) and for whole turns: milliseconds per turn. */
export function series(samples: TimeSample[], runs: number[]): { byPlayer: Map<number, number[]>; turn: number[]; minute: number[] }
{
	const byPlayer = new Map<number, number[]>();
	const turnTotal = new Map<string, number>();
	const turnMinute = new Map<string, number>();
	samples.forEach((sample, i) =>
	{
		const ms = sample.microseconds / 1000;
		(byPlayer.get(sample.player) ?? byPlayer.set(sample.player, []).get(sample.player))?.push(ms);
		const key = `${runs[i]} ${sample.computation}`;
		turnTotal.set(key, (turnTotal.get(key) ?? 0) + ms);
		turnMinute.set(key, sample.computation * TURN_MS / 60000);
	});
	return { byPlayer, "turn": [...turnTotal.values()], "minute": [...turnMinute.values()] };
}

const fmt = (x: number): string => Number.isFinite(x) ? x.toFixed(2).padStart(8) : "       -";
const row = (label: string, s: TimeStats): string =>
	`${label.padEnd(18)} ${String(s.turns).padStart(7)} ${fmt(s.mean)} ${fmt(s.p50)} ${fmt(s.p90)} ${fmt(s.p99)} ${fmt(s.p999)} ${fmt(s.max)}`;

export function summarise(dirs: string[]): string
{
	const samples: TimeSample[] = [];
	const runs: number[] = [];
	dirs.forEach((dir, run) =>
	{
		for (const sample of readTimes(dir))
		{
			samples.push(sample);
			runs.push(run);
		}
	});
	if (!samples.length)
		return "no aitimes.txt (record the match with match.sh -P)";
	const { byPlayer, turn, minute } = series(samples, runs);
	const out = [`AI script time per turn, milliseconds (${dirs.length} match${dirs.length > 1 ? "es" : ""})`,
		`${"".padEnd(18)} ${"turns".padStart(7)} ${"mean".padStart(8)} ${"median".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"p99.9".padStart(8)} ${"max".padStart(8)}`];
	for (const [player, ms] of [...byPlayer].sort((a, b) => a[0] - b[0]))
		out.push(row(player == 0 ? "shared component" : `player ${player}`, stats(ms)));
	out.push(row("whole turn", stats(turn)));
	out.push(`whole turn by game time:`);
	const windows = new Map<number, number[]>();
	turn.forEach((ms, i) =>
	{
		const window = Math.floor(minute[i] / WINDOW_MINUTES);
		(windows.get(window) ?? windows.set(window, []).get(window))?.push(ms);
	});
	for (const [window, ms] of [...windows].sort((a, b) => a[0] - b[0]))
		out.push(row(`  ${window * WINDOW_MINUTES}-${(window + 1) * WINDOW_MINUTES} min`, stats(ms)));
	return out.join("\n");
}

/** Each bot's script time per turn over a batch, and blue's figures over red's. */
export function compareBots(batchDir: string): string
{
	const rows: Array<{ game: number; blue: string; red: string; swapped: boolean; outcome: string }> =
		readFileSync(join(batchDir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
	const byBot = new Map<string, number[]>();
	let games = 0;
	for (const row of rows)
	{
		const times = readTimes(join(batchDir, "games", String(row.game).padStart(4, "0")));
		if (!times.length || row.outcome == "failed")
			continue;
		++games;
		const botOf = (player: number): string =>
			(player == 1) != row.swapped ? `${row.blue} (blue)` : `${row.red} (red)`;
		for (const sample of times)
			if (sample.player != 0)
				(byBot.get(botOf(sample.player)) ?? byBot.set(botOf(sample.player), []).get(botOf(sample.player)))?.push(sample.microseconds / 1000);
	}
	if (byBot.size != 2)
		return `need two bots with times, found ${byBot.size} (play the batch with -- -P)`;
	const [[nameA, msA], [nameB, msB]] = [...byBot].sort((a, b) => a[0].endsWith("(blue)") ? -1 : b[0].endsWith("(blue)") ? 1 : 0);
	const a = stats(msA);
	const b = stats(msB);
	const ratio = (x: number, y: number): string => `${(x / y).toFixed(3)}`.padStart(8);
	return [`each bot's script time per turn, milliseconds (${games} games)`,
		`${"".padEnd(26)} ${"turns".padStart(7)} ${"mean".padStart(8)} ${"median".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"p99.9".padStart(8)} ${"max".padStart(8)}`,
		row(nameA.slice(0, 26), a),
		row(nameB.slice(0, 26), b),
		`${"blue / red".padEnd(18)} ${"".padStart(7)} ${ratio(a.mean, b.mean)} ${ratio(a.p50, b.p50)} ${ratio(a.p90, b.p90)} ${ratio(a.p99, b.p99)} ${ratio(a.p999, b.p999)} ${ratio(a.max, b.max)}`
	].join("\n");
}

if (import.meta.main)
{
	if (process.argv[2] == "--compare")
	{
		console.log(compareBots(process.argv[3]));
		process.exit(0);
	}
	const dirs = process.argv.slice(2);
	if (!dirs.length)
	{
		console.error("usage: node build/petra_ts/ai-times.ts <match dir>...");
		process.exit(2);
	}
	console.log(summarise(dirs));
}
