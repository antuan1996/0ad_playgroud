/**
 * Reads the attack plans' lives that Petra TS logs with match.sh -b
 * (attacks.txt, bot-state.js) and summarises them:
 *
 *   node build/petra_ts/attack-log.ts <batch dir | match dir>... [--json]
 *
 * A batch is one played with batch.ts --bot-state (only Petra TS logs; in a
 * game against a baseline that is the blue bot, player 1 unless swapped). For
 * each attack type: how many plans were created, started, aborted, finished
 * or still preparing when the game ended; how long they prepared; why the
 * aborted ones went (read from the plan's last snapshot: at the population
 * cap without the units to start, out of build orders, without a target);
 * what the long preparations lacked (the categories below their minimum,
 * nothing queued, paused queues); and how the games Petra TS won differ from
 * those it lost (when its attacks started, how many, how big).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A plan in preparation as the log saw it (bot-state.js attackSnapshot). */
interface Snapshot
{
	state: string;
	units: number;
	/** category -> [units, minimum, target] */
	cats: Record<string, [number, number, number]>;
	queued: number;
	paused: boolean;
	account?: Record<string, number>;
	canStart: boolean;
	buildOrders: number;
	pop: number;
	popMax: number;
	workers: number;
	stock: Record<string, number>;
}

interface LogLine extends Partial<Snapshot>
{
	t: number;
	player: number;
	event: "created" | "started" | "aborted" | "finished" | "progress" | "error";
	name: number;
	type: string;
	age: number;
	last?: Snapshot;
	stateAtEnd?: string;
	unitsAtEnd?: number;
	atStart?: number;
	inField?: number;
	error?: string;
}

/** One plan's life. */
interface Plan
{
	game: string;
	player: number;
	name: number;
	type: string;
	created: number;
	started?: number;
	ended?: number;
	end: "started" | "aborted" | "preparing";
	finished?: number;
	atStart?: number;
	unitsAtFinish?: number;
	/** the last snapshot while it prepared */
	last?: Snapshot;
	/** an aborted plan's state and units as it went */
	stateAtEnd?: string;
	unitsAtEnd?: number;
	/** game seconds of its last line */
	lastSeen: number;
}

/** Seconds a plan prepared: to its start, its abort, or its last line if the game ended first. */
function prepared(plan: Plan): number
{
	return (plan.started ?? plan.ended ?? plan.lastSeen) - plan.created;
}

/** One logging player in one game. */
interface Side
{
	game: string;
	player: number;
	result: "won" | "lost" | "draw" | "?";
	decided?: number;
	plans: Plan[];
}

interface BatchRow
{
	game: number;
	swapped: boolean;
	outcome: string;
	decided?: number;
}

function readLines(file: string): LogLine[]
{
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine);
}

function plansOf(game: string, lines: LogLine[]): Map<number, Plan[]>
{
	const byPlayer = new Map<number, Map<number, Plan>>();
	for (const line of lines)
	{
		if (line.event === "error")
			continue;
		const plans = byPlayer.get(line.player) ?? byPlayer.set(line.player, new Map()).get(line.player)!;
		let plan = plans.get(line.name);
		if (!plan || line.event === "created" && plan.end !== "preparing")
		{
			plan = { game, "player": line.player, "name": line.name, "type": line.type, "created": line.t - line.age,
				"end": "preparing", "lastSeen": line.t };
			plans.set(line.name, plan);
		}
		plan.lastSeen = line.t;
		switch (line.event)
		{
		case "created":
		case "progress":
			plan.last = line as Snapshot;
			break;
		case "started":
			plan.end = "started";
			plan.started = line.t;
			plan.atStart = line.units;
			break;
		case "aborted":
			plan.end = "aborted";
			plan.ended = line.t;
			plan.last = line.last ?? plan.last;
			plan.stateAtEnd = line.stateAtEnd;
			plan.unitsAtEnd = line.unitsAtEnd;
			break;
		case "finished":
			plan.finished = line.t;
			plan.unitsAtFinish = line.units;
			break;
		}
	}
	return new Map([...byPlayer].map(([player, plans]) => [player, [...plans.values()]]));
}

/** The sides of a batch folder or of one match folder. */
function readSides(dir: string): Side[]
{
	const sides: Side[] = [];
	if (existsSync(join(dir, "results.jsonl")))
	{
		const rows = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as BatchRow);
		for (const row of rows)
		{
			const file = join(dir, "games", String(row.game).padStart(4, "0"), "attacks.txt");
			if (!existsSync(file))
				continue;
			for (const [player, plans] of plansOf(`${dir}#${row.game}`, readLines(file)))
			{
				// blue is player 1 unless the slots were swapped
				const color = (player === 1) !== row.swapped ? "blue" : "red";
				const result = row.outcome === "draw" || row.outcome === "failed" ? "draw" : row.outcome === color ? "won" : "lost";
				sides.push({ "game": `${dir}#${row.game}`, player, result, "decided": row.decided, plans });
			}
		}
		return sides;
	}
	const file = join(dir, "attacks.txt");
	if (!existsSync(file))
		throw new Error(`no attacks.txt or results.jsonl in ${dir}`);
	let winners: number[] = [];
	if (existsSync(join(dir, "result.json")))
	{
		const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		winners = (result.players ?? []).filter((p: { state: string }) => p.state === "won").map((p: { id: number }) => p.id);
	}
	for (const [player, plans] of plansOf(dir, readLines(file)))
		sides.push({ "game": dir, player, "result": winners.length ? winners.includes(player) ? "won" : "lost" : "?", plans });
	return sides;
}

const median = (values: number[]): number =>
{
	if (!values.length)
		return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const quantile = (values: number[], q: number): number =>
{
	if (!values.length)
		return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const minutes = (s: number): string => Number.isNaN(s) ? "-" : (s / 60).toFixed(1);
const pct = (n: number, of: number): string => of ? `${Math.round(100 * n / of)}%` : "-";

/** Why a plan left preparation without starting, read from its last snapshot. */
function abortCause(plan: Plan): string
{
	const last = plan.last;
	if (plan.stateAtEnd === "completing" || last?.state === "completing")
		return "no target to start on";
	if (!last)
		return "no snapshot";
	if (last.popMax - last.pop < 5 && !last.canStart)
		return "at the population cap, short of its minimum";
	if (last.buildOrders === 0)
		return "no build order left";
	return "other";
}

function report(sides: Side[]): string
{
	const out: string[] = [];
	const plans = sides.flatMap((side) => side.plans);
	const types = [...new Set(plans.map((plan) => plan.type))].sort();
	out.push(`${sides.length} sides (a logging bot in a game), ${plans.length} attack plans; ` +
		`won ${sides.filter((s) => s.result === "won").length}, lost ${sides.filter((s) => s.result === "lost").length}, ` +
		`drawn or unknown ${sides.filter((s) => s.result === "draw" || s.result === "?").length}`);
	out.push("");
	out.push("plans per type:          created  started  aborted  preparing at the end   per side");
	for (const type of types)
	{
		const of = plans.filter((plan) => plan.type === type);
		const count = (end: Plan["end"]): number => of.filter((plan) => plan.end === end).length;
		out.push(`  ${type.padEnd(22)} ${String(of.length).padStart(7)}  ${String(count("started")).padStart(7)}` +
			`  ${String(count("aborted")).padStart(7)}  ${String(count("preparing")).padStart(9)}             ${(of.length / sides.length).toFixed(1)}`);
	}
	out.push("");
	out.push("preparation, minutes (median / 90th percentile):");
	for (const type of types)
	{
		const started = plans.filter((plan) => plan.type === type && plan.started !== undefined);
		const aborted = plans.filter((plan) => plan.type === type && plan.end === "aborted");
		const startAt = started.map((plan) => plan.started! - plan.created);
		const abortAt = aborted.map((plan) => plan.ended! - plan.created);
		out.push(`  ${type.padEnd(12)} to start ${minutes(median(startAt))} / ${minutes(quantile(startAt, 0.9))}` +
			`   to abort ${minutes(median(abortAt))} / ${minutes(quantile(abortAt, 0.9))}` +
			`   units at start ${median(started.map((plan) => plan.atStart ?? 0))}`);
	}
	out.push("");
	const aborted = plans.filter((plan) => plan.end === "aborted");
	out.push(`aborts: ${aborted.length}`);
	const causes = new Map<string, Plan[]>();
	for (const plan of aborted)
		(causes.get(abortCause(plan)) ?? causes.set(abortCause(plan), []).get(abortCause(plan))!).push(plan);
	for (const [cause, list] of [...causes].sort((a, b) => b[1].length - a[1].length))
	{
		const quick = list.filter((plan) => plan.ended! - plan.created < 30).length;
		const byType = [...new Set(list.map((plan) => plan.type))].map((type) => `${type} ${list.filter((p) => p.type === type).length}`).join(", ");
		const held = list.map((plan) => plan.unitsAtEnd ?? plan.last?.units).filter((n): n is number => n !== undefined);
		out.push(`  ${cause}: ${list.length} (${quick} within 30 s of creation; ${byType}; median units held ${median(held)})`);
	}
	const churnSides = sides.map((side) => ({ side, "quick": side.plans.filter((plan) => plan.end === "aborted" && plan.ended! - plan.created < 30).length }))
		.filter((entry) => entry.quick > 0).sort((a, b) => b.quick - a.quick);
	out.push(`  churn (plans aborted within 30 s): in ${churnSides.length} of ${sides.length} sides; most: ` +
		churnSides.slice(0, 5).map((entry) => `${entry.side.game.split("/").pop()} p${entry.side.player} ${entry.quick} (${entry.side.result})`).join(", "));
	out.push("");
	const long = plans.filter((plan) => prepared(plan) > 600);
	const stuck = long.filter((plan) => plan.end !== "started" && plan.last);
	out.push(`long preparations (over 10 minutes and never started, or still preparing at the end): ${stuck.length}` +
		` (${long.length} plans prepared over 10 minutes in all)`);
	if (stuck.length)
	{
		const lacking = new Map<string, number>();
		let nothingQueued = 0;
		let paused = 0;
		let atCap = 0;
		for (const plan of stuck)
		{
			const last = plan.last!;
			for (const [cat, [have, min]] of Object.entries(last.cats))
				if (have < min)
					lacking.set(cat, (lacking.get(cat) ?? 0) + 1);
			if (last.queued === 0)
				++nothingQueued;
			if (last.paused)
				++paused;
			if (last.popMax - last.pop < 5)
				++atCap;
		}
		out.push(`  last seen: nothing queued ${pct(nothingQueued, stuck.length)}, queues paused ${pct(paused, stuck.length)},` +
			` at the population cap ${pct(atCap, stuck.length)}`);
		out.push(`  median free population ${median(stuck.map((p) => p.last!.popMax - p.last!.pop))}, workers ${median(stuck.map((p) => p.last!.workers))},` +
			` units ${median(stuck.map((p) => p.last!.units))}, stock food/wood/stone/metal ` +
			["food", "wood", "stone", "metal"].map((r) => median(stuck.map((p) => p.last!.stock[r] ?? 0))).join("/"));
		out.push("  categories below their minimum: " + [...lacking].sort((a, b) => b[1] - a[1])
			.map(([cat, n]) => `${cat} ${pct(n, stuck.length)}`).join(", "));
	}
	out.push("");
	out.push("won against lost (median per side):");
	for (const result of ["won", "lost"] as const)
	{
		const of = sides.filter((side) => side.result === result);
		if (!of.length)
			continue;
		const firstStart = (side: Side, type?: string): number =>
			Math.min(...side.plans.filter((plan) => plan.started !== undefined && (!type || plan.type === type)).map((plan) => plan.started!));
		const finite = (values: number[]): number[] => values.filter(Number.isFinite);
		const startedOf = (side: Side): Plan[] => side.plans.filter((plan) => plan.started !== undefined);
		out.push(`  ${result} (${of.length}): attacks started ${median(of.map((s) => startedOf(s).length))},` +
			` first start at minute ${minutes(median(finite(of.map((s) => firstStart(s)))))}` +
			` (none in ${of.filter((s) => !Number.isFinite(firstStart(s))).length}),` +
			` first Attack/HugeAttack at ${minutes(median(finite(of.map((s) => Math.min(firstStart(s, "Attack"), firstStart(s, "HugeAttack"))))))},` +
			` units at start ${median(of.flatMap((s) => startedOf(s).map((p) => p.atStart ?? 0)))},` +
			` aborts ${median(of.map((s) => s.plans.filter((p) => p.end === "aborted").length))},` +
			` game decided at minute ${minutes(median(of.map((s) => (s.decided ?? NaN) / 1000).filter(Number.isFinite)))}`);
	}
	return out.join("\n");
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const dirs = args.filter((arg) => arg !== "--json");
if (!dirs.length)
{
	console.error("usage: node build/petra_ts/attack-log.ts <batch dir | match dir>... [--json]");
	process.exit(2);
}
const sides = dirs.flatMap(readSides);
if (json)
	console.log(JSON.stringify(sides));
else
	console.log(report(sides));
