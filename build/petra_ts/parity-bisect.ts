/**
 * Which module makes petra_fixed play differently from petra_parity in a game
 * (PLAN.md §5.1, stage 1).
 *
 *   node build/petra_ts/parity-bisect.ts --pair M/A --player P [--with m1,m2] [--jobs J] [--out DIR]
 *
 * Plays the map/AI seed pair M/A with petra_parity as the other player and, as
 * player P: petra_parity, petra_fixed, and for each module of the bot a
 * hybrid (baselines.ts hybrid): petra_fixed with that one module, plus the
 * --with ones, taken from the port. All with command logs (match.sh -l), J at
 * a time (default 12), each with its own XDG folders (workers/bisect-<n>).
 * The two reference games come first and play to the end: where
 * petra_fixed's log first differs from petra_parity's is the divergence. The
 * hybrids then play only to 2 game minutes past it (match.sh -L), and their
 * logs are compared with petra_parity's up to that minute: a hybrid that
 * plays on past the divergence holds the module that makes the difference (a
 * difference spread over two modules needs one of them in --with).
 *
 * The games go to DIR (default build/petra_ts/batches/bisect-<M>-<A>-p<P>);
 * the hybrid bots are removed at the end.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerEnv } from "./batch.ts";
import { diverge, type Divergence } from "./command-diff.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const aiDir = join(repoRoot, "binaries/data/mods/public/simulation/ai");

function fail(message: string): never
{
	console.error(`parity-bisect: ${message}`);
	process.exit(2);
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
{
	const at = args.indexOf(`--${name}`);
	return at == -1 ? undefined : args[at + 1];
};
const pair = option("pair")?.split("/").map(Number);
const player = Number(option("player"));
if (!pair || pair.length != 2 || !pair.every(Number.isInteger) || (player != 1 && player != 2))
	fail("usage: --pair MAPSEED/AISEED --player 1|2 [--with m1,m2] [--jobs J] [--out DIR]");
const withModules = option("with")?.split(",").filter(Boolean) ?? [];
const jobs = Number(option("jobs") ?? 12);
const out = resolve(option("out") ?? join(repoRoot, "build/petra_ts/batches", `bisect-${pair[0]}-${pair[1]}-p${player}`));

if (spawnSync(process.execPath, [join(repoRoot, "build/petra_ts/baselines.ts")], { "stdio": "inherit" }).status !== 0)
	fail("building the baselines failed");
const modules = readdirSync(join(aiDir, "petra_parity")).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3))
	.filter(m => !withModules.includes(m));

interface Run
{
	label: string;
	bot: string;
	dir: string;
	divergence?: Divergence;
}
const runs: Run[] = [
	{ "label": "petra_parity", "bot": "petra_parity", "dir": join(out, "parity") },
	{ "label": "petra_fixed" + (withModules.length ? ` + ${withModules.join(", ")}` : ""),
		"bot": withModules.length ? "petra_hybrid_with" : "petra_fixed", "dir": join(out, "fixed") },
	...modules.map(m => ({ "label": m, "bot": `petra_hybrid_${m}`, "dir": join(out, m) }))
];
for (const run of runs)
	if (run.bot.startsWith("petra_hybrid"))
	{
		const own = run.bot == "petra_hybrid_with" ? [] : [run.label];
		const built = spawnSync(process.execPath, [join(repoRoot, "build/petra_ts/baselines.ts"), "hybrid", run.bot,
			...withModules, ...own], { "stdio": "inherit" });
		if (built.status !== 0)
			fail(`building ${run.bot} failed`);
	}

function play(run: Run, job: number, limit?: number): Promise<void>
{
	const { env } = workerEnv(`bisect-${job}`);
	const bots = player == 1 ? ["-o", run.bot, "-p", "petra_parity"] : ["-o", "petra_parity", "-p", run.bot];
	const matchArgs = ["-n", "-T", "-B", "-l", "-m", "random/mainland", "-s", String(pair?.[0]), "-a", String(pair?.[1]),
		"-d", "5", "-c", "athen", "-w", "conquest", ...bots,
		...(limit ? ["-L", String(limit)] : []), "-r", run.dir];
	return new Promise(done =>
	{
		const child = spawn(join(repoRoot, "build/petra_ts/match.sh"), matchArgs, { env, "stdio": "ignore" });
		child.on("close", () => done());
	});
}

let finished = 0;
async function playAll(list: Run[], limit?: number): Promise<void>
{
	const queue = [...list];
	await Promise.all(Array.from({ "length": Math.min(jobs, queue.length) }, async (_, job) =>
	{
		for (let run = queue.shift(); run; run = queue.shift())
		{
			await play(run, job, limit);
			console.log(`[${++finished}/${runs.length}] ${run.label}`);
		}
	}));
}

const log = (dir: string): string[] =>
	existsSync(join(dir, "commands.txt")) ? readFileSync(join(dir, "commands.txt"), "utf8").split("\n").filter(Boolean) : [];
await playAll(runs.slice(0, 2));
const reference = log(runs[0].dir);
const base = diverge(reference, log(runs[1].dir));
runs[1].divergence = base;
// The hybrids need play only a little past the divergence.
const limit = base.line === undefined ? undefined : Math.floor((base.time ?? 0) / 60000) + 2;
if (limit !== undefined)
{
	await playAll(runs.slice(2), limit);
	const upToLimit = reference.filter(line => Number(line.split(" ", 1)[0]) < limit * 60000);
	for (const run of runs.slice(2))
		run.divergence = diverge(upToLimit, log(run.dir).filter(line => Number(line.split(" ", 1)[0]) < limit * 60000));
}
const clock = (ms = 0): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const describe = (d?: Divergence): string => !d ? "no log" : d.line === undefined ?
	`the same commands as petra_parity${limit !== undefined && d !== base ? ` up to minute ${limit}` : ""}` :
	`differs from command ${d.line + 1} at ${clock(d.time)} (player ${d.player})`;
console.log(`${runs[1].label}: ${describe(base)}`);
if (base?.line === undefined)
	console.log("nothing to bisect: petra_fixed plays as petra_parity in this game");
else
{
	const further = runs.slice(2).filter(r => (r.divergence?.line ?? Infinity) > (base.line ?? 0))
		.sort((a, b) => (b.divergence?.line ?? Infinity) - (a.divergence?.line ?? Infinity));
	console.log(further.length ? "modules that play past the divergence when taken from the port:" :
		"no single module plays past the divergence: the difference spans modules (try --with)");
	for (const r of further)
		console.log(`  ${r.label}: ${describe(r.divergence)}`);
}
for (const run of runs)
	if (run.bot.startsWith("petra_hybrid"))
		rmSync(join(aiDir, run.bot), { "recursive": true, "force": true });
console.log(`games: ${out}`);
