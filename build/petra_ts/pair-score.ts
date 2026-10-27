/**
 * An early proxy of strength, read from a batch's replays (metadata.json, each
 * statistic every 30 game seconds), for choosing what to try before an SPRT on
 * the win-rate decides (PLAN.md §5.3):
 *
 *   node build/petra_ts/pair-score.ts <batch dir> [--minute M] [--compare <batch dir>]
 *
 * A game's score is blue's lead over red at game minute M (default 8): units
 * trained (the Unit class), and resources gathered. A seed pair's score is the
 * mean of its two games in a --slots both batch, the same map from both slots,
 * so the slot's advantage cancels; a pair missing a game is left out.
 *
 *   - the scores: mean over the pairs with a 95% interval;
 *   - their worth as a proxy: in the decided games, how often the side ahead at
 *     minute M won, at several minutes, and the correlation of the lead with
 *     blue's result (+1 won, -1 lost);
 *   - --compare B: the same pairs in another batch (same --games and --seed, or
 *     the same --pairs), e.g. a change and its control, both against the same
 *     red: the mean of the pair-by-pair difference, with a 95% interval.
 *
 * The leads at minutes 7-8 foretold the winner in stage 4's games (FINDINGS
 * §16); the validation printed here says how well, for the batch at hand.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VALIDATION_MINUTES = [4, 6, 8, 10, 12];
const METRICS = ["units", "gathered"] as const;
type Metric = typeof METRICS[number];

interface BatchRow
{
	game: number;
	mapSeed: number;
	aiSeed: number;
	swapped: boolean;
	outcome: string;
}

interface Sequences
{
	time: number[];
	unitsTrained: Record<string, number[]>;
	resourcesGathered: Record<string, number[]>;
}

interface Game
{
	row: BatchRow;
	/** player 1's and player 2's sequences */
	sequences: [Sequences, Sequences];
}

function fail(message: string): never
{
	console.error(`pair-score: ${message}`);
	process.exit(2);
}

function readGames(dir: string): Game[]
{
	const path = join(dir, "results.jsonl");
	if (!existsSync(path))
		fail(`no results.jsonl in ${dir}`);
	const games: Game[] = [];
	for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean))
	{
		const row: BatchRow = JSON.parse(line);
		const file = join(dir, "games", String(row.game).padStart(4, "0"), "metadata.json");
		if (row.outcome === "failed" || !existsSync(file))
			continue;
		const states = JSON.parse(readFileSync(file, "utf8")).playerStates;
		games.push({ row, "sequences": [states[1].sequences, states[2].sequences] });
	}
	return games;
}

/** A player's value of the metric at game minute m: the last sample at or before it. */
function valueAt(sequences: Sequences, metric: Metric, minute: number): number
{
	let i = sequences.time.length - 1;
	while (i > 0 && sequences.time[i] > minute * 60 + 1)
		--i;
	if (metric === "units")
		return sequences.unitsTrained.Unit[i];
	return ["food", "wood", "stone", "metal"].reduce((sum, res) => sum + sequences.resourcesGathered[res][i], 0);
}

/** Blue's lead over red at minute m. */
function lead(game: Game, metric: Metric, minute: number): number
{
	const [one, two] = game.sequences;
	const diff = valueAt(one, metric, minute) - valueAt(two, metric, minute);
	return game.row.swapped ? -diff : diff;
}

/** +1 blue won, -1 red won, 0 otherwise. */
function blueResult(game: Game): number
{
	return game.row.outcome === "blue" ? 1 : game.row.outcome === "red" ? -1 : 0;
}

/** The pairs with both games, by "mapSeed/aiSeed". */
function pairsOf(games: Game[]): Map<string, [Game, Game]>
{
	const bySeeds = new Map<string, Game[]>();
	for (const game of games)
	{
		const key = `${game.row.mapSeed}/${game.row.aiSeed}`;
		(bySeeds.get(key) ?? bySeeds.set(key, []).get(key))?.push(game);
	}
	const pairs = new Map<string, [Game, Game]>();
	for (const [key, list] of bySeeds)
	{
		const straight = list.find((g) => !g.row.swapped);
		const swapped = list.find((g) => g.row.swapped);
		if (straight && swapped)
			pairs.set(key, [straight, swapped]);
	}
	return pairs;
}

/** Mean and 95% interval half-width (Student's t, approximated). */
function interval(values: number[]): { mean: number; half: number; n: number }
{
	const n = values.length;
	const mean = values.reduce((a, b) => a + b, 0) / n;
	if (n < 2)
		return { mean, "half": NaN, n };
	const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
	const z = 1.959964;
	const t = z + (z ** 3 + z) / (4 * (n - 1)) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * (n - 1) ** 2);
	return { mean, "half": t * Math.sqrt(variance / n), n };
}

function correlation(xs: number[], ys: number[]): number
{
	const n = xs.length;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; ++i)
	{
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

const fmt = (value: number, digits = 1): string => Number.isFinite(value) ? value.toFixed(digits) : "-";

function describe(label: string, values: number[]): string
{
	const { mean, half, n } = interval(values);
	const sign = Number.isFinite(half) && (mean - half > 0 || mean + half < 0) ? "  (excludes 0)" : "";
	return `  ${label.padEnd(10)} ${fmt(mean).padStart(8)} ± ${fmt(half).padEnd(7)} over ${n} pairs${sign}`;
}

function pairScores(pairs: Map<string, [Game, Game]>, metric: Metric, minute: number): Map<string, number>
{
	return new Map([...pairs].map(([key, [a, b]]) => [key, (lead(a, metric, minute) + lead(b, metric, minute)) / 2]));
}

function main(args: string[]): void
{
	let minute = 8;
	let compare: string | undefined;
	const dirs: string[] = [];
	for (let i = 0; i < args.length; ++i)
	{
		if (args[i] === "--minute" && i + 1 < args.length)
			minute = Number(args[++i]);
		else if (args[i] === "--compare" && i + 1 < args.length)
			compare = args[++i];
		else if (args[i].startsWith("--"))
			fail(`unknown option ${args[i]} (see the header of build/petra_ts/pair-score.ts)`);
		else
			dirs.push(args[i]);
	}
	if (dirs.length !== 1 || !(minute > 0))
		fail("usage: node build/petra_ts/pair-score.ts <batch dir> [--minute M] [--compare <batch dir>]");
	const games = readGames(dirs[0]);
	const pairs = pairsOf(games);
	const out = [`${games.length} games, ${pairs.size} complete seed pairs; blue's lead at minute ${minute}, mean of a pair's two games:`];
	for (const metric of METRICS)
		out.push(describe(metric, [...pairScores(pairs, metric, minute).values()]));

	const decided = games.filter((g) => blueResult(g) !== 0);
	out.push("", `as a proxy, over ${decided.length} decided games: how often the side ahead won (ties left out),`,
		"and the correlation of blue's lead with its result:");
	out.push("  minute  " + METRICS.map((m) => `${m}: ahead won  corr`.padStart(24)).join(""));
	for (const m of [...new Set([...VALIDATION_MINUTES, minute])].sort((a, b) => a - b))
	{
		const cells = METRICS.map((metric) =>
		{
			const leads = decided.map((g) => lead(g, metric, m));
			const results = decided.map(blueResult);
			const counted = leads.map((l, i) => [l, results[i]]).filter(([l]) => l !== 0);
			const right = counted.filter(([l, r]) => Math.sign(l) === r).length;
			return `${fmt(100 * right / counted.length, 0)}% of ${counted.length}  ${fmt(correlation(leads, results), 2)}`.padStart(24);
		});
		out.push(`  ${String(m).padStart(6)}  ${cells.join("")}`);
	}

	if (compare)
	{
		const other = pairsOf(readGames(compare));
		const shared = [...pairs.keys()].filter((key) => other.has(key));
		out.push("", `against ${compare}: ${shared.length} shared seed pairs, this batch minus that one, pair by pair:`);
		for (const metric of METRICS)
		{
			const mine = pairScores(pairs, metric, minute);
			const theirs = pairScores(other, metric, minute);
			out.push(describe(metric, shared.map((key) => (mine.get(key) ?? NaN) - (theirs.get(key) ?? NaN))));
		}
		const wins = (list: Map<string, [Game, Game]>, key: string): number =>
			(list.get(key) ?? []).reduce((n, g) => n + (blueResult(g) === 1 ? 1 : 0), 0);
		out.push(describe("wins", shared.map((key) => wins(pairs, key) - wins(other, key))) + "  (blue's wins per pair, of 2)");
	}
	console.log(out.join("\n"));
}

main(process.argv.slice(2));
