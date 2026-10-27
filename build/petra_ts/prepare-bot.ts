/**
 * Turns tsc's output for the Petra port into an AI bot the game loads, as the
 * "Petra TS" entry of the game setup (bot id: the folder name, petra_out).
 *
 *   node build/petra_ts/prepare-bot.ts clean   remove the previous output
 *   node build/petra_ts/prepare-bot.ts         finish the output tsc wrote
 *   node build/petra_ts/prepare-bot.ts state   then make the bot dump its state
 *                                              (bot-state.js; match.sh -b)
 *
 * `npm run build:petra:out` runs: clean, tsc, then this script.
 * `--bot=petra_parity` (after the mode, if any) finishes the frozen port that
 * baselines.ts compiled from the tag petra-ts-parity instead (PLAN.md §2);
 * `--bot=petra_prev` the port at the tag petra-ts-prev, the previous version.
 *
 * Finishing means:
 * - import specifiers: the engine's module loader takes a specifier as a VFS
 *   path as it stands (ModuleLoader.cpp), it does not resolve "./x.js" against
 *   the importing file. Relative specifiers, resolved against the importing
 *   file's folder (the port has adapter/, world/, decision/, execution/), become
 *   "simulation/ai/petra_out/<folder>/x.js",
 *   the form the original petra/*.js uses.
 * - data.json: the engine reads the bot's name, constructor and entry file from
 *   it, and only lists folders of simulation/ai/ that have one.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = "The AI has six levels of difficulty: Sandbox, Very Easy, Easy, Medium, Hard, and Very Hard.";
const BOTS: Record<string, { name: string; description: string }> = {
	"petra_out": {
		"name": "Petra TS",
		"description": "TypeScript port of Petra, the default 0 A.D. AI bot, built from simulation/ai/petra_ts. " +
			"It is meant to play as the original does; pit it against Petra to compare them.\n\n" + LEVELS
	},
	"petra_parity": {
		"name": "Petra TS parity",
		"description": "The TypeScript port of Petra as it was frozen at the tag petra-ts-parity, " +
			"one file per original file: the baseline Petra TS is measured against.\n\n" + LEVELS
	},
	"petra_prev": {
		"name": "Petra TS previous",
		"description": "Petra TS as it was at the tag petra-ts-prev: the version a change to Petra TS " +
			"must not lose to.\n\n" + LEVELS
	}
};

const botArgument = process.argv.find((arg) => arg.startsWith("--bot="));
const BOT_ID = botArgument?.slice("--bot=".length) ?? "petra_out";
const bot = BOTS[BOT_ID];
if (!bot)
	fail(`--bot takes ${Object.keys(BOTS).join(" or ")}, not ${BOT_ID}`);
const VFS_DIR = `simulation/ai/${BOT_ID}`;
const ENTRY = "_petrabot.js";
const CONSTRUCTOR = "PetraBot";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(repoRoot, "binaries/data/mods/public", VFS_DIR);

const metadata = {
	...bot,
	"constructor": CONSTRUCTOR,
	"filename": ENTRY,
	"useShared": true
};

/** static `from "./x"`, side-effect `import "./x"` and dynamic `import("./x")` */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"']+)\2/g;
const LEFTOVER_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"']*|[^"']*\.ts)\2/;

function fail(message: string): never
{
	console.error(`prepare-bot: ${message}`);
	process.exit(1);
}

if (process.argv[2] === "clean")
{
	rmSync(outDir, { "recursive": true, "force": true });
	process.exit(0);
}

if (process.argv[2] === "state")
{
	if (BOT_ID != "petra_out")
		fail("only petra_out dumps its state (bot-state.js imports it)");
	// The entry stays the port's: the wrapper extends its PetraBot.
	if (!existsSync(join(outDir, "data.json")))
		fail(`${VFS_DIR} is not built: run npm run build:petra:out first`);
	copyFileSync(join(repoRoot, "build/petra_ts/bot-state.js"), join(outDir, "_botstate.js"));
	writeFileSync(join(outDir, "data.json"), JSON.stringify({
		...metadata,
		"constructor": "PetraBotState",
		"filename": "_botstate.js"
	}, null, "\t") + "\n");
	console.log(`prepare-bot: "${metadata.name}" in ${VFS_DIR} dumps its state (PetraBotState)`);
	process.exit(0);
}

if (!existsSync(join(outDir, ENTRY)))
	fail(`${VFS_DIR}/${ENTRY} is missing: run tsc -p build/petra_ts/tsconfig.build.json first`);

let rewritten = 0;
const files = (readdirSync(outDir, { "recursive": true }) as string[]).filter((name) => name.endsWith(".js"))
	.map((name) => name.split("\\").join("/"));
for (const file of files)
{
	const path = join(outDir, file);
	const source = readFileSync(path, "utf8");
	const code = source.replace(RELATIVE_SPECIFIER, (_match, keyword: string, quote: string, target: string) =>
	{
		++rewritten;
		const resolved = posix.normalize(posix.join(posix.dirname(file), target));
		if (resolved.startsWith(".."))
			fail(`${file}: the import ${target} leaves ${VFS_DIR}`);
		return `${keyword}${quote}${VFS_DIR}/${resolved}${quote}`;
	});
	const leftover = code.match(LEFTOVER_SPECIFIER);
	if (leftover)
		fail(`${file}: the engine cannot load the import ${leftover[2]}${leftover[3]}${leftover[2]}`);
	if (code !== source)
		writeFileSync(path, code);
}

if (!new RegExp(`\\bexport\\s+class\\s+${CONSTRUCTOR}\\b`).test(readFileSync(join(outDir, ENTRY), "utf8")))
	fail(`${ENTRY} does not export the class ${CONSTRUCTOR} the engine constructs`);

writeFileSync(join(outDir, "data.json"), JSON.stringify(metadata, null, "\t") + "\n");
console.log(`prepare-bot: "${metadata.name}" ready in ${VFS_DIR} (${rewritten} imports rewritten)`);
