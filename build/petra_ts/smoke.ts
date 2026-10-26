/**
 * The smoke test: 24 fixed headless games of Petra TS (petra_out) against the
 * frozen port (petra_parity), checked game for game against a recorded
 * reference (build/petra_ts/smoke/reference.tsv):
 *
 *   node build/petra_ts/smoke.ts [--jobs J] [--update] [--from BATCH_DIR]
 *   npm run test:petra:smoke [-- options]
 *
 * The games are the reference's 12 map/AI seed pairs, each played from both
 * slots (mainland, athen, very hard, conquest, ended at 90 game minutes), as
 * one batch (batch.ts, J at a time, default 12) into
 * build/petra_ts/batches/smoke-<time>/. Each game's fingerprint hashes the
 * game time of the decision and both players' end statistics
 * (match-report.ts), so it moves with any change to how a game is played:
 *
 *   - a refactor (types, names, structure) must leave all 24 identical;
 *   - a change to the bot's play moves some: their seeds, old and new outcome
 *     and length are listed, and --update records the new games as the
 *     reference once the change is meant (commit the reference with it);
 *   - a change to the game data or the engine (templates, UnitAI, maps) moves
 *     them too, petra_parity's games included: record anew then as well.
 *
 * It fails on any game that differs from the reference, has a script error
 * or warning, or could not be played: an engine abort (status 134, about one
 * game in fifty) or hang (killed by batch.ts after 15 minutes) is played
 * again, up to twice, before it counts as failed.
 * --from checks (or, with --update, records) an existing batch instead of
 * playing one, e.g. a batch played with the reference's pairs by hand.
 * Exit status: 0 identical, 1 different or failed, 2 bad use.
 *
 * About 3-4 minutes with 12 jobs on 12+ cores; needs the engine built from this
 * repository (binaries/system/pyrogenesis). The win-rate of 24 games means
 * nothing; for strength, batch.ts with hundreds of games (PLAN.md §5.3).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BatchRow } from "./batch-stats.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const referencePath = join(here, "smoke", "reference.tsv");

/** One recorded game of the reference. */
interface ReferenceGame
{
	game: number;
	mapSeed: number;
	aiSeed: number;
	/** petra_parity played player 1 */
	swapped: boolean;
	outcome: string;
	reason: string;
	/** game ms of the decision */
	decided: number;
	fingerprint: string;
}

const COLUMNS = ["game", "mapSeed", "aiSeed", "swapped", "outcome", "reason", "decided", "fingerprint"] as const;

function fail(message: string): never
{
	console.error(`smoke: ${message}`);
	process.exit(2);
}

function parseOptions(args: string[]): { jobs: number; update: boolean; from: string | undefined }
{
	let jobs = 12;
	let update = false;
	let from: string | undefined;
	for (let i = 0; i < args.length; ++i)
	{
		if (args[i] === "--update")
			update = true;
		else if (args[i] === "--jobs" && i + 1 < args.length)
		{
			jobs = Number(args[++i]);
			if (!Number.isInteger(jobs) || jobs < 1)
				fail("--jobs takes a whole number from 1");
		}
		else if (args[i] === "--from" && i + 1 < args.length)
			from = resolve(args[++i]);
		else
			fail(`unknown option ${args[i]} (see the header of build/petra_ts/smoke.ts)`);
	}
	return { jobs, update, from };
}

function readReference(): ReferenceGame[]
{
	if (!existsSync(referencePath))
		fail(`no reference at ${referencePath}`);
	const lines = readFileSync(referencePath, "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
	const [header, ...rows] = lines;
	if (header !== COLUMNS.join("\t"))
		fail(`the reference's columns are not ${COLUMNS.join(", ")}`);
	return rows.map((line): ReferenceGame =>
	{
		const cells = line.split("\t");
		return {
			"game": Number(cells[0]), "mapSeed": Number(cells[1]), "aiSeed": Number(cells[2]),
			"swapped": cells[3] === "true", "outcome": cells[4], "reason": cells[5],
			"decided": Number(cells[6]), "fingerprint": cells[7]
		};
	});
}

/** The reference's seed pairs, once each, in game order. */
function pairsOf(reference: ReferenceGame[]): string
{
	const pairs: string[] = [];
	for (const game of reference)
	{
		const pair = `${game.mapSeed}/${game.aiSeed}`;
		if (!pairs.includes(pair))
			pairs.push(pair);
	}
	return pairs.join(",");
}

function readRows(batch: string): BatchRow[]
{
	const path = join(batch, "results.jsonl");
	if (!existsSync(path))
		fail(`no results.jsonl in ${batch}`);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line): BatchRow => JSON.parse(line))
		.sort((a, b) => a.game - b.game);
}

function git(...args: string[]): string
{
	return spawnSync("git", args, { "cwd": repoRoot, "encoding": "utf8" }).stdout.trim();
}

/** m:ss of a game time in ms */
function clock(ms: number | undefined): string
{
	if (ms === undefined)
		return "-";
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function play(pairs: string, jobs: number): string
{
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const out = join(repoRoot, "build/petra_ts/batches", `smoke-${stamp}`);
	const args = ["build/petra_ts/batch.ts", "--blue", "petra_out", "--red", "petra_parity",
		"--pairs", pairs, "--slots", "both", "--jobs", String(jobs), "--out", out];
	for (let attempt = 0; attempt < 3; ++attempt)
	{
		// a later attempt resumes the batch: only the games without a result play again
		const run = spawnSync(process.execPath, args, { "cwd": repoRoot, "stdio": ["ignore", "inherit", "inherit"] });
		if (run.status !== 0 && !existsSync(join(out, "results.jsonl")))
			fail(`the batch did not run (status ${run.status})`);
		if (!readRows(out).some((row) => row.outcome === "failed"))
			break;
		if (attempt < 2)
			console.log("smoke: replaying the games the engine did not finish");
	}
	return out;
}

function record(rows: BatchRow[], batch: string): void
{
	const dirty = git("status", "--porcelain", "--", "binaries/data/mods/public/simulation") !== "";
	const lines = [
		"# The smoke test's reference (build/petra_ts/smoke.ts, npm run test:petra:smoke):",
		"# 12 map/AI seed pairs, each from both slots (swapped: petra_parity is player 1),",
		"# petra_out against petra_parity, random/mainland, athen, difficulty 5 (very hard),",
		"# conquest, ended at 90 game minutes (match.sh -n -T -B); the fingerprint hashes the",
		"# decision's game time and both players' end statistics (match-report.ts).",
		`# Recorded from commit ${git("rev-parse", "HEAD")}${dirty ? " with uncommitted changes to the game" : ""},`,
		`# petra_parity from tag petra-ts-parity (${git("rev-parse", "--short", "petra-ts-parity^{commit}")}); batch ${batch.replace(repoRoot + "/", "")}.`,
		"# A change to the bot's play, the game data or the engine moves fingerprints:",
		"# record anew with --update when it is meant, and commit this file with it.",
		COLUMNS.join("\t"),
		...rows.map((row) => [row.game, row.mapSeed, row.aiSeed, row.swapped, row.outcome, row.reason ?? "",
			row.decided ?? "", row.fingerprint ?? ""].join("\t"))
	];
	writeFileSync(referencePath, lines.join("\n") + "\n");
	console.log(`smoke: recorded ${rows.length} games as the reference (${referencePath.replace(repoRoot + "/", "")})`);
}

function compare(reference: ReferenceGame[], rows: BatchRow[]): number
{
	const byGame = new Map(rows.map((row) => [row.game, row]));
	const differing: string[] = [];
	const broken: string[] = [];
	for (const expected of reference)
	{
		const row = byGame.get(expected.game);
		const seeds = `${expected.mapSeed}/${expected.aiSeed}${expected.swapped ? " swapped" : ""}`;
		if (!row || row.outcome === "failed")
		{
			broken.push(`game ${expected.game} (${seeds}): not played${row?.problem ? `, ${row.problem}` : ""}`);
			continue;
		}
		if (row.mapSeed !== expected.mapSeed || row.aiSeed !== expected.aiSeed || row.swapped !== expected.swapped)
			fail(`game ${expected.game} was played with other seeds than the reference's`);
		if (row.errors || row.warnings)
			broken.push(`game ${expected.game} (${seeds}): ${row.errors} errors, ${row.warnings} warnings`);
		if (row.fingerprint !== expected.fingerprint)
		{
			differing.push(`game ${expected.game} (${seeds}): ${expected.outcome} at ${clock(expected.decided)}` +
				` -> ${row.outcome} at ${clock(row.decided)}  (${expected.fingerprint} -> ${row.fingerprint})`);
		}
	}
	const same = reference.length - differing.length - broken.filter((b) => b.includes("not played")).length;
	console.log(`smoke: ${same} of ${reference.length} games identical to the reference`);
	for (const line of differing)
		console.log(`  differs: ${line}`);
	for (const line of broken)
		console.log(`  ${line}`);
	if (differing.length)
	{
		console.log("smoke: replay a game with the rerun line of its match.txt (games/<n>/), with -l to log its commands;");
		console.log("  where two command logs part: node build/petra_ts/command-diff.ts <dir> <dir>");
	}
	return differing.length || broken.length ? 1 : 0;
}

const options = parseOptions(process.argv.slice(2));
const reference = options.update && options.from ? [] : readReference();
if (!options.from && !existsSync(join(repoRoot, "binaries/system/pyrogenesis")))
	fail("needs the engine built from this repository (binaries/system/pyrogenesis)");
const batch = options.from ?? play(pairsOf(reference), options.jobs);
const rows = readRows(batch);
if (options.update)
{
	if (rows.some((row) => row.outcome === "failed" || row.errors || row.warnings))
		fail("a game failed or had errors: not recorded");
	record(rows, batch);
	process.exit(0);
}
process.exit(compare(reference, rows));
