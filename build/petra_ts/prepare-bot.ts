/**
 * Turns tsc's output for the Petra port into an AI bot the game loads, as the
 * "Petra TS" entry of the game setup (bot id: the folder name, petra_out).
 *
 *   node build/petra_ts/prepare-bot.ts clean   remove the previous output
 *   node build/petra_ts/prepare-bot.ts         finish the output tsc wrote
 *
 * `npm run build:petra:out` runs: clean, tsc, then this script.
 *
 * Finishing means:
 * - import specifiers: the engine's module loader takes a specifier as a VFS
 *   path as it stands (ModuleLoader.cpp), it does not resolve "./x.js" against
 *   the importing file. Relative specifiers become "simulation/ai/petra_out/x.js",
 *   the form the original petra/*.js uses.
 * - data.json: the engine reads the bot's name, constructor and entry file from
 *   it, and only lists folders of simulation/ai/ that have one.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOT_ID = "petra_out";
const VFS_DIR = `simulation/ai/${BOT_ID}`;
const ENTRY = "_petrabot.js";
const CONSTRUCTOR = "PetraBot";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(repoRoot, "binaries/data/mods/public", VFS_DIR);

const metadata = {
	"name": "Petra TS",
	"description": "TypeScript port of Petra, the default 0 A.D. AI bot, built from simulation/ai/petra_ts. " +
		"It is meant to play as the original does; pit it against Petra to compare them.\n\n" +
		"The AI has six levels of difficulty: Sandbox, Very Easy, Easy, Medium, Hard, and Very Hard.",
	"constructor": CONSTRUCTOR,
	"filename": ENTRY,
	"useShared": true
};

/** static `from "./x"`, side-effect `import "./x"` and dynamic `import("./x")` */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])\.\/([^"']+)\2/g;
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

if (!existsSync(join(outDir, ENTRY)))
	fail(`${VFS_DIR}/${ENTRY} is missing: run tsc -p build/petra_ts/tsconfig.build.json first`);

let rewritten = 0;
for (const file of readdirSync(outDir).filter((name) => name.endsWith(".js")))
{
	const path = join(outDir, file);
	const source = readFileSync(path, "utf8");
	const code = source.replace(RELATIVE_SPECIFIER, (_match, keyword: string, quote: string, target: string) =>
	{
		++rewritten;
		return `${keyword}${quote}${VFS_DIR}/${target}${quote}`;
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
