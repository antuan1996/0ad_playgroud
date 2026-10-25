/**
 * Where two games' command logs part (match.sh -l, commands.txt), for the
 * parity proof (PLAN.md §5.1).
 *
 *   node build/petra_ts/command-diff.ts <match dir> <match dir> [--context N]
 *   node build/petra_ts/command-diff.ts <batch dir> [--context N]
 *
 * Two records: the first line where their commands differ, with N lines
 * (default 5) before it from both, and how many commands each logged.
 * A batch (batch.ts ... -- -l, slots both): each seed pair's two games, one
 * per slot. With two bots that play alike the swapped game is the same game,
 * so its log must be the same, line for line; the first difference says when
 * and for which player the two bots first chose differently.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchRow } from "./batch-stats.ts";

export interface Divergence
{
	/** 0-based line of the first difference; undefined if the logs are the same */
	line?: number;
	/** game ms and player of the first differing command, from either log */
	time?: number;
	player?: number;
	lengths: [number, number];
}

const parse = (line: string | undefined): { time: number; player: number } | undefined =>
{
	const match = line && /^(\d+) (\d+) /.exec(line);
	return match ? { "time": Number(match[1]), "player": Number(match[2]) } : undefined;
};

export function diverge(a: string[], b: string[]): Divergence
{
	const lengths: [number, number] = [a.length, b.length];
	const end = Math.min(a.length, b.length);
	let line = 0;
	while (line < end && a[line] == b[line])
		++line;
	if (line == end && a.length == b.length)
		return { lengths };
	// The earlier of the two commands is where play first differs.
	const first = [parse(a[line]), parse(b[line])].filter(c => c !== undefined).sort((x, y) => x.time - y.time)[0];
	return { line, "time": first?.time, "player": first?.player, lengths };
}

const readLog = (dir: string): string[] =>
	readFileSync(join(dir, "commands.txt"), "utf8").split("\n").filter(Boolean);
const clock = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function describe(d: Divergence): string
{
	return d.line === undefined ? `same ${d.lengths[0]} commands` :
		`differ from command ${d.line + 1} at ${clock(d.time ?? 0)}, player ${d.player} (${d.lengths[0]} and ${d.lengths[1]} commands)`;
}

function showPair(dirA: string, dirB: string, context: number): void
{
	const a = readLog(dirA);
	const b = readLog(dirB);
	const d = diverge(a, b);
	console.log(describe(d));
	if (d.line === undefined)
		return;
	const from = Math.max(0, d.line - context);
	for (const [label, log] of [[dirA, a], [dirB, b]] as const)
	{
		console.log(`--- ${label}`);
		for (let i = from; i < Math.min(log.length, d.line + context + 1); ++i)
			console.log(`${i == d.line ? ">" : " "} ${i + 1}: ${log[i].length > 400 ? log[i].slice(0, 400) + "..." : log[i]}`);
	}
}

function showBatch(dir: string): void
{
	const rows: BatchRow[] = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	const games = new Map(readdirSync(join(dir, "games")).map(name => [Number(name), join(dir, "games", name)]));
	const pairs = new Map<string, BatchRow[]>();
	for (const r of rows)
		pairs.set(`${r.mapSeed}/${r.aiSeed}`, [...pairs.get(`${r.mapSeed}/${r.aiSeed}`) ?? [], r]);
	let same = 0;
	for (const [seeds, list] of pairs)
	{
		const straight = list.find(r => !r.swapped);
		const swapped = list.find(r => r.swapped);
		const dirs = [straight, swapped].map(r => r && games.get(r.game));
		if (!dirs[0] || !dirs[1] || !dirs.every(d => d && existsSync(join(d, "commands.txt"))))
		{
			console.log(`${seeds}: no command logs from both slots (play the batch with -- -l and --slots both)`);
			continue;
		}
		const d = diverge(readLog(dirs[0]), readLog(dirs[1]));
		if (d.line === undefined)
			++same;
		console.log(`${seeds} (games ${straight?.game}, ${swapped?.game}): ${describe(d)}`);
	}
	console.log(`${same} of ${pairs.size} seed pairs with the same commands from both slots`);
}

if (import.meta.main)
{
	const args = process.argv.slice(2);
	const at = args.indexOf("--context");
	const context = at == -1 ? 5 : Number(args[at + 1]);
	const dirs = at == -1 ? args : args.filter((_, i) => i != at && i != at + 1);
	if (dirs.length == 2)
		showPair(dirs[0], dirs[1], context);
	else if (dirs.length == 1 && existsSync(join(dirs[0], "results.jsonl")))
		showBatch(dirs[0]);
	else
	{
		console.error("usage: node build/petra_ts/command-diff.ts <match dir> <match dir> | <batch dir> [--context N]");
		process.exit(2);
	}
}
