/**
 * Plays a batch of headless matches between two bots in parallel and tabulates
 * the results, for win-rates (PLAN.md §5.3):
 *
 *   node build/petra_ts/batch.ts [options] [-- extra match.sh options]
 *   npm run batch:petra -- [options]
 *
 *   --blue BOT        petra_out, petra, petra_parity or petra_fixed (default petra_parity)
 *   --red BOT         the same choice (default petra_fixed)
 *   --games N         seed pairs to play (default 10)
 *   --slots one|both  both: each seed pair twice, the bots swapping slots, so
 *                     neither gets the better start (default: both for two
 *                     different bots, one for a mirror)
 *   --pairs M/A,...   play these map/AI seed pairs instead of a drawn pool
 *                     (--games and --seed are then ignored)
 *   --seed S          the seed pairs are drawn from S, so a pool is
 *                     reproducible (default 1)
 *   --jobs J          matches at a time (default 8)
 *   --map, --civ, --difficulty, --victory   as match.sh -m -c -d -w
 *                     (default random/mainland, athen, 5, conquest)
 *   --out DIR         the batch folder (default build/petra_ts/batches/<time>);
 *                     a folder of an earlier batch resumes it: games with a
 *                     result.json are not played again
 *   --twice N         also play the first N games a second time: the summary
 *                     checks each pair has the same fingerprint (determinism,
 *                     and that parallel games do not disturb each other)
 *   --keep-replays    keep each game's replay (by default deleted: the rerun
 *                     line of its match.txt plays the same game again)
 *
 * Every game is match.sh -n -T -B -r <out>/games/<n> (headless, decided or
 * ended at 90 game minutes, the bots as built once here); extra options such as
 * -t or -l are passed on. Matches run in parallel without sharing a path: each
 * job runs the engine with its own XDG_DATA_HOME, XDG_CONFIG_HOME,
 * XDG_CACHE_HOME and XDG_STATE_HOME under build/petra_ts/workers/<job>/
 * (kept between batches, so the engine's cache stays warm), which is where it
 * writes replays, logs, its config and its cache; each game checks that its
 * replay was written there.
 *
 * Writes to the batch folder: batch.txt (the settings, commit and bot hashes),
 * games/<n>/ (match.sh records), results.jsonl and results.tsv (one row per
 * game, BatchRow) and summary.txt (batch-stats.ts: win-rate, confidence
 * interval, SPRT, slot advantage, errors, determinism).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MatchResult } from "./match-report.ts";
import { summarise, type BatchRow } from "./batch-stats.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const matchScript = join(repoRoot, "build/petra_ts/match.sh");
const aiDir = join(repoRoot, "binaries/data/mods/public/simulation/ai");
const BOTS = ["petra_out", "petra", "petra_parity", "petra_fixed"];
/** match.sh options the batch sets itself */
const RESERVED = ["-o", "-p", "-x", "-s", "-a", "-m", "-c", "-d", "-w", "-r", "-k", "-b", "-B", "-n", "-T", "-h"];

function fail(message: string): never
{
	console.error(`batch: ${message}`);
	process.exit(2);
}

interface Options
{
	blue: string;
	red: string;
	games: number;
	slots: "one" | "both";
	seed: number;
	jobs: number;
	map: string;
	civ: string;
	difficulty: string;
	victory: string;
	out: string;
	keepReplays: boolean;
	twice: number;
	/** explicit [map seed, AI seed] pairs (--pairs) */
	pairs?: [number, number][];
	extra: string[];
}

function parseOptions(args: string[]): Options
{
	const split = args.indexOf("--");
	const extra = split == -1 ? [] : args.slice(split + 1);
	const own = split == -1 ? args : args.slice(0, split);
	const values = new Map<string, string>();
	let keepReplays = false;
	for (let i = 0; i < own.length; ++i)
	{
		const arg = own[i];
		if (arg == "--keep-replays")
			keepReplays = true;
		else if (["--blue", "--red", "--games", "--slots", "--seed", "--jobs", "--map", "--civ",
			"--difficulty", "--victory", "--out", "--twice", "--pairs"].includes(arg) && i + 1 < own.length)
			values.set(arg.slice(2), own[++i]);
		else
			fail(`unknown option ${arg} (see the header of build/petra_ts/batch.ts)`);
	}
	for (const arg of extra)
		if (RESERVED.includes(arg))
			fail(`${arg} is set by the batch itself, not passed to match.sh`);
	const blue = values.get("blue") ?? "petra_parity";
	const red = values.get("red") ?? "petra_fixed";
	for (const bot of [blue, red])
		if (!BOTS.includes(bot) && !bot.startsWith("petra_hybrid"))
			fail(`a bot is one of ${BOTS.join(", ")}, not ${bot}`);
	const count = (name: string, fallback: number, least = 1): number =>
	{
		const value = Number(values.get(name) ?? fallback);
		if (!Number.isInteger(value) || value < least)
			fail(`--${name} takes a whole number from ${least}`);
		return value;
	};
	const slots = values.get("slots") ?? (blue == red ? "one" : "both");
	if (slots != "one" && slots != "both")
		fail("--slots takes one or both");
	const pairs = values.get("pairs")?.split(",").map((pair): [number, number] =>
	{
		const seeds = pair.split("/").map(Number);
		if (seeds.length != 2 || !seeds.every(Number.isInteger))
			fail(`--pairs takes map/AI seed pairs like 314615891/911175050, not ${pair}`);
		return [seeds[0], seeds[1]];
	});
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return {
		blue,
		red,
		"games": count("games", 10),
		slots,
		"seed": count("seed", 1),
		"jobs": count("jobs", 8),
		"map": values.get("map") ?? "random/mainland",
		"civ": values.get("civ") ?? "athen",
		"difficulty": values.get("difficulty") ?? "5",
		"victory": values.get("victory") ?? "conquest",
		"out": resolve(values.get("out") ?? join(repoRoot, "build/petra_ts/batches", stamp)),
		keepReplays,
		"twice": count("twice", 0, 0),
		pairs,
		extra
	};
}

/** mulberry32: the seed pairs of a pool, the same for the same --seed. */
function seedPairs(seed: number, count: number): [number, number][]
{
	let state = seed >>> 0;
	const next = (): number =>
	{
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) % 1073741824;
	};
	return Array.from({ "length": count }, () => [next(), next()]);
}

interface Game
{
	index: number;
	mapSeed: number;
	aiSeed: number;
	/** the red bot plays player 1 (match.sh -x) */
	swapped: boolean;
	dir: string;
}

function bash(command: string): string
{
	return spawnSync("bash", ["-c", command], { "cwd": repoRoot, "encoding": "utf8" }).stdout.trim();
}

/** The same hash as match.sh prints for a bot's build. */
function botHash(bot: string): string
{
	return bot == "petra" ? "(the original, in git)" : bash(`cd ${JSON.stringify(join(aiDir, bot))} && ` +
		"find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1");
}

function build(options: Options): void
{
	const bots = new Set([options.blue, options.red]);
	const steps: [string, string[]][] = [["npm", ["run", "--silent", "build:petra:out"]]];
	const baselines = [...bots].flatMap(bot => bot == "petra_parity" ? ["parity"] : bot == "petra_fixed" ? ["fixed"] : []);
	if (baselines.length)
		steps.push([process.execPath, [join(repoRoot, "build/petra_ts/baselines.ts"), ...baselines]]);
	for (const [command, args] of steps)
		if (spawnSync(command, args, { "cwd": repoRoot, "stdio": "inherit" }).status !== 0)
			fail(`${command} ${args.join(" ")} failed`);
}

export function workerEnv(job: number | string): { env: NodeJS.ProcessEnv; root: string }
{
	const root = join(repoRoot, "build/petra_ts/workers", String(job));
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [name, sub] of [["XDG_DATA_HOME", "data"], ["XDG_CONFIG_HOME", "config"],
		["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"]])
	{
		env[name] = join(root, sub);
		mkdirSync(env[name], { "recursive": true });
	}
	return { env, root };
}

function play(options: Options, game: Game, job: number): Promise<BatchRow>
{
	const { env, root } = workerEnv(job);
	// The previous game's replays: the rerun line replays a game, and a
	// thousand games' replays would fill the disk.
	if (!options.keepReplays)
		rmSync(join(root, "data/0ad/replays"), { "recursive": true, "force": true });
	const args = [
		"-n", "-T", "-B",
		"-m", options.map, "-s", String(game.mapSeed), "-a", String(game.aiSeed),
		"-d", options.difficulty, "-c", options.civ, "-w", options.victory,
		"-o", options.blue, "-p", options.red,
		...(game.swapped ? ["-x"] : []),
		...options.extra,
		"-r", game.dir
	];
	const started = Date.now();
	return new Promise(done =>
	{
		const child = spawn(matchScript, args, { env, "cwd": repoRoot, "stdio": ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20000); });
		child.on("close", status =>
		{
			if (stderr)
				writeFileSync(join(game.dir, "stderr.txt"), stderr);
			done(row(options, game, status, (Date.now() - started) / 1000, job, root));
		});
	});
}

function row(options: Options, game: Game, status: number | null, wall: number, job: number, workerRoot: string): BatchRow
{
	const blueId = game.swapped ? 2 : 1;
	const redId = game.swapped ? 1 : 2;
	const base: BatchRow = {
		"game": game.index,
		"map": options.map,
		"mapSeed": game.mapSeed,
		"aiSeed": game.aiSeed,
		"blue": options.blue,
		"red": options.red,
		"swapped": game.swapped,
		"outcome": "failed",
		"wall": Math.round(wall),
		"worker": job,
		"errors": 0,
		"warnings": 0
	};
	const resultFile = join(game.dir, "result.json");
	if (status !== 0 || !existsSync(resultFile))
		return { ...base, "problem": `match.sh exit status ${status}${existsSync(resultFile) ? "" : ", no result.json"}` };
	const result: MatchResult = JSON.parse(readFileSync(resultFile, "utf8"));
	const report = readFileSync(join(game.dir, "match.txt"), "utf8");
	const replay = /^replay: (.*)$/m.exec(report)?.[1] ?? "";
	const problems: string[] = [];
	if (!replay.startsWith(workerRoot + "/"))
		problems.push(`replay written outside the worker's folder: ${replay}`);
	// match.sh finishes its record whatever the engine did; -T decides every
	// game it does not crash in.
	const engineStatus = Number(/game exit status (\d+)/.exec(report)?.[1] ?? "0");
	if (engineStatus != 0 || result.decided === undefined)
	{
		const crash = engineStatus != 0 ? `the engine exited with status ${engineStatus}` : "the game was not decided";
		return { ...base, "fingerprint": result.fingerprint, "problem": `${crash} at ${Math.round(result.played / 60000)} game min` +
			" (resume the batch to play it again)" };
	}
	const player = (id: number) => result.players.find(p => p.id == id);
	const blue = player(blueId);
	const red = player(redId);
	const winner = result.players.find(p => p.state == "won");
	const timeLimit = winner?.reason == "time limit";
	const outcome = !winner || timeLimit ? "draw" : winner.id == blueId ? "blue" : "red";
	return {
		...base,
		outcome,
		"reason": winner?.reason ?? (result.decided === undefined ? "undecided" : undefined),
		"decided": result.decided,
		"fingerprint": result.fingerprint,
		"errors": result.errors,
		"warnings": result.warnings,
		"blueStats": blue?.statistics,
		"redStats": red?.statistics,
		...(problems.length ? { "problem": problems.join("; ") } : {})
	};
}

const TSV_COLUMNS = ["game", "map", "mapSeed", "aiSeed", "blue", "red", "swapped", "outcome", "reason", "decided",
	"fingerprint", "errors", "warnings", "wall", "worker", "problem"];
const TSV_STATS = ["unitsTrained", "unitsLost", "enemyUnitsKilled", "resourcesGathered", "resourcesUsed",
	"peakPercentMapControlled"];

function writeTables(out: string, rows: BatchRow[]): void
{
	rows.sort((a, b) => a.game - b.game);
	writeFileSync(join(out, "results.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
	const header = [...TSV_COLUMNS, ...TSV_STATS.map(s => `blue.${s}`), ...TSV_STATS.map(s => `red.${s}`)];
	const cell = (value: unknown): string => value === undefined ? "" : String(value).replace(/[\t\n]/g, " ");
	const lines = rows.map(r => [
		...TSV_COLUMNS.map(c => cell((r as unknown as Record<string, unknown>)[c])),
		...TSV_STATS.map(s => cell(r.blueStats?.[s])),
		...TSV_STATS.map(s => cell(r.redStats?.[s]))
	].join("\t"));
	writeFileSync(join(out, "results.tsv"), [header.join("\t"), ...lines].join("\n") + "\n");
}

async function main(): Promise<void>
{
	const options = parseOptions(process.argv.slice(2));
	if (!existsSync(join(repoRoot, "binaries/system/pyrogenesis")))
		fail("binaries/system/pyrogenesis is missing: build the engine first (see CLAUDE.md)");
	const gamesDir = join(options.out, "games");
	if (existsSync(options.out) && readdirSync(options.out).length && !existsSync(join(options.out, "batch.txt")))
		fail(`${options.out} is not empty and holds no batch.txt; not writing into it`);
	mkdirSync(gamesDir, { "recursive": true });
	build(options);

	const games: Game[] = [];
	for (const [mapSeed, aiSeed] of options.pairs ?? seedPairs(options.seed, options.games))
		for (const swapped of options.slots == "both" ? [false, true] : [false])
		{
			const index = games.length + 1;
			games.push({ index, mapSeed, aiSeed, swapped, "dir": join(gamesDir, String(index).padStart(4, "0")) });
		}
	for (const game of games.slice(0, options.twice))
	{
		const index = games.length + 1;
		games.push({ ...game, index, "dir": join(gamesDir, String(index).padStart(4, "0")) });
	}

	const commit = bash("git log -1 --format='%H %cs \"%s\"'") +
		(bash("git status --porcelain --untracked-files=normal") ? " (with uncommitted changes)" : "");
	const settings = [
		`blue ${options.blue} ${botHash(options.blue)}`,
		`red ${options.red} ${botHash(options.red)}`,
		...(options.blue == "petra_parity" || options.red == "petra_parity"
			? [`petra_parity from tag petra-ts-parity ${bash("git rev-parse --short=10 'petra-ts-parity^{commit}'")}`] : []),
		`games ${games.length} (${options.pairs ? `the seed pairs ${options.pairs.map(p => p.join("/")).join(",")}` :
			`${options.games} seed pairs, pool seed ${options.seed}`}, slots ${options.slots}` +
		`${options.twice ? `, the first ${options.twice} played twice` : ""})`,
		`map ${options.map}, civ ${options.civ}, difficulty ${options.difficulty}, victory ${options.victory}`,
		`match.sh -n -T -B${options.extra.length ? " " + options.extra.join(" ") : ""}, ${options.jobs} at a time`,
		`commit ${commit}`
	];
	const batchFile = join(options.out, "batch.txt");
	if (existsSync(batchFile))
	{
		const before = readFileSync(batchFile, "utf8").split("\n").slice(0, 2).join("\n");
		if (before != settings.slice(0, 2).join("\n"))
			console.warn(`batch: resuming with other bot builds than before:\n${before}\nnow:\n${settings.slice(0, 2).join("\n")}`);
	}
	writeFileSync(batchFile, settings.join("\n") + `\nstarted ${new Date().toISOString()}\n`);
	console.log(settings.join("\n"));
	console.log(`batch: ${relative(repoRoot, options.out)}`);

	// Games already played (a resumed batch) stay, read again from their
	// records, so that a check added since applies to them too; a failed one
	// is played again.
	const rows: BatchRow[] = [];
	const previous = join(options.out, "results.jsonl");
	const done = new Set<number>();
	const before = new Map<number, BatchRow>();
	if (existsSync(previous))
		for (const line of readFileSync(previous, "utf8").split("\n").filter(Boolean))
		{
			const old: BatchRow = JSON.parse(line);
			before.set(old.game, old);
		}
	for (const game of games)
	{
		const old = before.get(game.index);
		if (!old || !existsSync(join(game.dir, "result.json")))
			continue;
		const again = row(options, game, 0, old.wall, old.worker, workerEnv(old.worker).root);
		if (again.outcome == "failed")
			continue;
		rows.push(again);
		done.add(game.index);
	}
	const queue = games.filter(g => !done.has(g.index));
	if (done.size)
		console.log(`batch: ${done.size} games already played, ${queue.length} to play`);

	let finished = 0;
	const startTime = Date.now();
	const worker = async (job: number): Promise<void> =>
	{
		for (let game = queue.shift(); game; game = queue.shift())
		{
			const result = await play(options, game, job);
			rows.push(result);
			writeTables(options.out, rows);
			++finished;
			const elapsed = (Date.now() - startTime) / 1000;
			console.log(`[${finished + done.size}/${games.length}] ` +
				`game ${result.game} (${result.swapped ? "red" : "blue"} is player 1, seeds ${result.mapSeed}/${result.aiSeed}): ` +
				`${result.outcome}${result.reason ? ` (${result.reason})` : ""}` +
				`${result.decided !== undefined ? ` at ${Math.round(result.decided / 60000)} min` : ""}, ${result.wall} s` +
				`${result.problem ? `, PROBLEM: ${result.problem}` : ""}  [${Math.round(elapsed)} s elapsed]`);
		}
	};
	await Promise.all(Array.from({ "length": Math.min(options.jobs, queue.length) }, (_, job) => worker(job)));

	writeTables(options.out, rows);
	const summary = summarise(rows);
	writeFileSync(join(options.out, "summary.txt"), summary + "\n");
	writeFileSync(batchFile, readFileSync(batchFile, "utf8") + `ended ${new Date().toISOString()}\n`);
	console.log(summary);
	console.log(`batch: ${relative(repoRoot, options.out)}`);
}

if (import.meta.main)
	await main();
