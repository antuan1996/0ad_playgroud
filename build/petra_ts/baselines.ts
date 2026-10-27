/**
 * Builds the two baseline bots every measurement of Petra TS is made against
 * (PLAN.md §2), next to petra_out in simulation/ai/ (both gitignored):
 *
 *   petra_parity  "Petra TS parity": the port as frozen at the tag
 *                 petra-ts-parity, compiled from that tag's sources (git
 *                 archive into a temporary folder, tsc, prepare-bot.ts), so it
 *                 stays the same whatever petra_ts becomes.
 *   petra_prev    "Petra TS previous": the port at the tag petra-ts-prev, built
 *                 the same way: the version before the change being measured
 *                 (stage 5: each change must not lose to it; move the tag,
 *                 git tag -f petra-ts-prev <commit>, when a change is kept).
 *   petra_fixed   "Petra fixed": the original petra/*.js with
 *                 upstream/petra-fixes.patch applied, a fair Petra (the
 *                 unpatched one loses to its removeSupply bug).
 *
 *   node build/petra_ts/baselines.ts [parity] [prev] [fixed]   (parity and fixed by default)
 *   node build/petra_ts/baselines.ts hybrid ID MODULE...
 *
 * hybrid, for the parity proof (parity-bisect.ts): builds the bot
 * simulation/ai/ID (ID starts with petra_hybrid) as petra_fixed with the
 * named modules (like baseManager) taken from petra_parity instead, both
 * already built. The port is one file per original file with the same exports,
 * so the modules mix; the helpers only the port exports (requireValue,
 * requireTemplate, requireMetadata, samePlanType) are appended to the
 * original's entityExtend.js and queueplan.js where those stay the original's.
 * A game where the hybrid plays as petra_parity does shows which modules hold
 * a difference.
 *
 * `npm run build:petra:baselines` runs it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PARITY_TAG = "petra-ts-parity";
export const PREV_TAG = "petra-ts-prev";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const aiDir = join(repoRoot, "binaries/data/mods/public/simulation/ai");

function fail(message: string): never
{
	console.error(`baselines: ${message}`);
	process.exit(1);
}

/** Runs a command to completion, its output passed through; fails if it does. */
function run(command: string, args: string[], options: { cwd?: string; input?: Buffer } = {}): Buffer
{
	const result = spawnSync(command, args, {
		"cwd": options.cwd ?? repoRoot,
		"input": options.input,
		"stdio": [options.input ? "pipe" : "inherit", "pipe", "inherit"],
		"maxBuffer": 1 << 30
	});
	if (result.status !== 0)
		fail(`${command} ${args.join(" ")} failed (status ${result.status})`);
	return result.stdout;
}

/** Compiles the port's sources at a tag into simulation/ai/<bot> and finishes it as that bot. */
function buildFromTag(tag: string, bot: string): void
{
	const commit = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`],
		{ "cwd": repoRoot, "encoding": "utf8" }).stdout.trim();
	if (!commit)
		fail(`no tag ${tag}: it marks the port the baseline ${bot} is built from (PLAN.md §2)`);
	const sources = mkdtempSync(join(tmpdir(), `${bot}-`));
	try
	{
		const archive = run("git", ["archive", commit, "binaries/data/mods/public/simulation/ai/petra_ts",
			"build/petra_ts/tsconfig.json", "build/petra_ts/tsconfig.build.json"]);
		run("tar", ["-x", "-C", sources], { "input": archive });
		const outDir = join(aiDir, bot);
		rmSync(outDir, { "recursive": true, "force": true });
		run(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"),
			"-p", join(sources, "build/petra_ts/tsconfig.build.json"), "--outDir", outDir]);
		process.stdout.write(run(process.execPath, [join(repoRoot, "build/petra_ts/prepare-bot.ts"), `--bot=${bot}`]));
		console.log(`baselines: ${bot} built from ${tag} (${commit.slice(0, 10)})`);
	}
	finally
	{
		rmSync(sources, { "recursive": true, "force": true });
	}
}

function buildFixed(): void
{
	const outDir = join(aiDir, "petra_fixed");
	rmSync(outDir, { "recursive": true, "force": true });
	cpSync(join(aiDir, "petra"), outDir, { "recursive": true });
	// The patch is against petra/: strip a/binaries/data/mods/public/simulation/ai/petra/.
	run("git", ["apply", "-p8", "--directory=binaries/data/mods/public/simulation/ai/petra_fixed",
		"build/petra_ts/upstream/petra-fixes.patch"]);
	let rewritten = 0;
	for (const file of readdirSync(outDir).filter((name) => name.endsWith(".js")))
	{
		const path = join(outDir, file);
		const source = readFileSync(path, "utf8");
		const code = source.replaceAll("simulation/ai/petra/", () =>
		{
			++rewritten;
			return "simulation/ai/petra_fixed/";
		});
		writeFileSync(path, code);
	}
	const metadata = JSON.parse(readFileSync(join(outDir, "data.json"), "utf8"));
	writeFileSync(join(outDir, "data.json"), JSON.stringify({
		...metadata,
		"name": "Petra fixed",
		"description": "Petra, the default 0 A.D. AI bot, with the fixes of build/petra_ts/upstream/petra-fixes.patch: " +
			"the baseline Petra TS is measured against.\n\n" +
			"The AI has six levels of difficulty: Sandbox, Very Easy, Easy, Medium, Hard, and Very Hard."
	}, null, "\t") + "\n");
	console.log(`baselines: petra_fixed built from petra/ and petra-fixes.patch (${rewritten} imports rewritten)`);
}

/** The source of `export function name` in a compiled module, to its closing brace. */
function exportedFunction(source: string, name: string): string
{
	const start = source.indexOf(`export function ${name}(`);
	const end = source.indexOf("\n}\n", start);
	if (start == -1 || end == -1)
		fail(`no export function ${name} in the port`);
	return source.slice(start, end + 3);
}

function buildHybrid(id: string, modules: string[]): void
{
	if (!/^petra_hybrid\w*$/.test(id))
		fail(`a hybrid's id starts with petra_hybrid, not ${id}`);
	const parity = join(aiDir, "petra_parity");
	const fixed = join(aiDir, "petra_fixed");
	for (const dir of [parity, fixed])
		if (!readdirSync(aiDir).includes(dir.slice(aiDir.length + 1)))
			fail(`${dir} is not built: run npm run build:petra:baselines first`);
	const outDir = join(aiDir, id);
	rmSync(outDir, { "recursive": true, "force": true });
	cpSync(fixed, outDir, { "recursive": true });
	for (const module of modules)
	{
		const file = module.endsWith(".js") ? module : `${module}.js`;
		if (!readdirSync(parity).includes(file))
			fail(`no module ${file} in petra_parity`);
		cpSync(join(parity, file), join(outDir, file));
	}
	const helpers: [string, string[]][] = [["entityExtend.js", ["requireValue", "requireTemplate", "requireMetadata"]],
		["queueplan.js", ["samePlanType"]]];
	for (const [file, names] of helpers)
	{
		const path = join(outDir, file);
		const source = readFileSync(path, "utf8");
		const port = readFileSync(join(parity, file), "utf8");
		const missing = names.filter(name => !source.includes(`export function ${name}(`));
		if (missing.length)
			writeFileSync(path, source + "\n" + missing.map(name => exportedFunction(port, name)).join("\n"));
	}
	for (const file of readdirSync(outDir).filter((name) => name.endsWith(".js")))
	{
		const path = join(outDir, file);
		writeFileSync(path, readFileSync(path, "utf8").replace(/simulation\/ai\/petra_(parity|fixed)\//g, `simulation/ai/${id}/`));
	}
	const metadata = JSON.parse(readFileSync(join(outDir, "data.json"), "utf8"));
	writeFileSync(join(outDir, "data.json"), JSON.stringify({
		...metadata,
		"name": `Petra hybrid ${id.slice("petra_hybrid".length).replace(/^_/, "")}`.trim(),
		"description": `petra_fixed with these modules from petra_parity: ${modules.join(", ") || "none"}.`
	}, null, "\t") + "\n");
}

const wanted = process.argv.slice(2);
if (wanted[0] == "hybrid")
{
	if (!wanted[1])
		fail("hybrid takes an id and module names");
	buildHybrid(wanted[1], wanted.slice(2));
	process.exit(0);
}
for (const name of wanted)
	if (name != "parity" && name != "prev" && name != "fixed")
		fail(`unknown baseline ${name}: parity, prev or fixed`);
if (!wanted.length || wanted.includes("parity"))
	buildFromTag(PARITY_TAG, "petra_parity");
if (wanted.includes("prev"))
	buildFromTag(PREV_TAG, "petra_prev");
if (!wanted.length || wanted.includes("fixed"))
	buildFixed();
