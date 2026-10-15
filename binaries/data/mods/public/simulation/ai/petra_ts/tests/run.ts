/**
 * Runs the Petra unit tests against one implementation.
 *
 *   node tests/run.ts          # the TypeScript sources
 *   node tests/run.ts out      # the JS transpiled from them (what the game loads)
 *   node tests/run.ts ref      # the hand-written JS the port came from
 *
 * `ref` only exists while the port is being verified against it; see
 * build/petra_check/NOTES.md.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = ["src", "out", "ref"];
const target = process.argv[2] ?? "src";

if (!targets.includes(target) || process.argv[3] !== undefined)
{
	console.error(`usage: run.ts [${targets.join("|")}]`);
	process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// node --test takes files or globs, not a directory to search, and wants the
// pattern with forward slashes even on Windows.
const pattern = `${here.split(path.sep).join("/")}/**/*.test.ts`;
const result = spawnSync(
	process.execPath,
	["--test", pattern],
	{ stdio: "inherit", env: { ...process.env, "PETRA_TARGET": target } }
);

if (result.error)
	throw result.error;

process.exit(result.status ?? 1);
