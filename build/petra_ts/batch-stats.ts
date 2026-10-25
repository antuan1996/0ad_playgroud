/**
 * The statistics of a batch of matches (batch.ts; PLAN.md §5.3).
 *
 *   node build/petra_ts/batch-stats.ts <batch dir> [--h1 P] [--alpha A] [--beta B]
 *
 * prints the summary of <batch dir>/results.jsonl, as batch.ts writes it to
 * summary.txt: outcomes, the blue bot's win-rate over decided games with a 95%
 * Wilson interval, a sequential probability ratio test (SPRT) of H0 = 50%
 * against H1 = P (default 0.55, α = β = 0.05), the slot advantage, seed pairs
 * one bot won from both slots, errors, game lengths, mean statistics per bot,
 * and a determinism check: games with the same bots, seeds and slots must have
 * the same fingerprint.
 *
 * Draws (games ended by the time limit, or undecided) count in neither the
 * win-rate nor the SPRT; they are reported.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One game of a batch: results.jsonl holds one per line. */
export interface BatchRow
{
	game: number;
	map: string;
	mapSeed: number;
	aiSeed: number;
	/** bot ids (match.sh -o, -p) */
	blue: string;
	red: string;
	/** the red bot played player 1 */
	swapped: boolean;
	/** who won; "draw" for the time limit or no decision; "failed" if no result */
	outcome: "blue" | "red" | "draw" | "failed";
	reason?: string;
	/** game ms of the decision */
	decided?: number;
	fingerprint?: string;
	errors: number;
	warnings: number;
	/** wall-clock seconds the match took */
	wall: number;
	worker: number;
	blueStats?: Record<string, number>;
	redStats?: Record<string, number>;
	/** what went wrong besides the game itself (a failed run, a path clash) */
	problem?: string;
}

/** 95% Wilson score interval of `wins` successes in `n` trials. */
export function wilson(wins: number, n: number, z = 1.959964): [number, number]
{
	if (n == 0)
		return [0, 1];
	const p = wins / n;
	const denominator = 1 + z * z / n;
	const centre = (p + z * z / (2 * n)) / denominator;
	const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface Sprt
{
	llr: number;
	lower: number;
	upper: number;
	/** H1: the win-rate is p1 rather than p0; H0: the reverse; undecided: play on */
	verdict: "H1" | "H0" | "undecided";
}

/**
 * Wald's sequential probability ratio test on wins and losses: the log
 * likelihood ratio of p1 against p0, accepting H1 above ln((1-β)/α) and H0
 * below ln(β/(1-α)).
 */
export function sprt(wins: number, losses: number, p0 = 0.5, p1 = 0.55, alpha = 0.05, beta = 0.05): Sprt
{
	const llr = wins * Math.log(p1 / p0) + losses * Math.log((1 - p1) / (1 - p0));
	const upper = Math.log((1 - beta) / alpha);
	const lower = Math.log(beta / (1 - alpha));
	return { llr, lower, upper, "verdict": llr >= upper ? "H1" : llr <= lower ? "H0" : "undecided" };
}

const percent = (x: number): string => `${(100 * x).toFixed(1)}%`;
const minutes = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function median(values: number[]): number
{
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rate(label: string, wins: number, n: number): string
{
	if (!n)
		return `${label}: no decided game`;
	const [low, high] = wilson(wins, n);
	return `${label}: ${wins}/${n} = ${percent(wins / n)} (95% CI ${percent(low)}–${percent(high)})`;
}

export function summarise(rows: BatchRow[], h1 = 0.55, alpha = 0.05, beta = 0.05): string
{
	const out: string[] = [];
	if (!rows.length)
		return "no games";
	const blueBot = rows[0].blue;
	const redBot = rows[0].red;
	const mirror = blueBot == redBot;
	const name = (side: "blue" | "red"): string => mirror ? `${blueBot} (${side})` : side == "blue" ? blueBot : redBot;
	const played = rows.filter(r => r.outcome != "failed");
	const decided = played.filter(r => r.outcome != "draw");
	const blueWins = decided.filter(r => r.outcome == "blue").length;
	const redWins = decided.length - blueWins;
	const draws = played.length - decided.length;

	out.push(`${name("blue")} vs ${name("red")}: ${rows.length} games, ${played.length} played, ` +
		`${rows.length - played.length} failed`);
	out.push(`outcomes: ${name("blue")} won ${blueWins}, ${name("red")} won ${redWins}, ${draws} draws` +
		(draws ? ` (${[...new Set(played.filter(r => r.outcome == "draw").map(r => r.reason ?? "?"))].join(", ")})` : ""));
	out.push(rate(`win-rate of ${name("blue")}`, blueWins, decided.length));
	const test = sprt(blueWins, redWins, 0.5, h1, alpha, beta);
	out.push(`SPRT H0 50% vs H1 ${percent(h1)} (α ${alpha}, β ${beta}): LLR ${test.llr.toFixed(2)} in ` +
		`[${test.lower.toFixed(2)}, ${test.upper.toFixed(2)}]: ` +
		(test.verdict == "H1" ? `accept H1, ${name("blue")} is stronger` :
			test.verdict == "H0" ? `accept H0, ${name("blue")} is not ${percent(h1)} strong` : "undecided, play on"));
	if (!mirror)
		out.push(`  (the reverse, ${name("red")} at ${percent(h1)}: ` +
			`${sprt(redWins, blueWins, 0.5, h1, alpha, beta).verdict})`);

	// Player 1 against player 2, whoever they were.
	const firstWins = decided.filter(r => (r.outcome == "blue") != r.swapped).length;
	out.push(rate("win-rate of player 1 (slot advantage)", firstWins, decided.length));
	if (!mirror)
		for (const swapped of [false, true])
		{
			const slot = decided.filter(r => r.swapped == swapped);
			out.push("  " + rate(`${name("blue")} as player ${swapped ? 2 : 1}`,
				slot.filter(r => r.outcome == "blue").length, slot.length));
		}

	// Seed pairs played from both slots: did one bot win both games?
	const pairs = new Map<string, BatchRow[]>();
	for (const r of played)
		pairs.set(`${r.mapSeed}/${r.aiSeed}`, [...pairs.get(`${r.mapSeed}/${r.aiSeed}`) ?? [], r]);
	// A game played twice (--twice) counts once.
	const both = [...pairs.values()]
		.map(games => [games.find(g => !g.swapped), games.find(g => g.swapped)])
		.filter((games): games is [BatchRow, BatchRow] => games.every(g => g !== undefined));
	if (both.length)
	{
		const sweep = (side: string) => both.filter(games => games.every(g => g.outcome == side)).length;
		out.push(`seed pairs from both slots: ${both.length}; ${name("blue")} won both ${sweep("blue")}, ` +
			`${name("red")} won both ${sweep("red")}, split or drawn ${both.length - sweep("blue") - sweep("red")}`);
	}

	const withErrors = played.filter(r => r.errors).length;
	const withWarnings = played.filter(r => r.warnings).length;
	out.push(`games with errors ${withErrors}, with warnings ${withWarnings}` +
		(withErrors + withWarnings ? ` (games ${played.filter(r => r.errors || r.warnings).map(r => r.game).join(", ")})` : ""));
	const problems = rows.filter(r => r.problem);
	out.push(`problems: ${problems.length ? "" : "none"}`);
	for (const r of problems)
		out.push(`  game ${r.game}: ${r.problem}`);

	const lengths = decided.map(r => r.decided).filter((ms): ms is number => ms !== undefined);
	if (lengths.length)
		out.push(`decided after (game time): median ${minutes(median(lengths))}, ` +
			`range ${minutes(Math.min(...lengths))}–${minutes(Math.max(...lengths))}`);
	if (played.length)
		out.push(`wall time per game: median ${Math.round(median(played.map(r => r.wall)))} s, ` +
			`total ${Math.round(played.reduce((sum, r) => sum + r.wall, 0) / 60)} min of runs`);

	const keys = [...new Set(played.flatMap(r => Object.keys(r.blueStats ?? {})))];
	if (keys.length)
	{
		out.push(`mean statistics per game:`);
		const width = Math.max(...keys.map(k => k.length));
		const mean = (side: "blueStats" | "redStats", key: string): string =>
			String(Math.round(played.reduce((sum, r) => sum + (r[side]?.[key] ?? 0), 0) / played.length));
		out.push(`  ${"".padEnd(width)}  ${name("blue").padStart(16)}  ${name("red").padStart(16)}`);
		for (const key of keys)
			out.push(`  ${key.padEnd(width)}  ${mean("blueStats", key).padStart(16)}  ${mean("redStats", key).padStart(16)}`);
	}

	// The same game twice must be the same game.
	const runs = new Map<string, BatchRow[]>();
	for (const r of played)
	{
		const key = `${r.blue} ${r.red} ${r.map} ${r.mapSeed} ${r.aiSeed} ${r.swapped}`;
		runs.set(key, [...runs.get(key) ?? [], r]);
	}
	const repeated = [...runs.values()].filter(games => games.length > 1);
	const diverged = repeated.filter(games => new Set(games.map(g => g.fingerprint)).size > 1);
	out.push(`determinism: ${repeated.length ? `${repeated.length} games played more than once, ` +
		`${diverged.length} with different fingerprints` +
		diverged.map(games => ` (games ${games.map(g => g.game).join(", ")})`).join("") : "no game played twice"}`);
	return out.join("\n");
}

if (import.meta.main)
{
	const args = process.argv.slice(2);
	const dir = args[0];
	const option = (flag: string, fallback: number): number =>
	{
		const at = args.indexOf(flag);
		return at == -1 ? fallback : Number(args[at + 1]);
	};
	if (!dir)
	{
		console.error("usage: node build/petra_ts/batch-stats.ts <batch dir> [--h1 P] [--alpha A] [--beta B]");
		process.exit(2);
	}
	const rows: BatchRow[] = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean)
		.map(line => JSON.parse(line));
	console.log(summarise(rows, option("--h1", 0.55), option("--alpha", 0.05), option("--beta", 0.05)));
}
