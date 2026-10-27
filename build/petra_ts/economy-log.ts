/**
 * Reads the economy that Petra TS logs with match.sh -b (economy.txt,
 * bot-state.js) beside what the replay's statistics say it really gathered
 * (metadata.json, sampled at the same 30 game seconds), and summarises them:
 *
 *   node build/petra_ts/economy-log.ts <batch dir | match dir>... [--until MIN]
 *
 * A batch is one played with batch.ts --bot-state (only Petra TS logs; in a
 * game against a baseline that is the blue bot, player 1 unless swapped). Per
 * band of game minutes (to --until, default 15) and resource:
 *
 *   - income: what the side really gathered per second (statistics);
 *   - estimate: the bot's own gather-rate estimate (GetCurrentGatherRates),
 *     what pickMostNeededResources sorts by, and wanted, what its queues want;
 *   - rawRate: the sum of the gather rates of the units gathering (bot-state.js
 *     gatherRate), the estimate the bot means to make, before its log;
 *   - gatherers, the income per gatherer-minute, the share of them gathering
 *     (the rest walk or carry), and the median trip from supply to dropsite;
 *   - first: how often the resource heads pickMostNeededResources' order;
 *   - food by source (fruit, grain, meat, fish): gatherers, the share
 *     gathering, the rate per gatherer the walk included, the trip from the
 *     supply to our nearest food dropsite.
 *
 * Then the same for the sides that won against those that lost, and for the
 * seed pairs of a --slots both batch that the logged bot won from one slot and
 * lost from the other: the same map, so the difference is the start's layout
 * and what the bot made of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RESOURCES = ["food", "wood", "stone", "metal"] as const;
type Res = typeof RESOURCES[number];

/** One ECONLOG line (bot-state.js economyLine). */
interface EconLine
{
	t: number;
	player: number;
	error?: string;
	estimate: Record<Res, number>;
	wanted: Record<Res, number>;
	order: Res[];
	gatherers: { food: { gatherer: number; hunter: number; fisher: number } } & Partial<Record<Res, number>>;
	states: Record<Res, { gathering: number; approaching: number; returning: number; other: number }>;
	rawRate: Record<Res, number>;
	tripDist: Partial<Record<Res, number>>;
	/** food by source (fruit, grain, meat, fish, none): gatherers, those gathering, their rate, the median trip to our nearest food dropsite */
	foodSources?: Record<string, { gatherers: number; gathering: number; rate: number; trip?: number }>;
	stock: Record<Res, number>;
	workers: number;
	pop: number;
}

/** One 30 s sample of one side: the log line and the income since the last sample. */
interface Sample
{
	t: number;
	line: EconLine;
	/** resource units gathered per second over the 30 s to t */
	income: Record<Res, number>;
}

interface Side
{
	game: string;
	player: number;
	result: "won" | "lost" | "draw" | "?";
	/** "mapSeed/aiSeed" in a batch */
	pair?: string;
	samples: Sample[];
}

interface BatchRow
{
	game: number;
	mapSeed: number;
	aiSeed: number;
	swapped: boolean;
	outcome: string;
}

interface Metadata
{
	playerStates: Array<{ sequences: { time: number[]; resourcesGathered: Record<string, number[]> } }>;
}

function gatherersOf(line: EconLine, res: Res): number
{
	if (res === "food")
		return line.gatherers.food.gatherer + line.gatherers.food.hunter + line.gatherers.food.fisher;
	return line.gatherers[res] ?? 0;
}

function samplesOf(lines: EconLine[], player: number, metadata: Metadata | undefined): Sample[]
{
	const sequences = metadata?.playerStates[player]?.sequences;
	const samples: Sample[] = [];
	for (const line of lines)
	{
		if (line.player !== player || line.error)
			continue;
		const income: Record<Res, number> = { "food": NaN, "wood": NaN, "stone": NaN, "metal": NaN };
		if (sequences)
		{
			// the statistics are sampled at 0.2 s, then every 30 s
			const i = sequences.time.findIndex((time) => Math.abs(time - line.t) < 1);
			if (i > 0)
				for (const res of RESOURCES)
					income[res] = (sequences.resourcesGathered[res][i] - sequences.resourcesGathered[res][i - 1]) /
						(sequences.time[i] - sequences.time[i - 1]);
		}
		samples.push({ "t": line.t, line, income });
	}
	return samples;
}

function readLines(file: string): EconLine[]
{
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line): EconLine => JSON.parse(line));
}

function readMetadata(dir: string): Metadata | undefined
{
	const file = join(dir, "metadata.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

function playersOf(lines: EconLine[]): number[]
{
	return [...new Set(lines.map((line) => line.player))].sort();
}

/** The sides of a batch folder or of one match folder. */
function readSides(dir: string): Side[]
{
	const sides: Side[] = [];
	if (existsSync(join(dir, "results.jsonl")))
	{
		const rows = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean)
			.map((line): BatchRow => JSON.parse(line));
		for (const row of rows)
		{
			const gameDir = join(dir, "games", String(row.game).padStart(4, "0"));
			if (!existsSync(join(gameDir, "economy.txt")))
				continue;
			const lines = readLines(join(gameDir, "economy.txt"));
			const metadata = readMetadata(gameDir);
			for (const player of playersOf(lines))
			{
				// blue is player 1 unless the slots were swapped
				const color = (player === 1) !== row.swapped ? "blue" : "red";
				const result = row.outcome === "draw" || row.outcome === "failed" ? "draw" : row.outcome === color ? "won" : "lost";
				sides.push({ "game": `${dir}#${row.game}`, player, result, "pair": `${row.mapSeed}/${row.aiSeed}`,
					"samples": samplesOf(lines, player, metadata) });
			}
		}
		return sides;
	}
	if (!existsSync(join(dir, "economy.txt")))
		throw new Error(`no economy.txt or results.jsonl in ${dir}`);
	const lines = readLines(join(dir, "economy.txt"));
	let winners: number[] = [];
	if (existsSync(join(dir, "result.json")))
	{
		const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		winners = (result.players ?? []).filter((p: { state: string }) => p.state === "won").map((p: { id: number }) => p.id);
	}
	const metadata = readMetadata(dir);
	for (const player of playersOf(lines))
		sides.push({ "game": dir, player, "result": winners.length ? winners.includes(player) ? "won" : "lost" : "?",
			"samples": samplesOf(lines, player, metadata) });
	return sides;
}

const mean = (values: number[]): number =>
{
	const finite = values.filter(Number.isFinite);
	return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
};

const median = (values: number[]): number =>
{
	const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
	return finite.length ? finite[Math.floor(finite.length / 2)] : NaN;
};

/** The figures of one resource over a set of samples. */
interface Figures
{
	income: number;
	estimate: number;
	wanted: number;
	rawRate: number;
	gatherers: number;
	/** income per gatherer-minute */
	perGatherer: number;
	/** share of the gatherers gathering, the rest walking or carrying */
	gathering: number;
	trip: number;
	/** share of the samples where it headed the order */
	first: number;
}

/** A side's mean over its samples in [from, to) minutes, then the mean over the sides (a side counts once). */
function figures(sides: Side[], res: Res, from: number, to: number): Figures | undefined
{
	const perSide: Figures[] = [];
	for (const side of sides)
	{
		const samples = side.samples.filter((s) => s.t > from * 60 && s.t <= to * 60);
		if (!samples.length)
			continue;
		const gatherers = samples.map((s) => gatherersOf(s.line, res));
		const states = samples.map((s) => s.line.states[res]);
		perSide.push({
			"income": mean(samples.map((s) => s.income[res])),
			"estimate": mean(samples.map((s) => s.line.estimate[res])),
			"wanted": mean(samples.map((s) => s.line.wanted[res])),
			"rawRate": mean(samples.map((s) => s.line.rawRate[res])),
			"gatherers": mean(gatherers),
			"perGatherer": mean(samples.map((s, i) => gatherers[i] ? 60 * s.income[res] / gatherers[i] : NaN)),
			"gathering": mean(states.map((st) =>
			{
				const all = st.gathering + st.approaching + st.returning + st.other;
				return all ? st.gathering / all : NaN;
			})),
			"trip": median(samples.map((s) => s.line.tripDist[res] ?? NaN)),
			"first": mean(samples.map((s) => s.line.order[0] === res ? 1 : 0))
		});
	}
	if (!perSide.length)
		return undefined;
	const over = (key: keyof Figures): number => mean(perSide.map((f) => f[key]));
	return {
		"income": over("income"), "estimate": over("estimate"), "wanted": over("wanted"), "rawRate": over("rawRate"),
		"gatherers": over("gatherers"), "perGatherer": over("perGatherer"), "gathering": over("gathering"),
		"trip": over("trip"), "first": over("first")
	};
}

const fmt = (value: number, digits = 1): string => Number.isFinite(value) ? value.toFixed(digits) : "-";

function bands(until: number): Array<[number, number]>
{
	const out: Array<[number, number]> = [];
	for (let from = 0; from < Math.min(until, 10); from += 2)
		out.push([from, Math.min(from + 2, until)]);
	if (until > 10)
		out.push([10, until]);
	return out;
}

function table(title: string, sides: Side[], until: number, resources: readonly Res[] = RESOURCES): string[]
{
	const out = [`${title} (${sides.length} sides; means per side, then over the sides):`,
		"  minutes  res      income  estimate  rawRate  wanted  gatherers  per-gath-min  gathering  trip  first"];
	for (const [from, to] of bands(until))
		for (const res of resources)
		{
			const f = figures(sides, res, from, to);
			if (!f || !f.gatherers && !f.income)
				continue;
			out.push(`  ${`${from}-${to}`.padEnd(7)}  ${res.padEnd(6)} ${fmt(f.income, 2).padStart(7)} ${fmt(f.estimate, 2).padStart(9)}` +
				` ${fmt(f.rawRate, 2).padStart(8)} ${fmt(f.wanted, 1).padStart(7)} ${fmt(f.gatherers).padStart(10)}` +
				` ${fmt(f.perGatherer).padStart(13)} ${fmt(100 * f.gathering, 0).padStart(9)}% ${fmt(f.trip, 0).padStart(5)}` +
				` ${fmt(100 * f.first, 0).padStart(5)}%`);
		}
	return out;
}

/**
 * Food by where it comes from, per band: each source's gatherers, the share
 * gathering, the rate per gatherer the walk included (the rates of those
 * gathering over all its gatherers), and the trip to the nearest dropsite.
 */
function foodTable(title: string, sides: Side[], until: number): string[]
{
	const out = [`food by source, ${title} (means per side, then over the sides):`,
		"  minutes  source  gatherers  gathering  rate/gatherer  trip"];
	const sources = ["fruit", "grain", "meat", "fish", "none"];
	for (const [from, to] of bands(until))
		for (const source of sources)
		{
			const perSide: Array<{ gatherers: number; gathering: number; rate: number; trip: number }> = [];
			for (const side of sides)
			{
				const samples = side.samples.filter((s) => s.t > from * 60 && s.t <= to * 60);
				if (!samples.length)
					continue;
				const entries = samples.map((s) => s.line.foodSources?.[source]);
				const n = entries.map((e) => e?.gatherers ?? 0);
				perSide.push({
					"gatherers": mean(n),
					"gathering": mean(entries.map((e) => e && e.gatherers ? e.gathering / e.gatherers : NaN)),
					"rate": mean(entries.map((e) => e && e.gatherers ? e.rate / e.gatherers : NaN)),
					"trip": median(entries.map((e) => e?.trip ?? NaN))
				});
			}
			const gatherers = mean(perSide.map((p) => p.gatherers));
			if (!(gatherers >= 0.05))
				continue;
			out.push(`  ${`${from}-${to}`.padEnd(7)}  ${source.padEnd(6)} ${fmt(gatherers).padStart(10)}` +
				` ${fmt(100 * mean(perSide.map((p) => p.gathering)), 0).padStart(9)}%` +
				` ${fmt(mean(perSide.map((p) => p.rate)), 3).padStart(14)} ${fmt(median(perSide.map((p) => p.trip)), 0).padStart(5)}`);
		}
	return out;
}

/** The pairs the logged bot won from one slot and lost from the other: won minus lost, per band. */
function splitPairs(sides: Side[], until: number): string[]
{
	const byPair = new Map<string, Side[]>();
	for (const side of sides)
		if (side.pair)
			(byPair.get(side.pair) ?? byPair.set(side.pair, []).get(side.pair))?.push(side);
	const split: Array<{ won: Side; lost: Side }> = [];
	for (const pairSides of byPair.values())
	{
		const won = pairSides.find((s) => s.result === "won");
		const lost = pairSides.find((s) => s.result === "lost");
		if (won && lost && pairSides.length === 2)
			split.push({ won, lost });
	}
	if (!split.length)
		return [];
	const out = [`seed pairs won from one slot, lost from the other (${split.length}): won minus lost,`,
		"mean difference and the pairs where the won game is ahead:",
		"  minutes  res      income       gatherers    per-gath-min  gathering    trip"];
	const keys: Array<keyof Figures> = ["income", "gatherers", "perGatherer", "gathering", "trip"];
	for (const [from, to] of bands(until))
		for (const res of RESOURCES)
		{
			const diffs = keys.map((key) => split.map(({ won, lost }) =>
				(figures([won], res, from, to)?.[key] ?? NaN) - (figures([lost], res, from, to)?.[key] ?? NaN))
				.filter(Number.isFinite));
			if (!diffs[1].length || diffs[1].every((d) => d === 0) && diffs[0].every((d) => d === 0))
				continue;
			const cell = (values: number[], scale = 1, digits = 1): string =>
				`${fmt(scale * mean(values), digits)} (${values.filter((d) => d > 0).length}/${values.length})`.padStart(12);
			out.push(`  ${`${from}-${to}`.padEnd(7)}  ${res.padEnd(6)} ${cell(diffs[0], 1, 2)} ${cell(diffs[1])}` +
				` ${cell(diffs[2])} ${cell(diffs[3], 100, 0)} ${cell(diffs[4], 1, 0)}`);
		}
	return out;
}

function main(args: string[]): void
{
	let until = 15;
	const dirs: string[] = [];
	for (let i = 0; i < args.length; ++i)
	{
		if (args[i] === "--until" && i + 1 < args.length)
			until = Number(args[++i]);
		else if (args[i].startsWith("--"))
			throw new Error(`unknown option ${args[i]} (see the header of build/petra_ts/economy-log.ts)`);
		else
			dirs.push(args[i]);
	}
	if (!dirs.length || !(until > 0))
		throw new Error("usage: node build/petra_ts/economy-log.ts <batch dir | match dir>... [--until MIN]");
	const sides = dirs.flatMap(readSides);
	if (!sides.length)
		throw new Error("no economy.txt in these folders (play with match.sh -b or batch.ts --bot-state)");
	const samples = sides.reduce((n, side) => n + side.samples.length, 0);
	const out = [`${sides.length} sides in ${new Set(sides.map((s) => s.game)).size} games, ${samples} samples`,
		"income: gathered per second (statistics); estimate: the bot's (GetCurrentGatherRates); rawRate: the sum",
		"of the gathering units' rates; per-gath-min: income per gatherer-minute; gathering: share of the",
		"gatherers gathering; trip: median supply-dropsite distance; first: share heading pickMostNeededResources", ""];
	out.push(...table("all sides", sides, until), "");
	if (sides.some((side) => side.samples.some((s) => s.line.foodSources)))
		out.push(...foodTable("all sides", sides, until), "");
	for (const result of ["won", "lost"] as const)
	{
		const some = sides.filter((s) => s.result === result);
		if (some.length)
			out.push(...table(`sides that ${result}`, some, Math.min(until, 10), ["food", "wood"]), "");
	}
	out.push(...splitPairs(sides, Math.min(until, 10)));
	console.log(out.join("\n"));
}

main(process.argv.slice(2));
